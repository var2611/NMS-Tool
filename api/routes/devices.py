from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc, delete as sa_delete
from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel
import logging

from core.database import (
    get_db, Device, DeviceMetric, DeviceStatus, DeviceType, SnmpVersion, User,
    Alert, TrapEvent, SyncQueue,
)
from core.scheduler import scheduler
from core.snmp_engine import list_device_interfaces
from core.mib_metrics import walk_device_mib_tables
from api.routes.auth import get_current_user, require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

# ─── Schemas ──────────────────────────────────────────────────────────────────

class DeviceCreate(BaseModel):
    name: str
    ip_address: str
    device_type: str = "unknown"
    snmp_community: str = "public"
    snmp_version: str = "v2c"
    snmp_port: int = 161
    poll_interval: int = 300
    notes: Optional[str] = None
    tags: Optional[dict] = None
    mib_id: Optional[int] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    associated_device_id: Optional[int] = None

class DeviceUpdate(BaseModel):
    name: Optional[str] = None
    device_type: Optional[str] = None
    snmp_community: Optional[str] = None
    snmp_version: Optional[str] = None
    snmp_port: Optional[int] = None
    poll_interval: Optional[int] = None
    notes: Optional[str] = None
    tags: Optional[dict] = None
    is_active: Optional[bool] = None
    # Optional[int] with explicit-unset detection (see update_device) — sending
    # `mib_id: null` clears the MIB association instead of being ignored.
    mib_id: Optional[int] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    # Optional[int] with explicit-unset detection (see update_device) — sending
    # `associated_device_id: null` clears the pairing instead of being ignored.
    associated_device_id: Optional[int] = None

class DeviceOut(BaseModel):
    id: int
    name: str
    ip_address: str
    mac_address: Optional[str]
    device_type: str
    status: str
    snmp_version: str
    snmp_community: str
    snmp_port: int
    sys_descr: Optional[str]
    sys_name: Optional[str]
    sys_location: Optional[str]
    vendor: Optional[str]
    model: Optional[str]
    poll_interval: int
    last_seen: Optional[datetime]
    last_polled: Optional[datetime]
    uptime_seconds: Optional[int]
    consecutive_failures: int
    notes: Optional[str]
    tags: Optional[dict]
    is_active: bool
    auto_discovered: bool
    created_at: datetime
    # Vendor MIB profile (drives MIB-aware port discovery)
    mib_id: Optional[int] = None
    # Map placement + paired device (dashboard network map)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    associated_device_id: Optional[int] = None
    # Origin
    source: Optional[str] = "manual"
    site_name: Optional[str] = None
    sync_status: Optional[str] = None
    synced_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.get("", response_model=List[DeviceOut])
async def list_devices(
    status: Optional[str] = None,
    device_type: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = select(Device).where(Device.is_active == True)

    # ── Multi-tenant filter ──────────────────────────────────────────────────
    # Admins see everything. Non-admins see only devices from their allowed
    # sites, plus locally-owned devices (source != desktop_sync) which have no
    # site restriction.
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if allowed:
            q = q.where(
                (Device.site_name.in_(allowed)) | (Device.source != "desktop_sync")
            )
        else:
            # No sites assigned → only non-synced (local) devices
            q = q.where(Device.source != "desktop_sync")

    if status:
        q = q.where(Device.status == status)
    if device_type:
        q = q.where(Device.device_type == device_type)
    if search:
        q = q.where(
            (Device.name.ilike(f"%{search}%")) |
            (Device.ip_address.ilike(f"%{search}%")) |
            (Device.sys_name.ilike(f"%{search}%"))
        )
    q = q.order_by(Device.name).limit(limit).offset(offset)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/summary")
async def device_summary(db: AsyncSession = Depends(get_db)):
    """Dashboard summary counts."""
    total = await db.execute(select(func.count(Device.id)).where(Device.is_active == True))
    online = await db.execute(select(func.count(Device.id)).where(Device.status == DeviceStatus.online, Device.is_active == True))
    offline = await db.execute(select(func.count(Device.id)).where(Device.status == DeviceStatus.offline, Device.is_active == True))
    warning = await db.execute(select(func.count(Device.id)).where(Device.status == DeviceStatus.warning, Device.is_active == True))
    
    by_type = await db.execute(
        select(Device.device_type, func.count(Device.id))
        .where(Device.is_active == True)
        .group_by(Device.device_type)
    )
    type_counts = {str(row[0].value if hasattr(row[0], 'value') else row[0]): row[1] for row in by_type}

    total_count = total.scalar()
    online_count = online.scalar()
    health_score = round((online_count / total_count * 100) if total_count > 0 else 0)

    return {
        "total": total_count,
        "online": online_count,
        "offline": offline.scalar(),
        "warning": warning.scalar(),
        "health_score": health_score,
        "by_type": type_counts,
    }


@router.get("/deleted", response_model=List[DeviceOut])
async def list_deleted_devices(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Soft-deleted devices (Remove button) — recoverable via POST /{id}/restore."""
    q = select(Device).where(Device.is_active == False)

    # Same multi-tenant visibility rules as the active list
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if allowed:
            q = q.where(
                (Device.site_name.in_(allowed)) | (Device.source != "desktop_sync")
            )
        else:
            q = q.where(Device.source != "desktop_sync")

    result = await db.execute(q.order_by(Device.name))
    return result.scalars().all()


@router.get("/{device_id}", response_model=DeviceOut)
async def get_device(device_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    return device


@router.post("", response_model=DeviceOut, status_code=201)
async def create_device(data: DeviceCreate, db: AsyncSession = Depends(get_db)):
    # Check duplicate IP — a soft-deleted device still owns its IP, so point the
    # user at the recovery flow instead of a dead-end "already exists".
    existing = await db.execute(select(Device).where(Device.ip_address == data.ip_address))
    existing_device = existing.scalar_one_or_none()
    if existing_device:
        if not existing_device.is_active:
            raise HTTPException(
                400,
                f"Device with IP {data.ip_address} was removed earlier — "
                f"restore it from \"Removed devices\" instead of re-adding"
            )
        raise HTTPException(400, f"Device with IP {data.ip_address} already exists")

    if data.associated_device_id is not None:
        assoc = await db.execute(select(Device).where(Device.id == data.associated_device_id))
        if not assoc.scalar_one_or_none():
            raise HTTPException(400, "Associated device not found")

    device = Device(**data.model_dump(), source="manual")
    db.add(device)
    await db.commit()
    await db.refresh(device)

    # Queue for cloud sync
    from core.sync_agent import sync_agent
    await sync_agent.queue_entity("device", device.id, "create", {
        "name":           device.name,
        "ip_address":     device.ip_address,
        "device_type":    device.device_type.value if device.device_type else "unknown",
        "status":         "unknown",
        "snmp_community": device.snmp_community,
        "snmp_port":      device.snmp_port,
        "poll_interval":  device.poll_interval,
        "notes":          device.notes,
    })

    return device


@router.put("/{device_id}", response_model=DeviceOut)
async def update_device(device_id: int, data: DeviceUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")

    # mib_id is nullable — "clear MIB profile" must send `mib_id: null` and have
    # it actually applied, so it needs explicit-unset handling outside the
    # exclude_none loop below (which would otherwise silently drop it).
    mib_id_sent = "mib_id" in data.model_fields_set
    mib_id_value = data.mib_id

    # Same explicit-unset handling for associated_device_id (clearing a pairing).
    assoc_sent = "associated_device_id" in data.model_fields_set
    assoc_value = data.associated_device_id
    if assoc_sent and assoc_value is not None:
        if assoc_value == device_id:
            raise HTTPException(400, "A device cannot be associated with itself")
        assoc = await db.execute(select(Device).where(Device.id == assoc_value))
        if not assoc.scalar_one_or_none():
            raise HTTPException(400, "Associated device not found")

    for field, value in data.model_dump(exclude_none=True).items():
        if field in ("mib_id", "associated_device_id"):
            continue
        setattr(device, field, value)
    if mib_id_sent:
        device.mib_id = mib_id_value
    if assoc_sent:
        device.associated_device_id = assoc_value

    device.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(device)
    return device


@router.delete("/{device_id}")
async def delete_device(device_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    ip_address = device.ip_address
    device.is_active = False
    await db.commit()

    # Propagate the removal to the cloud — without this, a device deleted on a
    # desktop agent silently reappears on the server after the next sync cycle
    # (no-op when sync is disabled, e.g. on the server itself).
    from core.sync_agent import sync_agent
    await sync_agent.queue_entity("device", device_id, "delete", {"ip_address": ip_address})

    return {"message": "Device removed"}


@router.post("/{device_id}/restore", response_model=DeviceOut)
async def restore_device(device_id: int, db: AsyncSession = Depends(get_db)):
    """Recover a soft-deleted device — undoes the Remove button."""
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    if device.is_active:
        raise HTTPException(400, "Device is not deleted")

    device.is_active = True
    device.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(device)

    # Re-announce to the cloud — the soft delete queued a "delete", so without
    # this the device would stay missing on the server until its next update.
    from core.sync_agent import sync_agent
    await sync_agent.queue_entity("device", device.id, "create", {
        "name":           device.name,
        "ip_address":     device.ip_address,
        "device_type":    device.device_type.value if device.device_type else "unknown",
        "status":         device.status.value if device.status else "unknown",
        "snmp_community": device.snmp_community,
        "snmp_port":      device.snmp_port,
        "poll_interval":  device.poll_interval,
        "notes":          device.notes,
    })

    return device


@router.delete("/{device_id}/purge")
async def purge_device(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Admin-only: permanently erase a device AND all of its history.

    Unlike the soft-delete above (which just hides the device), this removes
    the device row plus every metric, alert, trap, and pending sync-queue entry
    that references it. Irreversible — the frontend gates this behind a
    type-to-confirm dialog.
    """
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")

    ip_address = device.ip_address
    name = device.name

    await db.execute(sa_delete(DeviceMetric).where(DeviceMetric.device_id == device_id))
    await db.execute(sa_delete(Alert).where(Alert.device_id == device_id))
    await db.execute(sa_delete(TrapEvent).where(TrapEvent.device_id == device_id))
    await db.execute(sa_delete(SyncQueue).where(
        SyncQueue.entity_type.in_(["device", "metric"]),
        SyncQueue.entity_id == device_id,
    ))
    await db.delete(device)
    await db.commit()

    from core.sync_agent import sync_agent
    await sync_agent.queue_entity("device", device_id, "delete", {"ip_address": ip_address})

    logger.warning(f"Device #{device_id} ({name} / {ip_address}) permanently purged by {_admin.username}")
    return {"message": f"\"{name}\" and all of its history were permanently deleted"}


@router.post("/{device_id}/poll")
async def force_poll(device_id: int, db: AsyncSession = Depends(get_db)):
    """Immediately poll a device. Rejected for remote-agent-owned devices."""
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    if device.source == "desktop_sync":
        raise HTTPException(
            409,
            f"Device is monitored by the '{device.site_name}' agent — polling is managed there, not on the server"
        )
    scheduler.force_poll(device_id)
    return {"message": "Poll triggered"}


@router.get("/{device_id}/metrics")
async def get_metrics(
    device_id: int,
    hours: int = Query(24, le=168),
    db: AsyncSession = Depends(get_db)
):
    """Get ALL metric records in the selected window, oldest-first for charting.

    No arbitrary row limit — the chart must show every data point the device
    reported. At 1-min polling the volumes are:
        3h  → ~180 rows    6h  → ~360     24h → ~1440
        3d  → ~4320        7d  → ~10080
    All are fast for PostgreSQL/SQLite with the (device_id, timestamp) index.
    """
    from datetime import timedelta
    since = datetime.utcnow() - timedelta(hours=hours)

    result = await db.execute(
        select(DeviceMetric)
        .where(DeviceMetric.device_id == device_id, DeviceMetric.timestamp >= since)
        .order_by(DeviceMetric.timestamp)          # oldest first → chart left-to-right
    )
    metrics = result.scalars().all()
    
    return [
        {
            "timestamp": m.timestamp.isoformat(),
            "cpu_percent": m.cpu_percent,
            "memory_percent": m.memory_percent,
            "disk_percent": m.disk_percent,
            "bandwidth_in_mbps": m.bandwidth_in_mbps,
            "bandwidth_out_mbps": m.bandwidth_out_mbps,
            "signal_dbm": m.signal_dbm,
            "ccq_percent": m.ccq_percent,
            "toner_percent": m.toner_percent,
            # custom_metrics carries ping_ms and per-interface bandwidth
            "ping_ms": (m.custom_metrics or {}).get("ping_ms"),
            "interfaces": (m.custom_metrics or {}).get("interfaces", {}),
            "mib_metrics": (m.custom_metrics or {}).get("mib_metrics", {}),
        }
        for m in metrics
    ]


# ─── Interface management ─────────────────────────────────────────────────────

class MonitoredInterfacesRequest(BaseModel):
    indexes: List[int]  # interface indexes to monitor


class MibMetricSelection(BaseModel):
    table: str
    index: int
    column: str
    label: str


class MonitoredMibMetricsRequest(BaseModel):
    metrics: List[MibMetricSelection]


@router.get("/{device_id}/interfaces")
async def get_device_interfaces(device_id: int, db: AsyncSession = Depends(get_db)):
    """Fetch all interfaces from device via live SNMP + return which are monitored.

    When the device has a vendor MIB attached (`mib_id`), this also detects
    and walks any interface/port-shaped tables the MIB defines and returns
    them as `mib_tables` — merged into the same response, alongside the
    standard `interfaces`, and clearly labeled by their MIB table name so the
    UI can present "every port this device exposes" from both sources at once.
    """
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    if device.source == "desktop_sync":
        raise HTTPException(
            409,
            f"Interface monitoring is managed by the '{device.site_name}' agent, not the server"
        )

    try:
        interfaces = await list_device_interfaces(
            device.ip_address,
            device.snmp_community or "public",
            device.snmp_version.value if device.snmp_version else "v2c",
            device.snmp_port or 161,
        )
    except Exception as e:
        raise HTTPException(503, f"SNMP query failed: {e}")

    monitored = (device.tags or {}).get("monitored_interfaces", [])

    mib_name, mib_tables = (None, [])
    if device.mib_id:
        mib_name, mib_tables = await walk_device_mib_tables(device, db)

    return {
        "interfaces": interfaces,
        "monitored": monitored,
        "mib_name": mib_name,
        "mib_tables": mib_tables,
        "monitored_mib_metrics": (device.tags or {}).get("monitored_mib_metrics", []),
    }


@router.post("/{device_id}/interfaces")
async def set_monitored_interfaces(
    device_id: int,
    data: MonitoredInterfacesRequest,
    db: AsyncSession = Depends(get_db),
):
    """Save which interface indexes to monitor for bandwidth."""
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    if device.source == "desktop_sync":
        raise HTTPException(
            409,
            f"Interface monitoring is managed by the '{device.site_name}' agent, not the server"
        )

    device.tags = {**(device.tags or {}), "monitored_interfaces": data.indexes}
    device.updated_at = datetime.utcnow()
    await db.commit()
    return {"monitored": data.indexes}


@router.post("/{device_id}/mib-metrics")
async def set_monitored_mib_metrics(
    device_id: int,
    data: MonitoredMibMetricsRequest,
    db: AsyncSession = Depends(get_db),
):
    """Save which vendor-MIB table cells to poll and chart like interface bandwidth."""
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    if device.source == "desktop_sync":
        raise HTTPException(
            409,
            f"Interface monitoring is managed by the '{device.site_name}' agent, not the server"
        )

    metrics = [m.model_dump() for m in data.metrics]
    device.tags = {**(device.tags or {}), "monitored_mib_metrics": metrics}
    device.updated_at = datetime.utcnow()
    await db.commit()
    return {"monitored_mib_metrics": metrics}
