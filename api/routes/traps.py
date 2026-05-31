from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from typing import Optional, List
from datetime import datetime, timedelta
from pydantic import BaseModel

from core.database import get_db, TrapEvent, TrapRule, AlertSeverity
from core.snmp_engine import send_test_trap, STANDARD_TRAP_NAMES

router = APIRouter()


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
    db: AsyncSession = Depends(get_db)
):
    since = datetime.utcnow() - timedelta(hours=hours)
    q = select(TrapEvent).where(TrapEvent.timestamp >= since)
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
            "source_ip": e.source_ip,
            "device_id": e.device_id,
            "trap_oid": e.trap_oid,
            "trap_name": e.trap_name,
            "plain_english": e.plain_english,
            "severity": e.severity.value if hasattr(e.severity, 'value') else e.severity,
            "rule_matched": e.rule_matched,
        }
        for e in events
    ]


@router.get("/events/stats")
async def trap_stats(db: AsyncSession = Depends(get_db)):
    since = datetime.utcnow() - timedelta(hours=24)
    total = await db.execute(select(func.count(TrapEvent.id)).where(TrapEvent.timestamp >= since))
    critical = await db.execute(select(func.count(TrapEvent.id)).where(
        TrapEvent.timestamp >= since, TrapEvent.severity == AlertSeverity.critical))
    return {
        "last_24h_total": total.scalar(),
        "last_24h_critical": critical.scalar(),
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
    """Send a test SNMP trap and report result."""
    result = await send_test_trap(
        target_ip=req.target_ip,
        port=req.port,
        community=req.community,
        trap_oid=req.trap_oid,
        version=req.version,
    )
    return result


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
