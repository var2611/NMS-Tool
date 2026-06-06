from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel

from core.database import get_db, Device, DeviceMetric, DeviceStatus, DeviceType, SnmpVersion, User
from core.scheduler import scheduler
from core.snmp_engine import list_device_interfaces
from api.routes.auth import get_current_user

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

class DeviceUpdate(BaseModel):
    name: Optional[str] = None
    device_type: Optional[str] = None
    snmp_community: Optional[str] = None
    snmp_version: Optional[str] = None
    poll_interval: Optional[int] = None
    notes: Optional[str] = None
    tags: Optional[dict] = None
    is_active: Optional[bool] = None

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


@router.get("/{device_id}", response_model=DeviceOut)
async def get_device(device_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    return device


@router.post("", response_model=DeviceOut, status_code=201)
async def create_device(data: DeviceCreate, db: AsyncSession = Depends(get_db)):
    # Check duplicate IP
    existing = await db.execute(select(Device).where(Device.ip_address == data.ip_address))
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"Device with IP {data.ip_address} already exists")
    
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
    
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(device, field, value)
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
    device.is_active = False
    await db.commit()
    return {"message": "Device removed"}


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
        }
        for m in metrics
    ]


# ─── Interface management ─────────────────────────────────────────────────────

class MonitoredInterfacesRequest(BaseModel):
    indexes: List[int]  # interface indexes to monitor


@router.get("/{device_id}/interfaces")
async def get_device_interfaces(device_id: int, db: AsyncSession = Depends(get_db)):
    """Fetch all interfaces from device via live SNMP + return which are monitored."""
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
    return {"interfaces": interfaces, "monitored": monitored}


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
