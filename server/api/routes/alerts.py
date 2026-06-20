"""alerts.py"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from typing import Optional
from datetime import datetime, timedelta
from pydantic import BaseModel
from core.database import get_db, Alert, AlertStatus, AlertSeverity, Device, User
from core.config import settings
from api.routes.auth import get_current_user

router = APIRouter()

import re

IP_RE = re.compile(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b')

def mask_ips(text: str) -> str:
    if not text:
        return text
    return IP_RE.sub('*.*.*.*', text)

class AlertAck(BaseModel):
    notes: Optional[str] = None
    acknowledged_by: str = "admin"

@router.get("")
async def list_alerts(
    status: Optional[str] = None,
    severity: Optional[str] = None,
    hours: int = Query(72, le=720),
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    since = datetime.utcnow() - timedelta(hours=hours)
    q = select(Alert).join(Device, Alert.device_id == Device.id).where(Alert.timestamp >= since)
    
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            return []
        if settings.is_server:
            q = q.where(Device.site_name.in_(allowed))
        else:
            q = q.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))

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
            "device_id": a.device_id,
            "title": mask_ips(a.title) if user.role != "admin" else a.title,
            "message": mask_ips(a.message) if user.role != "admin" else a.message,
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
async def alert_summary(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    since = datetime.utcnow() - timedelta(hours=24)
    
    q_total = select(func.count(Alert.id)).join(Device, Alert.device_id == Device.id).where(Alert.timestamp >= since)
    q_critical = select(func.count(Alert.id)).join(Device, Alert.device_id == Device.id).where(
        Alert.timestamp >= since, Alert.severity == AlertSeverity.critical)
    q_new = select(func.count(Alert.id)).join(Device, Alert.device_id == Device.id).where(Alert.status == AlertStatus.new)

    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            return {
                "last_24h": 0,
                "critical_24h": 0,
                "unacknowledged": 0,
            }
        if settings.is_server:
            q_total = q_total.where(Device.site_name.in_(allowed))
            q_critical = q_critical.where(Device.site_name.in_(allowed))
            q_new = q_new.where(Device.site_name.in_(allowed))
        else:
            q_total = q_total.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
            q_critical = q_critical.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
            q_new = q_new.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))

    total = await db.execute(q_total)
    critical = await db.execute(q_critical)
    new_alerts = await db.execute(q_new)
    
    return {
        "last_24h": total.scalar() or 0,
        "critical_24h": critical.scalar() or 0,
        "unacknowledged": new_alerts.scalar() or 0,
    }

@router.post("/{alert_id}/acknowledge")
async def acknowledge_alert(
    alert_id: int,
    data: AlertAck,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(404, "Alert not found")
        
    # Guard: check if allowed to view this device
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            raise HTTPException(403, "Access denied")
        res_dev = await db.execute(select(Device).where(Device.id == alert.device_id))
        device = res_dev.scalar_one_or_none()
        if device:
            if settings.is_server:
                if device.site_name not in allowed:
                    raise HTTPException(403, "Access denied")
            else:
                if device.source == "desktop_sync" and device.site_name not in allowed:
                    raise HTTPException(403, "Access denied")

    alert.status = AlertStatus.acknowledged
    alert.acknowledged_by = data.acknowledged_by
    alert.acknowledged_at = datetime.utcnow()
    alert.notes = data.notes
    await db.commit()
    return {"message": "Alert acknowledged"}

@router.post("/{alert_id}/resolve")
async def resolve_alert(
    alert_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(404, "Alert not found")
        
    # Guard: check if allowed to view this device
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            raise HTTPException(403, "Access denied")
        res_dev = await db.execute(select(Device).where(Device.id == alert.device_id))
        device = res_dev.scalar_one_or_none()
        if device:
            if settings.is_server:
                if device.site_name not in allowed:
                    raise HTTPException(403, "Access denied")
            else:
                if device.source == "desktop_sync" and device.site_name not in allowed:
                    raise HTTPException(403, "Access denied")

    alert.status = AlertStatus.resolved
    alert.resolved_at = datetime.utcnow()
    await db.commit()
    return {"message": "Alert resolved"}
