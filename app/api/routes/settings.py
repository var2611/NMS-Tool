from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from core.database import get_db, SystemSetting, User
from core.config import settings
from core.sync_agent import sync_agent
from api.routes.auth import require_admin
import logging

logger = logging.getLogger(__name__)


router = APIRouter()

class SyncConfig(BaseModel):
    server_url: str
    api_key: str = ""
    site_name: str = ""
    interval_minutes: int = 5

class SmtpConfig(BaseModel):
    host: str
    port: int = 587
    user: str
    password: str
    from_email: str

class WebhookConfig(BaseModel):
    url: str

class SnmpSettingsUpdate(BaseModel):
    timeout: int  # seconds, clamped to 2–15
    poll_interval: Optional[int] = None

async def _get_all_settings(db: AsyncSession) -> dict:
    """Load all system_settings rows keyed by name."""
    result = await db.execute(select(SystemSetting))
    return {row.key: row.value for row in result.scalars().all()}


async def _save_setting(key: str, value: str, db: AsyncSession):
    """Upsert a single system_settings row."""
    result = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=key, value=value))


@router.get("")
async def get_settings(db: AsyncSession = Depends(get_db)):
    db_settings = await _get_all_settings(db)

    # SNMP timeout: DB overrides .env
    snmp_timeout = int(db_settings.get("snmp_timeout", settings.snmp_timeout))

    # Sync config: DB is the source of truth for persistence.
    # Fall back to in-memory sync_agent values (set on .env load or after configure_sync).
    sync_server_url   = db_settings.get("sync_server_url")   or sync_agent.server_url or ""
    sync_site_name    = db_settings.get("sync_site_name")    or settings.sync_site_name or ""
    sync_interval     = int(db_settings.get("sync_interval_minutes", settings.sync_interval_minutes))

    # Global poll interval: DB setting, default to 5
    poll_interval = int(db_settings.get("poll_interval", 5))

    return {
        "app": {"mode": settings.app_mode, "version": settings.app_version},
        "snmp": {
            "trap_port":         settings.snmp_trap_port,
            "default_community": settings.snmp_default_community,
            "timeout":           snmp_timeout,
            "poll_interval":     poll_interval,
        },
        "sync": {
            **sync_agent.status,
            "server_url":       sync_server_url,
            "site_name":        sync_site_name,
            "interval_minutes": sync_interval,
            # api_key intentionally omitted — never sent back to frontend for security
        },
        "smtp":    {"host": settings.smtp_host, "port": settings.smtp_port, "user": settings.smtp_user},
        "webhook": {"url": settings.webhook_url},
        "custom":  db_settings,
    }

@router.put("/snmp")
async def save_snmp_settings(data: SnmpSettingsUpdate, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)):
    """Save SNMP poll timeout (2–15 seconds) and poll_interval (1–15 seconds) to DB."""
    try:
        timeout = max(2, min(15, data.timeout))
        await _save_setting("snmp_timeout", str(timeout), db)
        
        poll_interval = None
        if data.poll_interval is not None:
            poll_interval = max(1, min(15, data.poll_interval))
            await _save_setting("poll_interval", str(poll_interval), db)
            
        await db.commit()
        
        res = {"timeout": timeout}
        if poll_interval is not None:
            res["poll_interval"] = poll_interval
        return res
    except Exception as e:
        logger.exception("Error in save_snmp_settings")
        raise

def _write_env_settings(**kwargs):
    """
    Persist key=value pairs to the userData .env file so they survive restarts.
    Finds the file via LOG_FILE or SQLITE_DB_PATH env vars (set by Electron main.js).
    """
    from pathlib import Path
    import os

    # Candidate paths: userData/.env (set by Electron) or cwd/.env
    candidates = []
    if settings.log_file:
        candidates.append(Path(settings.log_file).parent / '.env')
    if settings.sqlite_db_path:
        candidates.append(Path(settings.sqlite_db_path).parent / '.env')
    candidates.append(Path('.env'))

    env_path = next((p for p in candidates if p.exists()), None)
    if not env_path:
        return  # no .env to write to

    try:
        content = env_path.read_text()
        lines = content.splitlines(keepends=True)

        for key, value in kwargs.items():
            key_upper = key.upper()
            found = False
            new_lines = []
            for line in lines:
                stripped = line.strip()
                if stripped.startswith(f'{key_upper}=') or stripped == f'{key_upper}=':
                    new_lines.append(f'{key_upper}={value}\n')
                    found = True
                else:
                    new_lines.append(line)
            if not found:
                new_lines.append(f'{key_upper}={value}\n')
            lines = new_lines

        env_path.write_text(''.join(lines))
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Could not write .env: {e}")


@router.post("/sync")
async def configure_sync(data: SyncConfig, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)):
    """Configure cloud sync settings (desktop mode only)."""
    try:
        if settings.is_server:
            return {"error": "Sync config not applicable in server mode"}
    
        site = data.site_name.strip() or settings.sync_site_name or "Desktop-Agent"
    
        # 1. Persist to DB (primary source of truth — survives restarts reliably)
        for key, value in [
            ("sync_server_url",      data.server_url),
            ("sync_site_name",       site),
            ("sync_interval_minutes", str(data.interval_minutes)),
            ("sync_enabled",         "true"),
        ]:
            await _save_setting(key, value, db)
        await db.commit()
    
        # 2. Also write to .env so the values are loaded on next cold start
        #    (belt-and-suspenders: DB is the primary, .env is the bootstrap)
        _write_env_settings(
            SYNC_ENABLED="true",
            SYNC_SERVER_URL=data.server_url,
            SYNC_API_KEY=data.api_key,
            SYNC_SITE_NAME=site,
            SYNC_INTERVAL_MINUTES=str(data.interval_minutes),
        )
    
        # 3. Update in-memory settings for this session
        settings.sync_enabled = True
        settings.sync_server_url = data.server_url
        settings.sync_api_key = data.api_key
        settings.sync_site_name = site
        settings.sync_interval_minutes = data.interval_minutes
    
        # 4. Live-restart sync agent
        await sync_agent.reconfigure(
            server_url=data.server_url,
            api_key=data.api_key,
            site_name=site,
            interval_minutes=data.interval_minutes,
        )
    
        return {"message": "Sync configured and started", "status": sync_agent.status}
    except Exception as e:
        logger.exception("Error in configure_sync")
        raise

@router.post("/sync/test")
async def test_sync(_admin: User = Depends(require_admin)):
    """Test connection to sync server. Fails if the URL points to another desktop app."""
    import httpx
    url = settings.sync_server_url
    if not url:
        return {"success": False, "error": "No sync server URL configured"}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{url}/api/v1/ping",
                                    headers={"X-API-Key": settings.sync_api_key or ""})
            if resp.status_code != 200:
                return {"success": False, "error": f"Server returned HTTP {resp.status_code}"}

            data = resp.json()
            mode = data.get("mode", "unknown")

            # Guard: reject if the remote is another desktop instance (mode != server)
            if mode != "server":
                return {
                    "success": False,
                    "error": (
                        f"The URL points to a desktop app (mode='{mode}'), not a cloud server. "
                        "Start the Docker server and use its URL, or change the port."
                    ),
                }

            # /ping is public, so it can't catch a bad API key — probe a
            # key-protected sync endpoint too, otherwise the test passes while
            # every actual push gets rejected with 403.
            auth_resp = await client.get(
                f"{url}/api/v1/sync/devices",
                params={"site_name": settings.sync_site_name or "Desktop-Agent"},
                headers={"X-API-Key": settings.sync_api_key or ""},
            )
            if auth_resp.status_code == 403:
                return {
                    "success": False,
                    "error": "Server reachable, but it rejected the API key — ask the server admin for the gateway key.",
                }

            return {
                "success": True,
                "mode": mode,
                "version": data.get("version"),
            }
    except Exception as e:
        return {"success": False, "error": f"Cannot reach server: {e}"}

@router.post("/smtp/test")
async def test_smtp(data: SmtpConfig, _admin: User = Depends(require_admin)):
    import smtplib
    try:
        with smtplib.SMTP(data.host, data.port, timeout=5) as s:
            s.starttls()
            s.login(data.user, data.password)
        return {"success": True, "message": "SMTP connection successful"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@router.put("/custom/{key}")
async def set_setting(key: str, value: str, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)):
    result = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=key, value=value))
    await db.commit()
    return {"key": key, "value": value}
