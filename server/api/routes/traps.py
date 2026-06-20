from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from typing import Optional, List
from datetime import datetime, timedelta
from pydantic import BaseModel

from core.database import get_db, TrapEvent, TrapRule, AlertSeverity, Device, User
from core.config import settings
from api.routes.auth import get_current_user
from core.snmp_engine import send_test_trap, STANDARD_TRAP_NAMES

router = APIRouter()

import re

IP_RE = re.compile(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b')

def mask_ips(text: str) -> str:
    if not text:
        return text
    return IP_RE.sub('*.*.*.*', text)


class TrapRuleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    trap_oid_pattern: str
    severity: str = "info"
    plain_english_template: Optional[str] = None
    create_alert: bool = True
    send_email: bool = False
    send_webhook: bool = False
    play_sound: bool = False
    suppress_start_hour: Optional[int] = None
    suppress_end_hour: Optional[int] = None
    escalate_after_count: Optional[int] = None
    escalate_within_minutes: Optional[int] = None


class TestTrapRequest(BaseModel):
    target_ip: str
    port: int = 162
    community: str = "public"
    trap_oid: str = "1.3.6.1.6.3.1.1.5.1"
    version: str = "v2c"


@router.get("/events")
async def list_trap_events(
    hours: int = Query(24, le=168),
    severity: Optional[str] = None,
    source_ip: Optional[str] = None,
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    since = datetime.utcnow() - timedelta(hours=hours)
    q = select(TrapEvent).join(Device, TrapEvent.device_id == Device.id).where(TrapEvent.timestamp >= since)
    
    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            return []
        if settings.is_server:
            q = q.where(Device.site_name.in_(allowed))
        else:
            q = q.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))

    if severity:
        q = q.where(TrapEvent.severity == severity)
    if source_ip:
        q = q.where(TrapEvent.source_ip == source_ip)
    q = q.order_by(desc(TrapEvent.timestamp)).limit(limit)
    result = await db.execute(q)
    events = result.scalars().all()
    return [
        {
            "id": e.id,
            "timestamp": e.timestamp.isoformat(),
            "source_ip": "*.*.*.*" if user.role != "admin" else e.source_ip,
            "device_id": e.device_id,
            "trap_oid": e.trap_oid,
            "trap_name": e.trap_name,
            "plain_english": mask_ips(e.plain_english) if user.role != "admin" else e.plain_english,
            "severity": e.severity.value if hasattr(e.severity, 'value') else e.severity,
            "rule_matched": e.rule_matched,
        }
        for e in events
    ]


@router.get("/events/stats")
async def trap_stats(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    since = datetime.utcnow() - timedelta(hours=24)
    q_total = select(func.count(TrapEvent.id)).join(Device, TrapEvent.device_id == Device.id).where(TrapEvent.timestamp >= since)
    q_critical = select(func.count(TrapEvent.id)).join(Device, TrapEvent.device_id == Device.id).where(
        TrapEvent.timestamp >= since, TrapEvent.severity == AlertSeverity.critical)

    if user.role != "admin":
        allowed = user.allowed_sites or []
        if not allowed:
            return {
                "last_24h_total": 0,
                "last_24h_critical": 0,
            }
        if settings.is_server:
            q_total = q_total.where(Device.site_name.in_(allowed))
            q_critical = q_critical.where(Device.site_name.in_(allowed))
        else:
            q_total = q_total.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))
            q_critical = q_critical.where((Device.site_name.in_(allowed)) | (Device.source != "desktop_sync"))

    total = await db.execute(q_total)
    critical = await db.execute(q_critical)
    return {
        "last_24h_total": total.scalar() or 0,
        "last_24h_critical": critical.scalar() or 0,
    }


@router.get("/rules")
async def list_rules(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TrapRule).order_by(TrapRule.name))
    rules = result.scalars().all()
    return [
        {
            "id": r.id, "name": r.name, "description": r.description,
            "is_enabled": r.is_enabled, "trap_oid_pattern": r.trap_oid_pattern,
            "severity": r.severity.value if hasattr(r.severity, 'value') else r.severity,
            "plain_english_template": r.plain_english_template,
            "create_alert": r.create_alert, "send_email": r.send_email,
            "send_webhook": r.send_webhook, "play_sound": r.play_sound,
            "suppress_start_hour": r.suppress_start_hour, "suppress_end_hour": r.suppress_end_hour,
        }
        for r in rules
    ]


@router.post("/rules", status_code=201)
async def create_rule(data: TrapRuleCreate, db: AsyncSession = Depends(get_db)):
    rule = TrapRule(**data.model_dump())
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return {"id": rule.id, "name": rule.name, "message": "Rule created"}


@router.put("/rules/{rule_id}")
async def update_rule(rule_id: int, data: TrapRuleCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TrapRule).where(TrapRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(404, "Rule not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(rule, k, v)
    rule.updated_at = datetime.utcnow()
    await db.commit()
    return {"message": "Rule updated"}


@router.patch("/rules/{rule_id}/toggle")
async def toggle_rule(rule_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TrapRule).where(TrapRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(404, "Rule not found")
    rule.is_enabled = not rule.is_enabled
    await db.commit()
    return {"id": rule_id, "is_enabled": rule.is_enabled}


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TrapRule).where(TrapRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(404, "Rule not found")
    await db.delete(rule)
    await db.commit()
    return {"message": "Rule deleted"}


@router.post("/test")
async def test_trap(req: TestTrapRequest):
    """Send a test SNMP trap. Disabled on server."""
    raise HTTPException(
        status_code=400,
        detail="Test trap transmission is disabled on server instances. Traps can only be sent from local environments."
    )


@router.get("/standard-types")
async def get_standard_trap_types():
    """List all standard trap types for the UI dropdown."""
    return [
        {"oid": oid, "name": name,
         "description": {
             "coldStart": "Device did a full restart",
             "warmStart": "Device reloaded config",
             "linkDown": "Network interface went offline",
             "linkUp": "Network interface came back online",
             "authenticationFailure": "Wrong SNMP community string used",
             "egpNeighborLoss": "Lost connection to routing neighbor",
         }.get(name, "Enterprise-specific trap")
        }
        for oid, name in STANDARD_TRAP_NAMES.items()
    ]
