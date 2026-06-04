from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional
from datetime import datetime

from core.database import get_db, MibFile
from core.mib_parser import save_mib_file, search_oids, get_all_oids, resolve_oid
from core.snmp_engine import snmp_get, snmp_walk

router = APIRouter()


@router.get("")
async def list_mibs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MibFile).order_by(MibFile.is_standard.desc(), MibFile.name))
    mibs = result.scalars().all()
    return [
        {
            "id": m.id, "name": m.name, "filename": m.filename,
            "oid_count": m.oid_count, "is_standard": m.is_standard,
            "is_enabled": m.is_enabled, "vendor": m.vendor,
            "description": m.description, "uploaded_at": m.uploaded_at.isoformat(),
            "file_size": m.file_size,
        }
        for m in mibs
    ]


@router.post("/upload")
async def upload_mib(file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    """Upload and parse a MIB file."""
    if not file.filename:
        raise HTTPException(400, "No filename")
    
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:  # 5MB limit
        raise HTTPException(400, "File too large (max 5MB)")

    try:
        file_path, parse_result = await save_mib_file(file.filename, content)
    except Exception as e:
        raise HTTPException(400, f"Could not parse MIB: {e}")

    # Check if already in DB
    existing = await db.execute(select(MibFile).where(MibFile.filename == file.filename))
    mib_record = existing.scalar_one_or_none()
    
    if mib_record:
        mib_record.oid_count = parse_result["oid_count"]
        mib_record.parsed_oids = {k: v for k, v in list(parse_result["oids"].items())[:100]}
        mib_record.file_size = len(content)
    else:
        mib_record = MibFile(
            name=parse_result["module_name"],
            filename=file.filename,
            file_path=file_path,
            file_size=len(content),
            oid_count=parse_result["oid_count"],
            parsed_oids={k: v for k, v in list(parse_result["oids"].items())[:100]},
        )
        db.add(mib_record)

    await db.commit()
    return {
        "message": "MIB uploaded successfully",
        "module_name": parse_result["module_name"],
        "oid_count": parse_result["oid_count"],
        "filename": file.filename,
    }


@router.delete("/{mib_id}")
async def delete_mib(mib_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MibFile).where(MibFile.id == mib_id))
    mib = result.scalar_one_or_none()
    if not mib:
        raise HTTPException(404, "MIB not found")
    if mib.is_standard:
        raise HTTPException(400, "Cannot delete standard MIBs")
    import os
    try:
        os.remove(mib.file_path)
    except Exception:
        pass
    await db.delete(mib)
    await db.commit()
    return {"message": "MIB deleted"}


@router.get("/search")
async def search_mib_oids(q: str = Query(..., min_length=2)):
    """Search OIDs by name or description."""
    return search_oids(q)


@router.get("/resolve/{oid:path}")
async def resolve_oid_endpoint(oid: str):
    """Resolve a numeric OID to its name and description."""
    return resolve_oid(oid)


@router.post("/test-oid")
async def test_oid(body: dict):
    """Fetch a live OID value from a device."""
    ip = body.get("ip")
    oid = body.get("oid")
    community = body.get("community", "public")
    
    if not ip or not oid:
        raise HTTPException(400, "ip and oid are required")
    
    result = await snmp_get(ip, [oid], community=community)
    
    if result:
        val = list(result.values())[0] if result else None
        oid_info = resolve_oid(oid)
        return {
            "success": True,
            "oid": oid,
            "name": oid_info.get("name", oid),
            "value": val,
            "unit": oid_info.get("unit", ""),
            "description": oid_info.get("description", ""),
        }
    return {"success": False, "error": "No response from device — check IP and community string"}


@router.post("/walk-oid")
async def walk_oid(body: dict):
    """Walk an OID subtree on a device — returns all child OIDs and values."""
    ip        = body.get("ip")
    oid       = body.get("oid")
    community = body.get("community", "public")
    max_rows  = int(body.get("max_rows", 50))

    if not ip or not oid:
        raise HTTPException(400, "ip and oid are required")

    results = await snmp_walk(ip, oid, community=community, max_rows=max_rows)

    if results:
        rows = []
        for full_oid, value in results.items():
            info = resolve_oid(full_oid)
            rows.append({
                "oid":         full_oid,
                "name":        info.get("name", full_oid),
                "value":       value,
                "description": info.get("description", ""),
            })
        return {"success": True, "oid": oid, "count": len(rows), "results": rows}
    return {"success": False, "error": "No data returned — OID may not exist or device unreachable"}
