"""Server self-update — admin button in the web UI.

The API container cannot update itself (the update recreates this very
container), so the contract is file-based:

  - The host runs scripts/server-auto-update.sh from cron. A 1-minute cron
    watches for trigger files; data/update/ is bind-mounted into the container.
  - POST /apply drops data/update/trigger-apply  → host pulls + rebuilds + redeploys
  - POST /check drops data/update/trigger-check  → host refreshes check.json
  - The host script writes progress to data/update/status.json, which
    GET /status streams back to the UI — the file survives the container
    restart, so the progress modal can ride through the API outage.

Server mode only — the desktop app updates through its Electron updater.
"""
from fastapi import APIRouter, Depends, HTTPException
from pathlib import Path
from datetime import datetime
import json
import logging

from core.config import settings
from core.database import User
from api.routes.auth import require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

UPDATE_DIR = Path("data/update")


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _require_server_mode():
    if settings.app_mode != "server":
        raise HTTPException(400, "Self-update is only available in server mode")


@router.get("/status")
async def update_status(_admin: User = Depends(require_admin)):
    """Current version + last check result + live update progress."""
    return {
        "app_version": settings.app_version,
        "mode": settings.app_mode,
        "supported": settings.app_mode == "server",
        "check": _read_json(UPDATE_DIR / "check.json"),
        "status": _read_json(UPDATE_DIR / "status.json"),
    }


@router.post("/check")
async def request_check(_admin: User = Depends(require_admin)):
    """Ask the host updater to refresh check.json (picked up within ~1 min)."""
    _require_server_mode()
    UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    (UPDATE_DIR / "trigger-check").write_text(datetime.utcnow().isoformat())
    logger.info(f"Update check requested by {_admin.username}")
    return {"message": "Check requested — the server updater picks it up within a minute"}


@router.post("/apply")
async def request_apply(_admin: User = Depends(require_admin)):
    """Ask the host updater to pull + rebuild + redeploy (picked up within ~1 min)."""
    _require_server_mode()
    UPDATE_DIR.mkdir(parents=True, exist_ok=True)

    # Seed the status file so the UI shows "queued" until the host takes over
    (UPDATE_DIR / "status.json").write_text(json.dumps({
        "phase": "queued",
        "step": 0,
        "total": 5,
        "message": "Update queued — waiting for the server updater to start (up to 1 minute)…",
        "error": None,
        "from": None,
        "to": None,
        "started_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }))
    (UPDATE_DIR / "trigger-apply").write_text(datetime.utcnow().isoformat())
    logger.warning(f"Server update triggered by {_admin.username}")
    return {"message": "Update queued"}
