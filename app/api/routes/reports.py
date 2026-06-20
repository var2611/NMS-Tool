from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from datetime import datetime, timedelta
from core.database import get_db, Device, Alert, TrapEvent, DeviceMetric, AlertSeverity, User
from core.config import settings
from api.routes.auth import get_current_user

router = APIRouter()

@router.get("/summary")
async def summary_report(
    days: int = 7,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a summary report for the dashboard."""
    since = datetime.utcnow() - timedelta(days=days)
    
    q_devices = select(func.count(Device.id)).where(Device.is_active == True)
    q_alerts = select(func.count(Alert.id)).join(Device, Alert.device_id == Device.id).where(Alert.timestamp >= since)
    q_critical = select(func.count(Alert.id)).join(Device, Alert.device_id == Device.id).where(
        Alert.timestamp >= since, Alert.severity == AlertSeverity.critical)
    q_traps = select(func.count(TrapEvent.id)).join(Device, TrapEvent.device_id == Device.id).where(TrapEvent.timestamp >= since)
    
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            return {
                "period_days": days,
                "total_devices": 0,
                "total_alerts": 0,
                "critical_alerts": 0,
                "total_traps": 0,
                "alerts_by_day": [{"date": (datetime.utcnow().replace(hour=0,minute=0,second=0) - timedelta(days=days-i-1)).strftime("%Y-%m-%d"), "count": 0} for i in range(days)],
                "generated_at": datetime.utcnow().isoformat(),
            }
        if settings.is_server:
            q_devices = q_devices.where(Device.site_name.in_(allowed))
            q_alerts = q_alerts.where(Device.site_name.in_(allowed))
            q_critical = q_critical.where(Device.site_name.in_(allowed))
            q_traps = q_traps.where(Device.site_name.in_(allowed))
        else:
            q_devices = q_devices.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
            q_alerts = q_alerts.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
            q_critical = q_critical.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
            q_traps = q_traps.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))

    total_devices = await db.execute(q_devices)
    total_alerts = await db.execute(q_alerts)
    critical_alerts = await db.execute(q_critical)
    total_traps = await db.execute(q_traps)
    
    # Alerts by day
    alerts_by_day = []
    for i in range(days):
        day_start = datetime.utcnow().replace(hour=0,minute=0,second=0) - timedelta(days=days-i-1)
        day_end = day_start + timedelta(days=1)
        
        q_day = select(func.count(Alert.id)).join(Device, Alert.device_id == Device.id).where(
            Alert.timestamp >= day_start, Alert.timestamp < day_end)
        if user.role != "admin":
            allowed = user.allowed_sites or []
            if settings.is_server:
                q_day = q_day.where(Device.site_name.in_(allowed))
            else:
                q_day = q_day.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
                    
        count = await db.execute(q_day)
        alerts_by_day.append({"date": day_start.strftime("%Y-%m-%d"), "count": count.scalar() or 0})

    return {
        "period_days": days,
        "total_devices": total_devices.scalar() or 0,
        "total_alerts": total_alerts.scalar() or 0,
        "critical_alerts": critical_alerts.scalar() or 0,
        "total_traps": total_traps.scalar() or 0,
        "alerts_by_day": alerts_by_day,
        "generated_at": datetime.utcnow().isoformat(),
    }

@router.get("/uptime")
async def uptime_report(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Per-device uptime statistics."""
    q = select(Device).where(Device.is_active == True)
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            return []
        if settings.is_server:
            q = q.where(Device.site_name.in_(allowed))
        else:
            q = q.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
                
    result = await db.execute(q)
    devices = result.scalars().all()
    rows = []
    for d in devices:
        uptime_h = (d.uptime_seconds or 0) // 3600
        rows.append({
            "name": d.name, "ip": d.ip_address,
            "status": d.status.value if hasattr(d.status, 'value') else d.status,
            "uptime_hours": uptime_h,
            "last_seen": d.last_seen.isoformat() if d.last_seen else None,
            "failures": d.consecutive_failures,
        })
    return rows
