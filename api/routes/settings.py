from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from core.database import get_db, SystemSetting
from core.config import settings
from core.sync_agent import sync_agent

router = APIRouter()

class SyncConfig(BaseModel):
    server_url: str
    api_key: str
    interval_minutes: int = 5

class SmtpConfig(BaseModel):
    host: str
    port: int = 587
    user: str
    password: str
    from_email: str

class WebhookConfig(BaseModel):
    url: str

@router.get("")
async def get_settings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SystemSetting))
    rows = result.scalars().all()
    return {
        "app": {"mode": settings.app_mode, "version": settings.app_version},
        "snmp": {
            "trap_port": settings.snmp_trap_port,
            "default_community": settings.snmp_default_community,
            "timeout": settings.snmp_timeout,
        },
        "sync": sync_agent.status,
        "smtp": {"host": settings.smtp_host, "port": settings.smtp_port, "user": settings.smtp_user},
        "webhook": {"url": settings.webhook_url},
        "custom": {row.key: row.value for row in rows},
    }

@router.post("/sync")
async def configure_sync(data: SyncConfig):
    """Configure cloud sync settings (desktop mode only)."""
    if settings.is_server:
        return {"error": "Sync config not applicable in server mode"}
    settings.sync_enabled = True
    settings.sync_server_url = data.server_url
    settings.sync_api_key = data.api_key
    settings.sync_interval_minutes = data.interval_minutes
    return {"message": "Sync configured", "status": sync_agent.status}

@router.post("/sync/test")
async def test_sync():
    """Test connection to sync server."""
    import httpx
    url = settings.sync_server_url
    if not url:
        return {"success": False, "error": "No sync server configured"}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{url}/api/v1/ping", 
                                    headers={"X-API-Key": settings.sync_api_key or ""})
            return {"success": resp.status_code == 200, "status_code": resp.status_code}
    except Exception as e:
        return {"success": False, "error": str(e)}

@router.post("/smtp/test")
async def test_smtp(data: SmtpConfig):
    import smtplib
    try:
        with smtplib.SMTP(data.host, data.port, timeout=5) as s:
            s.starttls()
            s.login(data.user, data.password)
        return {"success": True, "message": "SMTP connection successful"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@router.put("/custom/{key}")
async def set_setting(key: str, value: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=key, value=value))
    await db.commit()
    return {"key": key, "value": value}
