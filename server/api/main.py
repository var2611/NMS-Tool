"""
NMS-Tool — FastAPI Backend
Serves REST API + WebSocket for the React frontend
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from core.config import settings
from core.database import init_db
from core.mib_parser import load_all_saved_mibs, sync_mibs_to_db
from core.scheduler import scheduler
from core.sync_agent import sync_agent
from core.alert_engine import register_ws, unregister_ws, handle_trap_alert
from core.snmp_engine import TrapListener
from core.database import AsyncSessionLocal

from api.routes import devices, discovery, traps, alerts, mibs, reports, auth, settings as settings_router, ws_router, internal
from api.routes import sync as sync_router
from api.routes import update as update_router

logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(settings.log_file) if settings.log_file else logging.StreamHandler(),
    ]
)
logger = logging.getLogger(__name__)

# Ensure data directories exist
Path("./data/mibs").mkdir(parents=True, exist_ok=True)
Path("./data").mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    logger.info(f"Starting SentinelNMS v{settings.app_version} in {settings.app_mode} mode")
    
    # Init database
    await init_db()
    logger.info("Database initialized")
    
    # Load saved MIB files
    load_all_saved_mibs()
    await sync_mibs_to_db()
    
    # Start polling scheduler (includes metrics pruner)
    # On the server, we only run the metrics pruner and do not poll.
    await scheduler.start(poll=False)

    # SNMP trap listener is disabled on server instances
    trap_listener = None

    logger.info("SentinelNMS ready!")
    yield

    # Shutdown
    await scheduler.stop()
    logger.info("SentinelNMS stopped")


app = FastAPI(
    title="SentinelNMS API",
    version=settings.app_version,
    description="SentinelNMS by Nav Wireless Technologies — REST API",
    lifespan=lifespan,
)

# CORS for React dev server
if not settings.is_desktop:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# ─── API Routes ───────────────────────────────────────────────────────────────

API_PREFIX = "/api/v1"

# Core routers required in both desktop and server mode
app.include_router(auth.router,           prefix=f"{API_PREFIX}/auth",      tags=["Auth"])
app.include_router(mibs.router,           prefix=f"{API_PREFIX}/mibs",      tags=["MIBs"])
app.include_router(sync_router.router,    prefix=f"{API_PREFIX}/sync",      tags=["Sync"])
app.include_router(internal.router,       prefix=f"{API_PREFIX}/internal",  tags=["Internal"])
app.include_router(settings_router.router,prefix=f"{API_PREFIX}/settings",  tags=["Settings"])

# Server-only routers (handled directly by Rust Tauri in desktop mode)
if not settings.is_desktop:
    app.include_router(devices.router,        prefix=f"{API_PREFIX}/devices",   tags=["Devices"])
    app.include_router(discovery.router,      prefix=f"{API_PREFIX}/discovery", tags=["Discovery"])
    app.include_router(traps.router,          prefix=f"{API_PREFIX}/traps",     tags=["Traps"])
    app.include_router(alerts.router,         prefix=f"{API_PREFIX}/alerts",    tags=["Alerts"])
    app.include_router(reports.router,        prefix=f"{API_PREFIX}/reports",   tags=["Reports"])
    app.include_router(update_router.router,  prefix=f"{API_PREFIX}/update",    tags=["Update"])
    app.include_router(ws_router.router,      prefix="",                        tags=["WebSocket"])


@app.get(f"{API_PREFIX}/ping")
async def ping():
    return {"status": "ok", "version": settings.app_version, "mode": settings.app_mode}


@app.get(f"{API_PREFIX}/health")
async def health():
    from core.database import AsyncSessionLocal
    from sqlalchemy import text
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    
    return {
        "status": "healthy" if db_ok else "degraded",
        "database": "ok" if db_ok else "error",
        "scheduler": "running" if scheduler._running else "stopped",
        "sync": sync_agent.status,
        "mode": settings.app_mode,
    }


# ─── Serve React Frontend (production build) ─────────────────────────────────

# Always resolve relative to this file's location so CWD doesn't matter
FRONTEND_BUILD = Path(__file__).resolve().parent.parent / "frontend" / "dist"

if FRONTEND_BUILD.exists() and not settings.is_desktop:
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_BUILD / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str):
        index = FRONTEND_BUILD / "index.html"
        return FileResponse(str(index))
