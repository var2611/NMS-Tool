"""alerts.py"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from typing import Optional
from datetime import datetime, timedelta
from pydantic import BaseModel
from core.database import get_db, Alert, AlertStatus, AlertSeverity

router = APIRouter()

class AlertAck(BaseModel):
    notes: Optional[str] = None
    acknowledged_by: str = "admin"

@router.get("")
async def list_alerts(
    status: Optional[str] = None,
    severity: Optional[str] = None,
    hours: int = Query(72, le=720),
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db)
):
    since = datetime.utcnow() - timedelta(hours=hours)
    q = select(Alert).where(Alert.timestamp >= since)
    if status:
        q = q.where(Alert.status == status)
    if severity:
        q = q.where(Alert.severity == severity)
    q = q.order_by(desc(Alert.timestamp)).limit(limit)
    result = await db.execute(q)
    alerts = result.scalars().all()
    return [
        {
            "id": a.id, "timestamp": a.timestamp.isoformat(),
            "device_id": a.device_id, "title": a.title, "message": a.message,
            "severity": a.severity.value if hasattr(a.severity, 'value') else a.severity,
            "status": a.status.value if hasattr(a.status, 'value') else a.status,
            "source": a.source, "metric_name": a.metric_name,
            "metric_value": a.metric_value, "acknowledged_by": a.acknowledged_by,
            "acknowledged_at": a.acknowledged_at.isoformat() if a.acknowledged_at else None,
            "notes": a.notes,
        }
        for a in alerts
    ]

@router.get("/summary")
async def alert_summary(db: AsyncSession = Depends(get_db)):
    since = datetime.utcnow() - timedelta(hours=24)
    total = await db.execute(select(func.count(Alert.id)).where(Alert.timestamp >= since))
    critical = await db.execute(select(func.count(Alert.id)).where(Alert.timestamp >= since, Alert.severity == AlertSeverity.critical))
    new_alerts = await db.execute(select(func.count(Alert.id)).where(Alert.status == AlertStatus.new))
    return {
        "last_24h": total.scalar(),
        "critical_24h": critical.scalar(),
        "unacknowledged": new_alerts.scalar(),
    }

@router.post("/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: int, data: AlertAck, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(404, "Alert not found")
    alert.status = AlertStatus.acknowledged
    alert.acknowledged_by = data.acknowledged_by
    alert.acknowledged_at = datetime.utcnow()
    alert.notes = data.notes
    await db.commit()
    return {"message": "Alert acknowledged"}

@router.post("/{alert_id}/resolve")
async def resolve_alert(alert_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(404, "Alert not found")
    alert.status = AlertStatus.resolved
    alert.resolved_at = datetime.utcnow()
    await db.commit()
    return {"message": "Alert resolved"}
