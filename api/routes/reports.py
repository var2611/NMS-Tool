"""reports.py"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from datetime import datetime, timedelta
from core.database import get_db, Device, Alert, TrapEvent, DeviceMetric, AlertSeverity

router = APIRouter()

@router.get("/summary")
async def summary_report(days: int = 7, db: AsyncSession = Depends(get_db)):
    """Generate a summary report for the dashboard."""
    since = datetime.utcnow() - timedelta(days=days)
    
    total_devices = await db.execute(select(func.count(Device.id)).where(Device.is_active == True))
    total_alerts = await db.execute(select(func.count(Alert.id)).where(Alert.timestamp >= since))
    critical_alerts = await db.execute(select(func.count(Alert.id)).where(
        Alert.timestamp >= since, Alert.severity == AlertSeverity.critical))
    total_traps = await db.execute(select(func.count(TrapEvent.id)).where(TrapEvent.timestamp >= since))
    
    # Alerts by day
    alerts_by_day = []
    for i in range(days):
        day_start = datetime.utcnow().replace(hour=0,minute=0,second=0) - timedelta(days=days-i-1)
        day_end = day_start + timedelta(days=1)
        count = await db.execute(select(func.count(Alert.id)).where(
            Alert.timestamp >= day_start, Alert.timestamp < day_end))
        alerts_by_day.append({"date": day_start.strftime("%Y-%m-%d"), "count": count.scalar()})

    return {
        "period_days": days,
        "total_devices": total_devices.scalar(),
        "total_alerts": total_alerts.scalar(),
        "critical_alerts": critical_alerts.scalar(),
        "total_traps": total_traps.scalar(),
        "alerts_by_day": alerts_by_day,
        "generated_at": datetime.utcnow().isoformat(),
    }

@router.get("/uptime")
async def uptime_report(db: AsyncSession = Depends(get_db)):
    """Per-device uptime statistics."""
    result = await db.execute(select(Device).where(Device.is_active == True))
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
