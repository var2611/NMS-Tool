import asyncio
import json
import logging
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from core.database import get_db, Device, DeviceStatus, DeviceType
from core.snmp_engine import discover_subnet

router = APIRouter()
logger = logging.getLogger(__name__)

# Track active scans in memory
_active_scans: dict = {}


class ScanRequest(BaseModel):
    subnet: str
    communities: List[str] = ["public", "private"]
    max_concurrent: int = 30


class ScanResult(BaseModel):
    ip_address: str
    name: str
    device_type: str
    sys_descr: Optional[str]
    sys_name: Optional[str]
    snmp_community: str
    status: str


@router.post("/scan")
async def start_scan(req: ScanRequest, background_tasks: BackgroundTasks):
    """Start a subnet scan in the background. Returns scan_id."""
    scan_id = f"scan_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    _active_scans[scan_id] = {
        "status": "running",
        "progress": 0,
        "total": 0,
        "current_ip": "",
        "found": [],
        "started_at": datetime.utcnow().isoformat(),
        "completed_at": None,
        "error": None,
    }
    background_tasks.add_task(_run_scan, scan_id, req)
    return {"scan_id": scan_id, "message": "Scan started"}


@router.get("/scan/{scan_id}")
async def get_scan_status(scan_id: str):
    """Get current scan progress."""
    scan = _active_scans.get(scan_id)
    if not scan:
        return {"error": "Scan not found"}
    return scan


@router.get("/scan/{scan_id}/stream")
async def stream_scan(scan_id: str):
    """Server-Sent Events stream for real-time scan progress."""
    async def event_generator():
        while True:
            scan = _active_scans.get(scan_id)
            if not scan:
                yield f"data: {json.dumps({'error': 'Scan not found'})}\n\n"
                break
            yield f"data: {json.dumps(scan)}\n\n"
            if scan["status"] in ("completed", "error"):
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )


@router.post("/scan/{scan_id}/save")
async def save_discovered_devices(
    scan_id: str,
    device_ips: List[str],
    db: AsyncSession = Depends(get_db)
):
    """Save selected discovered devices to the database."""
    scan = _active_scans.get(scan_id)
    if not scan:
        return {"error": "Scan not found"}

    found_map = {d["ip_address"]: d for d in scan.get("found", [])}
    saved = []
    skipped = []

    for ip in device_ips:
        device_data = found_map.get(ip)
        if not device_data:
            continue

        # Check if already exists
        existing = await db.execute(select(Device).where(Device.ip_address == ip))
        if existing.scalar_one_or_none():
            skipped.append(ip)
            continue

        # Map device type string to enum
        dtype_map = {
            "pc": DeviceType.pc, "laptop": DeviceType.laptop,
            "printer": DeviceType.printer, "rf_link": DeviceType.rf_link,
            "router": DeviceType.router, "switch": DeviceType.switch,
            "server": DeviceType.server,
        }
        dtype = dtype_map.get(device_data.get("device_type", "unknown"), DeviceType.unknown)

        device = Device(
            name=device_data.get("name") or f"Device-{ip.replace('.', '-')}",
            ip_address=ip,
            device_type=dtype,
            status=DeviceStatus.online,
            snmp_community=device_data.get("snmp_community", "public"),
            sys_descr=device_data.get("sys_descr"),
            sys_object_id=device_data.get("sys_object_id"),
            sys_name=device_data.get("sys_name"),
            sys_location=device_data.get("sys_location"),
            sys_contact=device_data.get("sys_contact"),
            auto_discovered=True,
        )
        db.add(device)
        saved.append(ip)

    await db.commit()
    return {"saved": len(saved), "skipped": len(skipped), "saved_ips": saved}


async def _run_scan(scan_id: str, req: ScanRequest):
    """Background scan task."""
    scan = _active_scans[scan_id]

    async def progress_callback(index, total, ip, state, device_info=None):
        scan["progress"] = index
        scan["total"] = total
        scan["current_ip"] = ip
        if device_info:
            scan["found"].append(device_info)

    try:
        results = await discover_subnet(
            req.subnet,
            communities=req.communities,
            progress_callback=progress_callback,
            max_concurrent=req.max_concurrent,
        )
        scan["found"] = results
        scan["status"] = "completed"
        scan["completed_at"] = datetime.utcnow().isoformat()
        scan["progress"] = scan["total"]
        logger.info(f"Scan {scan_id}: found {len(results)} devices")
    except Exception as e:
        scan["status"] = "error"
        scan["error"] = str(e)
        logger.error(f"Scan {scan_id} error: {e}")
