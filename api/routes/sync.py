"""
sync.py — Server-side sync receiver
Accepts push payloads from desktop SentinelNMS clients via SyncAgent.
Endpoint: POST /api/v1/sync/{entity_type}
"""
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime
import logging

from core.database import (
    get_db, Device, TrapEvent, Alert, DeviceMetric,
    DeviceStatus, DeviceType, AlertSeverity, AlertStatus, SnmpVersion, SyncStatus
)
from core.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Schema ────────────────────────────────────────────────────────────────────

class SyncPayload(BaseModel):
    operation: str                   # create | update | delete
    entity_type: str
    entity_id: int
    data: dict
    site_id: Optional[str] = None   # identifies the desktop client/site
    timestamp: Optional[str] = None


def _verify_api_key(x_api_key: Optional[str] = Header(None)):
    """
    Optional API-key guard. Set SYNC_API_KEY on the server .env to enforce it.
    Desktop clients send their own sync_api_key in the X-API-Key header.
    """
    if settings.sync_api_key and x_api_key != settings.sync_api_key:
        raise HTTPException(403, "Invalid or missing X-API-Key header")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_dt(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except Exception:
        return None


# ── Device sync ───────────────────────────────────────────────────────────────

@router.post("/devices", dependencies=[Depends(_verify_api_key)])
async def sync_device(payload: SyncPayload, db: AsyncSession = Depends(get_db)):
    d = payload.data
    site_prefix = f"[{payload.site_id}] " if payload.site_id else ""

    if payload.operation == "delete":
        result = await db.execute(select(Device).where(Device.ip_address == d.get("ip_address")))
        device = result.scalar_one_or_none()
        if device:
            device.is_active = False
            await db.commit()
        return {"status": "ok", "action": "deactivated"}

    # Upsert by IP address (primary key from desktop may differ)
    result = await db.execute(select(Device).where(Device.ip_address == d.get("ip_address")))
    device = result.scalar_one_or_none()

    dtype_str = d.get("device_type", "unknown")
    try:
        dtype = DeviceType(dtype_str)
    except ValueError:
        dtype = DeviceType.unknown

    status_str = d.get("status", "unknown")
    try:
        status = DeviceStatus(status_str)
    except ValueError:
        status = DeviceStatus.unknown

    if device is None:
        device = Device(
            name=f"{site_prefix}{d.get('name', d.get('ip_address', 'Unknown'))}",
            ip_address=d.get("ip_address", "0.0.0.0"),
            device_type=dtype,
            status=status,
            snmp_community=d.get("snmp_community", "public"),
            snmp_port=d.get("snmp_port", 161),
            sys_descr=d.get("sys_descr"),
            sys_name=d.get("sys_name"),
            sys_location=d.get("sys_location"),
            sys_contact=d.get("sys_contact"),
            vendor=d.get("vendor"),
            model=d.get("model"),
            notes=d.get("notes"),
            auto_discovered=d.get("auto_discovered", False),
            poll_interval=d.get("poll_interval", 300),
            is_active=True,
            sync_status=SyncStatus.synced,
            synced_at=datetime.utcnow(),
        )
        db.add(device)
        action = "created"
    else:
        device.name = f"{site_prefix}{d.get('name', device.name)}"
        device.device_type = dtype
        device.status = status
        device.snmp_community = d.get("snmp_community", device.snmp_community)
        device.sys_descr = d.get("sys_descr") or device.sys_descr
        device.sys_name = d.get("sys_name") or device.sys_name
        device.sys_location = d.get("sys_location") or device.sys_location
        device.vendor = d.get("vendor") or device.vendor
        device.model = d.get("model") or device.model
        device.sync_status = SyncStatus.synced
        device.synced_at = datetime.utcnow()
        device.is_active = True
        action = "updated"

    await db.commit()
    logger.info(f"Sync device {action}: {device.ip_address} from site={payload.site_id}")
    return {"status": "ok", "action": action}


# ── Trap sync ─────────────────────────────────────────────────────────────────

@router.post("/traps", dependencies=[Depends(_verify_api_key)])
async def sync_trap(payload: SyncPayload, db: AsyncSession = Depends(get_db)):
    d = payload.data

    sev_str = d.get("severity", "info")
    try:
        severity = AlertSeverity(sev_str)
    except ValueError:
        severity = AlertSeverity.info

    trap = TrapEvent(
        source_ip=d.get("source_ip", "0.0.0.0"),
        snmp_version=d.get("snmp_version", "v2c"),
        community=d.get("community"),
        trap_oid=d.get("trap_oid", ""),
        trap_name=d.get("trap_name"),
        trap_description=d.get("trap_description"),
        plain_english=d.get("plain_english"),
        severity=severity,
        raw_data=d.get("raw_data"),
        rule_matched=d.get("rule_matched"),
        action_taken=d.get("action_taken"),
        timestamp=_parse_dt(d.get("timestamp")) or datetime.utcnow(),
        sync_status=SyncStatus.synced,
    )
    db.add(trap)
    await db.commit()
    logger.info(f"Sync trap: {trap.trap_name} from {trap.source_ip} (site={payload.site_id})")
    return {"status": "ok", "action": "created"}


# ── Alert sync ────────────────────────────────────────────────────────────────

@router.post("/alerts", dependencies=[Depends(_verify_api_key)])
async def sync_alert(payload: SyncPayload, db: AsyncSession = Depends(get_db)):
    d = payload.data

    sev_str = d.get("severity", "info")
    try:
        severity = AlertSeverity(sev_str)
    except ValueError:
        severity = AlertSeverity.info

    status_str = d.get("status", "new")
    try:
        alert_status = AlertStatus(status_str)
    except ValueError:
        alert_status = AlertStatus.new

    alert = Alert(
        title=d.get("title", "Synced alert"),
        message=d.get("message", ""),
        severity=severity,
        status=alert_status,
        source=d.get("source", "sync"),
        metric_name=d.get("metric_name"),
        metric_value=d.get("metric_value"),
        threshold=d.get("threshold"),
        acknowledged_by=d.get("acknowledged_by"),
        acknowledged_at=_parse_dt(d.get("acknowledged_at")),
        resolved_at=_parse_dt(d.get("resolved_at")),
        notes=d.get("notes"),
        timestamp=_parse_dt(d.get("timestamp")) or datetime.utcnow(),
        sync_status=SyncStatus.synced,
    )
    db.add(alert)
    await db.commit()
    logger.info(f"Sync alert: {alert.title} (site={payload.site_id})")
    return {"status": "ok", "action": "created"}


# ── Metric sync ───────────────────────────────────────────────────────────────

@router.post("/metrics", dependencies=[Depends(_verify_api_key)])
async def sync_metric(payload: SyncPayload, db: AsyncSession = Depends(get_db)):
    d = payload.data

    # Find the matching device by IP if available
    device_id = None
    if d.get("ip_address"):
        result = await db.execute(
            select(Device).where(Device.ip_address == d["ip_address"])
        )
        dev = result.scalar_one_or_none()
        if dev:
            device_id = dev.id

    metric = DeviceMetric(
        device_id=device_id,
        timestamp=_parse_dt(d.get("timestamp")) or datetime.utcnow(),
        cpu_percent=d.get("cpu_percent"),
        memory_percent=d.get("memory_percent"),
        disk_percent=d.get("disk_percent"),
        interface_name=d.get("interface_name"),
        bytes_in=d.get("bytes_in"),
        bytes_out=d.get("bytes_out"),
        bandwidth_in_mbps=d.get("bandwidth_in_mbps"),
        bandwidth_out_mbps=d.get("bandwidth_out_mbps"),
        signal_dbm=d.get("signal_dbm"),
        noise_dbm=d.get("noise_dbm"),
        signal_quality=d.get("signal_quality"),
        ccq_percent=d.get("ccq_percent"),
        toner_percent=d.get("toner_percent"),
        custom_metrics=d.get("custom_metrics"),
    )
    db.add(metric)
    await db.commit()
    return {"status": "ok", "action": "created"}
