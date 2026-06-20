import asyncio
import json
import logging
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
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


@router.post("/scan")
async def start_scan(req: ScanRequest):
    raise HTTPException(status_code=400, detail="Subnet scanning is disabled on server instances.")


@router.get("/scan/{scan_id}")
async def get_scan_status(scan_id: str):
    raise HTTPException(status_code=400, detail="Subnet scanning is disabled on server instances.")


@router.get("/scan/{scan_id}/stream")
async def stream_scan(scan_id: str):
    raise HTTPException(status_code=400, detail="Subnet scanning is disabled on server instances.")


@router.post("/scan/{scan_id}/save")
async def save_discovered_devices(scan_id: str, device_ips: List[str]):
    raise HTTPException(status_code=400, detail="Subnet scanning is disabled on server instances.")
