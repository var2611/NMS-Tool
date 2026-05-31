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
from core.mib_parser import load_all_saved_mibs
from core.scheduler import scheduler
from core.sync_agent import sync_agent
from core.alert_engine import register_ws, unregister_ws, handle_trap_alert
from core.snmp_engine import TrapListener
from core.database import AsyncSessionLocal

from api.routes import devices, discovery, traps, alerts, mibs, reports, auth, settings as settings_router, ws_router
from api.routes import sync as sync_router

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
    
    # Start polling scheduler (includes metrics pruner)
    await scheduler.start()

    # Start SNMP trap listener
    async def _trap_callback(trap_data: dict):
        async with AsyncSessionLocal() as session:
            try:
                await handle_trap_alert(trap_data, session)
            except Exception as exc:
                logger.error(f"Trap handler error: {exc}")

    trap_listener = TrapListener(port=settings.snmp_trap_port, callback=_trap_callback)
    asyncio.create_task(trap_listener.start())

    # Start sync agent (desktop mode only)
    if settings.is_desktop and settings.sync_enabled:
        asyncio.create_task(sync_agent.start())

    logger.info("SentinelNMS ready!")
    yield

    # Shutdown
    await scheduler.stop()
    await trap_listener.stop()
    await sync_agent.stop()
    logger.info("SentinelNMS stopped")


app = FastAPI(
    title="SentinelNMS API",
    version=settings.app_version,
    description="SentinelNMS by Nav Wireless Technologies — REST API",
    lifespan=lifespan,
)

# CORS for React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── API Routes ───────────────────────────────────────────────────────────────

API_PREFIX = "/api/v1"

app.include_router(auth.router,           prefix=f"{API_PREFIX}/auth",      tags=["Auth"])
app.include_router(devices.router,        prefix=f"{API_PREFIX}/devices",   tags=["Devices"])
app.include_router(discovery.router,      prefix=f"{API_PREFIX}/discovery", tags=["Discovery"])
app.include_router(traps.router,          prefix=f"{API_PREFIX}/traps",     tags=["Traps"])
app.include_router(alerts.router,         prefix=f"{API_PREFIX}/alerts",    tags=["Alerts"])
app.include_router(mibs.router,           prefix=f"{API_PREFIX}/mibs",      tags=["MIBs"])
app.include_router(reports.router,        prefix=f"{API_PREFIX}/reports",   tags=["Reports"])
app.include_router(settings_router.router,prefix=f"{API_PREFIX}/settings",  tags=["Settings"])
app.include_router(sync_router.router,    prefix=f"{API_PREFIX}/sync",      tags=["Sync"])
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

if FRONTEND_BUILD.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_BUILD / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str):
        index = FRONTEND_BUILD / "index.html"
        return FileResponse(str(index))
