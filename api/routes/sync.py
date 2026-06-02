"""
sync.py — Server-side sync gateway
Accepts push payloads from any SentinelNMS desktop agent.

API key model:
  • Set SYNC_API_KEY in server .env → only that key is accepted (shared gateway key)
  • Leave SYNC_API_KEY empty         → any non-empty key is accepted (open gateway)

Each desktop agent identifies itself via site_name in the payload body.
Multiple agents can share the same gateway key while having unique site names.
"""
from fastapi import APIRouter, Depends, HTTPException, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import logging

from core.database import (
    get_db, Device, TrapEvent, Alert, DeviceMetric, SyncSite, SyncLog, SyncQueue,
    DeviceStatus, DeviceType, AlertSeverity, AlertStatus, SnmpVersion, SyncStatus
)
from core.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Schema ────────────────────────────────────────────────────────────────────

class SyncPayload(BaseModel):
    operation: str                    # create | update | delete
    entity_type: str
    entity_id: int
    data: dict
    site_id: Optional[str] = None    # backward compat — legacy field (= api key)
    site_name: Optional[str] = None  # human-readable agent name (e.g. "Office-HQ")
    app_version: Optional[str] = None
    timestamp: Optional[str] = None


# ── Auth ──────────────────────────────────────────────────────────────────────

def _verify_api_key(x_api_key: Optional[str] = Header(None)):
    """
    Gateway key check.
    • If SYNC_API_KEY is set on server: header must match exactly.
    • If SYNC_API_KEY is NOT set: all requests accepted (open gateway).
      Use this on private/trusted networks; set a key in production.
    """
    if settings.sync_api_key:
        if not x_api_key or x_api_key != settings.sync_api_key:
            raise HTTPException(403, "Invalid or missing X-API-Key")


# ── Site registry helper ───────────────────────────────────────────────────────

async def _upsert_site(
    site_name: str,
    api_key: Optional[str],
    app_version: Optional[str],
    db: AsyncSession,
) -> SyncSite:
    """Create or update a SyncSite record on every sync call."""
    result = await db.execute(select(SyncSite).where(SyncSite.site_name == site_name))
    site = result.scalar_one_or_none()
    now = datetime.utcnow()

    if site is None:
        site = SyncSite(
            site_name=site_name,
            api_key_hint=(api_key or "")[:12] if api_key else None,
            software_version=app_version,
            last_seen=now,
            last_sync=now,
            device_count=0,
        )
        db.add(site)
        logger.info(f"New desktop agent registered: {site_name}")
    else:
        site.last_seen = now
        site.last_sync = now
        if app_version:
            site.software_version = app_version

    # Update device count for this site
    count_result = await db.execute(
        select(func.count(Device.id)).where(
            Device.site_name == site_name, Device.is_active == True
        )
    )
    site.device_count = count_result.scalar() or 0
    return site


# ── Helpers ───────────────────────────────────────────────────────────────────

def _effective_site_name(payload: SyncPayload) -> str:
    """Prefer explicit site_name; fall back to site_id; then 'Unknown'."""
    return (payload.site_name or payload.site_id or "Unknown").strip()

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
    site = _effective_site_name(payload)

    await _upsert_site(site, payload.site_id, payload.app_version, db)

    if payload.operation == "delete":
        result = await db.execute(select(Device).where(Device.ip_address == d.get("ip_address")))
        device = result.scalar_one_or_none()
        if device and device.site_name == site:
            device.is_active = False
            await db.commit()
        return {"status": "ok", "action": "deactivated"}

    # Upsert by IP + site_name (each site owns its own IP space)
    result = await db.execute(
        select(Device).where(
            Device.ip_address == d.get("ip_address"),
            Device.site_name == site,
        )
    )
    device = result.scalar_one_or_none()

    try:    dtype = DeviceType(d.get("device_type", "unknown"))
    except: dtype = DeviceType.unknown
    try:    status = DeviceStatus(d.get("status", "unknown"))
    except: status = DeviceStatus.unknown

    now = datetime.utcnow()

    if device is None:
        device = Device(
            name=d.get("name") or d.get("ip_address", "Unknown"),
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
            # poll_interval set to 0 — this device is NEVER polled by the server.
            # All data flows exclusively through the sync channel from site_name.
            poll_interval=0,
            last_seen=_parse_dt(d.get("last_seen")) or (now if status == DeviceStatus.online else None),
            uptime_seconds=d.get("uptime_seconds"),
            is_active=True,
            sync_status=SyncStatus.synced,
            synced_at=now,
            source="desktop_sync",
            site_name=site,
        )
        db.add(device)
        action = "created"
    else:
        device.name           = d.get("name") or device.name
        device.device_type    = dtype
        device.status         = status
        device.snmp_community = d.get("snmp_community") or device.snmp_community
        device.sys_descr      = d.get("sys_descr")    or device.sys_descr
        device.sys_name       = d.get("sys_name")      or device.sys_name
        device.sys_location   = d.get("sys_location")  or device.sys_location
        device.vendor         = d.get("vendor")        or device.vendor
        device.model          = d.get("model")         or device.model
        # Update live status from the desktop — this is the authoritative source
        device.last_seen      = _parse_dt(d.get("last_seen")) or (now if status == DeviceStatus.online else device.last_seen)
        device.uptime_seconds = d.get("uptime_seconds") or device.uptime_seconds
        device.last_polled    = now   # "polled" = "last data received from desktop"
        device.consecutive_failures = 0 if status == DeviceStatus.online else device.consecutive_failures
        device.sync_status    = SyncStatus.synced
        device.synced_at      = now
        device.source         = "desktop_sync"
        device.site_name      = site
        device.is_active      = True
        device.poll_interval  = 0     # ensure server never starts polling this device
        action = "updated"

    await db.commit()
    logger.info(f"Sync device {action}: {device.ip_address} ← site='{site}'")
    return {"status": "ok", "action": action, "site": site}


# ── Trap sync ─────────────────────────────────────────────────────────────────

@router.post("/traps", dependencies=[Depends(_verify_api_key)])
async def sync_trap(payload: SyncPayload, db: AsyncSession = Depends(get_db)):
    d = payload.data
    site = _effective_site_name(payload)
    await _upsert_site(site, payload.site_id, payload.app_version, db)

    try:    severity = AlertSeverity(d.get("severity", "info"))
    except: severity = AlertSeverity.info

    trap = TrapEvent(
        source_ip=d.get("source_ip", "0.0.0.0"),
        snmp_version=d.get("snmp_version", "v2c"),
        community=d.get("community"),
        trap_oid=d.get("trap_oid", ""),
        trap_name=d.get("trap_name"),
        trap_description=d.get("trap_description"),
        plain_english=d.get("plain_english"),
        severity=severity,
        raw_data={**(d.get("raw_data") or {}), "site_name": site},
        rule_matched=d.get("rule_matched"),
        action_taken=d.get("action_taken"),
        timestamp=_parse_dt(d.get("timestamp")) or datetime.utcnow(),
        sync_status=SyncStatus.synced,
    )
    db.add(trap)
    await db.commit()
    return {"status": "ok", "action": "created"}


# ── Alert sync ────────────────────────────────────────────────────────────────

@router.post("/alerts", dependencies=[Depends(_verify_api_key)])
async def sync_alert(payload: SyncPayload, db: AsyncSession = Depends(get_db)):
    d = payload.data
    site = _effective_site_name(payload)
    await _upsert_site(site, payload.site_id, payload.app_version, db)

    try:    severity = AlertSeverity(d.get("severity", "info"))
    except: severity = AlertSeverity.info
    try:    alert_status = AlertStatus(d.get("status", "new"))
    except: alert_status = AlertStatus.new

    alert = Alert(
        title=d.get("title", "Synced alert"),
        message=d.get("message", ""),
        severity=severity,
        status=alert_status,
        source=f"sync:{site}",
        metric_name=d.get("metric_name"),
        metric_value=d.get("metric_value"),
        threshold=d.get("threshold"),
        notes=d.get("notes"),
        timestamp=_parse_dt(d.get("timestamp")) or datetime.utcnow(),
        sync_status=SyncStatus.synced,
    )
    db.add(alert)
    await db.commit()
    return {"status": "ok", "action": "created"}


# ── Metric sync ───────────────────────────────────────────────────────────────

@router.post("/metrics", dependencies=[Depends(_verify_api_key)])
async def sync_metric(payload: SyncPayload, db: AsyncSession = Depends(get_db)):
    d = payload.data
    site = _effective_site_name(payload)
    await _upsert_site(site, payload.site_id, payload.app_version, db)

    # Find matching device (same IP + site)
    device_id = None
    if d.get("ip_address"):
        result = await db.execute(
            select(Device).where(
                Device.ip_address == d["ip_address"],
                Device.site_name == site,
            )
        )
        dev = result.scalar_one_or_none()
        if dev:
            device_id = dev.id

    # Skip the metric if the device hasn't been synced yet.
    # device_metrics.device_id is NOT NULL, so we must have a valid ID.
    # The device will arrive shortly in the next sync cycle.
    if device_id is None:
        return {"status": "skipped", "reason": "device not yet registered — metric will retry"}

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

    # Update the device's last_polled timestamp so the UI shows "active" state
    if device_id:
        result2 = await db.execute(select(Device).where(Device.id == device_id))
        dev = result2.scalar_one_or_none()
        if dev:
            dev.last_polled = _parse_dt(d.get("timestamp")) or datetime.utcnow()
            dev.synced_at   = datetime.utcnow()

    await db.commit()
    return {"status": "ok", "action": "created"}


# ── Sites registry ────────────────────────────────────────────────────────────

@router.get("/sites")
async def list_sync_sites(db: AsyncSession = Depends(get_db)):
    """Return all desktop agents that have ever synced to this server."""
    result = await db.execute(
        select(SyncSite).order_by(SyncSite.last_sync.desc())
    )
    sites = result.scalars().all()
    now = datetime.utcnow()
    return [
        {
            "site_name":        s.site_name,
            "device_count":     s.device_count,
            "last_sync":        s.last_sync.isoformat() if s.last_sync else None,
            "last_seen":        s.last_seen.isoformat() if s.last_seen else None,
            "software_version": s.software_version,
            # online = synced within last 10 min; recent = within 1 hour; offline = older
            "status": (
                "online"  if s.last_seen and (now - s.last_seen).total_seconds() < 600
                else "recent"  if s.last_seen and (now - s.last_seen).total_seconds() < 3600
                else "offline"
            ),
            "last_seen_ago_secs": int((now - s.last_seen).total_seconds()) if s.last_seen else None,
        }
        for s in sites
    ]


# ── Heartbeat ─────────────────────────────────────────────────────────────────

@router.get("/log")
async def get_sync_log(limit: int = 50, db: AsyncSession = Depends(get_db)):
    """Return the last N sync cycle log entries (desktop mode only)."""
    result = await db.execute(
        select(SyncLog)
        .order_by(SyncLog.timestamp.desc())
        .limit(limit)
    )
    logs = result.scalars().all()
    return [
        {
            "id":            l.id,
            "timestamp":     l.timestamp.isoformat(),
            "status":        l.status,
            "items_pushed":  l.items_pushed,
            "items_failed":  l.items_failed,
            "items_pending": l.items_pending,
            "duration_ms":   l.duration_ms,
            "error":         l.error,
            "server_url":    l.server_url,
        }
        for l in logs
    ]


@router.get("/queue/failed")
async def get_failed_queue(db: AsyncSession = Depends(get_db)):
    """Return items in the sync queue that have permanently failed (attempts >= 5)."""
    result = await db.execute(
        select(SyncQueue)
        .where(SyncQueue.status == SyncStatus.failed)
        .order_by(SyncQueue.created_at.desc())
        .limit(50)
    )
    items = result.scalars().all()
    return [
        {
            "id":          i.id,
            "entity_type": i.entity_type,
            "entity_id":   i.entity_id,
            "operation":   i.operation,
            "attempts":    i.attempts,
            "error":       i.error,
            "created_at":  i.created_at.isoformat() if i.created_at else None,
        }
        for i in items
    ]


@router.post("/queue/retry")
async def retry_failed_queue(db: AsyncSession = Depends(get_db)):
    """Reset all failed queue items back to pending so they're retried on next cycle."""
    result = await db.execute(
        select(SyncQueue).where(SyncQueue.status == SyncStatus.failed)
    )
    items = result.scalars().all()
    count = 0
    for item in items:
        item.status = SyncStatus.pending
        item.attempts = 0
        item.error = None
        count += 1
    await db.commit()

    # Trigger an immediate sync cycle
    from core.sync_agent import sync_agent
    if sync_agent.enabled and sync_agent._is_connected:
        import asyncio
        asyncio.create_task(sync_agent._sync_cycle())

    return {"reset": count, "message": f"Reset {count} failed items — sync will retry shortly"}


@router.post("/heartbeat", dependencies=[Depends(_verify_api_key)])
async def heartbeat(
    x_api_key: Optional[str] = Header(None),
    site_name: Optional[str] = None,
    app_version: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Lightweight keepalive — desktop app can call this every minute."""
    name = site_name or x_api_key or "Unknown"
    await _upsert_site(name, x_api_key, app_version, db)
    await db.commit()
    return {"status": "ok", "site": name, "server_time": datetime.utcnow().isoformat()}
