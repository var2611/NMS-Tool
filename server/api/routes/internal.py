import os
import logging
from datetime import datetime
from typing import Dict, Any, Optional
from fastapi import APIRouter, Header, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from core.database import get_db, Device
from core.alert_engine import evaluate_metrics, handle_trap_alert, broadcast_ws
from core.sync_agent import sync_agent, device_sync_payload

router = APIRouter()
logger = logging.getLogger(__name__)

def verify_token(x_secret_token: Optional[str] = Header(None)):
    expected = os.environ.get("SECRET_TOKEN")
    if not expected:
        # In development or if not set, do not block
        return
    if x_secret_token != expected:
        raise HTTPException(status_code=401, detail="Invalid secret token")

@router.post("/device-polled", dependencies=[Depends(verify_token)])
async def device_polled(payload: Dict[str, Any], db: AsyncSession = Depends(get_db)):
    device_id = payload.get("device_id")
    status = payload.get("status")
    ping_ms = payload.get("ping_ms")
    metrics = payload.get("metrics", {})
    interfaces = payload.get("interfaces", [])

    # Fetch device from database
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    device_dict_for_eval = {"id": device.id, "name": device.name}

    # Evaluate alerts (commits to db inside)
    await evaluate_metrics(device_dict_for_eval, metrics, db)

    # Broadcast update to WebSockets
    await broadcast_ws("device_update", {
        "device_id": device_id,
        "status": status,
        "ping_ms": ping_ms,
        "metrics": metrics,
    })

    # Queue for cloud sync
    device_payload = await device_sync_payload(device, db, status=status)
    device_payload["uptime_seconds"] = metrics.get("uptime_seconds")
    await sync_agent.queue_entity("device", device_id, "update", device_payload)

    # Queue metric snapshot for sync
    custom = {}
    if ping_ms is not None:
        custom["ping_ms"] = ping_ms
    if interfaces:
        iface_metrics = {}
        for iface in interfaces:
            idx = iface.get("index")
            if idx is not None:
                iface_metrics[str(idx)] = {
                    "name": iface.get("name"),
                    "status": iface.get("status"),
                    "in_mbps": iface.get("in_mbps"),
                    "out_mbps": iface.get("out_mbps"),
                    "bytes_in": iface.get("bytes_in"),
                    "bytes_out": iface.get("bytes_out"),
                }
        custom["interfaces"] = iface_metrics

    metric_payload = {
        "ip_address":          device.ip_address,
        "timestamp":           datetime.utcnow().isoformat(),
        "cpu_percent":         metrics.get("cpu_percent"),
        "memory_percent":      metrics.get("memory_percent"),
        "disk_percent":        metrics.get("disk_percent"),
        "bandwidth_in_mbps":   metrics.get("bandwidth_in_mbps"),
        "bandwidth_out_mbps":  metrics.get("bandwidth_out_mbps"),
        "signal_dbm":          metrics.get("signal_dbm"),
        "ccq_percent":         metrics.get("ccq_percent"),
        "custom_metrics":      {**custom, "ping_ms": ping_ms},
    }
    await sync_agent.queue_entity("metric", device_id, "create", metric_payload)

    return {"status": "ok"}

@router.post("/trap-received", dependencies=[Depends(verify_token)])
async def trap_received(payload: Dict[str, Any], db: AsyncSession = Depends(get_db)):
    # Forward directly to the existing trap alert handler
    await handle_trap_alert(payload, db)
    return {"status": "ok"}
