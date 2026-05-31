"""
Alert Engine — Evaluates metrics, fires alerts, sends notifications
"""
import asyncio
import logging
import smtplib
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Dict, Any, Optional
import httpx

from core.config import settings

logger = logging.getLogger(__name__)

# Connected WebSocket clients (for real-time push)
_ws_clients = set()

def register_ws(ws):
    _ws_clients.add(ws)

def unregister_ws(ws):
    _ws_clients.discard(ws)


async def broadcast_ws(event_type: str, data: dict):
    """Broadcast a message to all connected WebSocket clients."""
    import json
    message = json.dumps({"type": event_type, "data": data, "ts": datetime.utcnow().isoformat()})
    dead = set()
    for ws in list(_ws_clients):
        try:
            await ws.send_text(message)
        except Exception:
            dead.add(ws)
    _ws_clients.difference_update(dead)


# ─── Threshold Checks ─────────────────────────────────────────────────────────

DEFAULT_THRESHOLDS = {
    "cpu_percent": {"warning": 80, "critical": 95},
    "memory_percent": {"warning": 85, "critical": 95},
    "disk_percent": {"warning": 85, "critical": 95},
    "toner_percent": {"warning": 20, "critical": 5},
    "signal_dbm": {"warning": -75, "critical": -85},   # Lower is worse for signal
    "ccq_percent": {"warning": 60, "critical": 30},
}


async def evaluate_metrics(device: Dict, metrics: Dict, db_session):
    """Check metrics against thresholds and create alerts if needed."""
    from core.database import Alert, AlertSeverity, AlertStatus

    device_id = device.get("id")
    device_name = device.get("name", device.get("ip_address", "Unknown"))

    for metric_name, thresholds in DEFAULT_THRESHOLDS.items():
        value = metrics.get(metric_name)
        if value is None:
            continue

        # For signal dBm, lower = worse (reverse logic)
        if metric_name == "signal_dbm":
            if value <= thresholds["critical"]:
                severity = AlertSeverity.critical
            elif value <= thresholds["warning"]:
                severity = AlertSeverity.warning
            else:
                continue
        else:
            if value >= thresholds["critical"]:
                severity = AlertSeverity.critical
            elif value >= thresholds["warning"]:
                severity = AlertSeverity.warning
            else:
                continue

        # Friendly messages
        messages = {
            "cpu_percent": f"{device_name}: CPU usage is high at {value:.0f}%",
            "memory_percent": f"{device_name}: Memory usage is high at {value:.0f}%",
            "disk_percent": f"{device_name}: Disk is almost full at {value:.0f}%",
            "toner_percent": f"{device_name}: Toner/ink is low at {value:.0f}%",
            "signal_dbm": f"{device_name}: Weak RF signal at {value:.1f} dBm",
            "ccq_percent": f"{device_name}: Poor link quality at {value:.0f}% CCQ",
        }

        titles = {
            "cpu_percent": "High CPU Usage",
            "memory_percent": "High Memory Usage",
            "disk_percent": "Low Disk Space",
            "toner_percent": "Low Toner/Ink",
            "signal_dbm": "Weak RF Signal",
            "ccq_percent": "Poor Link Quality",
        }

        alert = Alert(
            device_id=device_id,
            title=titles.get(metric_name, metric_name),
            message=messages.get(metric_name, f"{metric_name} = {value}"),
            severity=severity,
            status=AlertStatus.new,
            source="polling",
            metric_name=metric_name,
            metric_value=str(round(value, 1)),
            threshold=str(thresholds[severity.value]),
        )
        db_session.add(alert)

        # Broadcast real-time
        await broadcast_ws("new_alert", {
            "device_name": device_name,
            "title": alert.title,
            "message": alert.message,
            "severity": severity.value,
        })

        # Notify if critical
        if severity == AlertSeverity.critical:
            await send_notifications(alert.title, alert.message, severity.value)


async def handle_trap_alert(trap_data: Dict, db_session):
    """Process an incoming trap and apply matching rules."""
    from sqlalchemy import select
    from core.database import TrapEvent, TrapRule, Alert, AlertSeverity, AlertStatus
    from core.mib_parser import resolve_oid

    trap_oid = trap_data.get("trap_oid", "")
    source_ip = trap_data.get("source_ip", "")

    # Find matching rule
    result = await db_session.execute(
        select(TrapRule).where(TrapRule.is_enabled == True)
    )
    rules = result.scalars().all()
    
    matched_rule = None
    for rule in rules:
        pattern = rule.trap_oid_pattern
        if pattern == trap_oid or trap_oid.startswith(pattern):
            matched_rule = rule
            break

    # Resolve OID to friendly name
    oid_info = resolve_oid(trap_oid)
    trap_name = oid_info.get("name", trap_oid)
    
    # Find device by IP
    from sqlalchemy import select
    from core.database import Device
    dev_result = await db_session.execute(
        select(Device).where(Device.ip_address == source_ip)
    )
    device = dev_result.scalar_one_or_none()
    device_name = device.name if device else source_ip

    # Build plain English
    if matched_rule and matched_rule.plain_english_template:
        plain = matched_rule.plain_english_template.replace("{device}", device_name)
    else:
        plain = trap_data.get("plain_english") or f"Received {trap_name} from {device_name}"

    severity = matched_rule.severity if matched_rule else AlertSeverity.info

    # Apply suppression window
    if matched_rule and matched_rule.suppress_start_hour is not None:
        now_hour = datetime.utcnow().hour
        start = matched_rule.suppress_start_hour
        end = matched_rule.suppress_end_hour or 23
        if start <= now_hour < end:
            logger.info(f"Trap suppressed (maintenance window): {trap_name}")
            return

    # Save trap event
    trap_event = TrapEvent(
        device_id=device.id if device else None,
        source_ip=source_ip,
        snmp_version=trap_data.get("snmp_version", "v2c"),
        trap_oid=trap_oid,
        trap_name=trap_name,
        plain_english=plain,
        severity=severity,
        raw_data=trap_data.get("var_binds"),
        rule_matched=matched_rule.name if matched_rule else None,
    )
    db_session.add(trap_event)

    # Create alert if rule says so
    if not matched_rule or matched_rule.create_alert:
        alert = Alert(
            device_id=device.id if device else None,
            title=f"Trap: {trap_name}",
            message=plain,
            severity=severity,
            status=AlertStatus.new,
            source="trap",
        )
        db_session.add(alert)

    await db_session.commit()

    # Broadcast
    await broadcast_ws("trap_received", {
        "source_ip": source_ip,
        "device_name": device_name,
        "trap_name": trap_name,
        "plain_english": plain,
        "severity": severity.value if hasattr(severity, 'value') else severity,
    })

    # Notifications
    if matched_rule:
        if matched_rule.send_email or matched_rule.send_webhook:
            await send_notifications(f"Trap: {trap_name}", plain, 
                                     severity.value if hasattr(severity, 'value') else severity,
                                     email=matched_rule.send_email,
                                     webhook=matched_rule.send_webhook)


async def send_notifications(title: str, message: str, severity: str,
                             email: bool = True, webhook: bool = True):
    """Send email and/or webhook notifications."""
    tasks = []
    
    if email and settings.smtp_host:
        tasks.append(_send_email(title, message, severity))
    
    if webhook and settings.webhook_url:
        tasks.append(_send_webhook(title, message, severity))
    
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _send_email(title: str, message: str, severity: str):
    """Send email alert."""
    if not settings.smtp_host:
        return
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"[NMS {severity.upper()}] {title}"
        msg["From"] = settings.smtp_from
        msg["To"] = settings.smtp_user or settings.smtp_from

        html = f"""
        <html><body>
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:{'#dc2626' if severity=='critical' else '#f59e0b' if severity=='warning' else '#3b82f6'};
                      color:white;padding:16px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">⚠️ {title}</h2>
          </div>
          <div style="background:#f9fafb;padding:16px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
            <p>{message}</p>
            <p style="color:#6b7280;font-size:12px">SentinelNMS — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}</p>
          </div>
        </div>
        </body></html>
        """
        msg.attach(MIMEText(html, "html"))

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            if settings.smtp_user and settings.smtp_password:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        logger.info(f"Email alert sent: {title}")
    except Exception as e:
        logger.error(f"Email send failed: {e}")


async def _send_webhook(title: str, message: str, severity: str):
    """Send webhook notification."""
    if not settings.webhook_url:
        return
    try:
        payload = {
            "text": f"*[{severity.upper()}]* {title}\n{message}",
            "title": title,
            "message": message,
            "severity": severity,
            "timestamp": datetime.utcnow().isoformat(),
            "source": "SentinelNMS",
        }
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(settings.webhook_url, json=payload)
        logger.info(f"Webhook sent: {title}")
    except Exception as e:
        logger.error(f"Webhook failed: {e}")
