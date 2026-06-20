"""Vendor-MIB table walking and monitored-metric collection.

Split out from api/routes/devices.py so core/scheduler.py can collect
monitored MIB metrics during polling without a circular import
(api/routes/devices.py imports from core.scheduler).
"""
import logging
from pathlib import Path
from typing import Dict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import Device, MibFile
from core.mib_parser import MibParser, extract_port_tables, decode_mib_bytes
from core.snmp_engine import walk_mib_table

logger = logging.getLogger(__name__)


async def walk_device_mib_tables(device: Device, db: AsyncSession):
    """Detect and walk the vendor port/interface tables defined by a device's
    attached MIB profile (e.g. YLWIFI-MIB's Ethernet/radio/VAP/repeater
    tables) — the MIB-aware complement to the standard ifTable walk.

    Best-effort by design: a missing/unparseable MIB or a failed table walk
    must never break the standard interface list, so every failure here is
    swallowed (and logged) rather than raised. Returns `(mib_name, tables)`,
    where `tables` is `[{"table", "columns", "rows"}, ...]` for whichever
    detected tables actually returned data.
    """
    mib = (await db.execute(select(MibFile).where(MibFile.id == device.mib_id))).scalar_one_or_none()
    if not mib:
        return None, []

    try:
        text = decode_mib_bytes(Path(mib.file_path).read_bytes())
        parsed = MibParser().parse(text, mib.filename)
        port_tables = extract_port_tables(text, parsed["oids"])
    except Exception as e:
        logger.warning(f"Could not parse MIB #{mib.id} ({mib.filename}) for device #{device.id}: {e}")
        return mib.name, []

    tables = []
    for t in port_tables:
        try:
            rows = await walk_mib_table(
                device.ip_address, t["columns"],
                device.snmp_community or "public",
                device.snmp_version.value if device.snmp_version else "v2c",
                device.snmp_port or 161,
            )
        except Exception as e:
            logger.warning(f"MIB table walk failed for {t['table']} on device #{device.id}: {e}")
            continue
        if rows:
            tables.append({
                "table": t["table"],
                "columns": [{"name": c["name"], "description": c["description"]} for c in t["columns"]],
                "rows": rows,
            })

    return mib.name, tables


async def collect_monitored_mib_metrics(device: Device, db: AsyncSession) -> Dict[str, float]:
    """Poll only the MIB table cells the user has opted into monitoring.

    Returns `{"table|index|column": value, ...}` for each selected cell that
    currently holds a numeric value — non-numeric or missing cells are
    skipped. Returns `{}` if the device has no MIB attached or no selection,
    so the scheduler's hot path stays free of extra SNMP walks for devices
    that don't use this feature.
    """
    selections = (device.tags or {}).get("monitored_mib_metrics") or []
    if not device.mib_id or not selections:
        return {}

    mib = (await db.execute(select(MibFile).where(MibFile.id == device.mib_id))).scalar_one_or_none()
    if not mib:
        return {}

    try:
        text = decode_mib_bytes(Path(mib.file_path).read_bytes())
        parsed = MibParser().parse(text, mib.filename)
        port_tables = extract_port_tables(text, parsed["oids"])
    except Exception as e:
        logger.warning(f"Could not parse MIB #{mib.id} ({mib.filename}) for device #{device.id}: {e}")
        return {}

    wanted_tables = {sel["table"] for sel in selections}
    rows_by_table: Dict[str, Dict[int, Dict]] = {}
    for t in port_tables:
        if t["table"] not in wanted_tables:
            continue
        try:
            rows = await walk_mib_table(
                device.ip_address, t["columns"],
                device.snmp_community or "public",
                device.snmp_version.value if device.snmp_version else "v2c",
                device.snmp_port or 161,
            )
        except Exception as e:
            logger.warning(f"MIB metric walk failed for {t['table']} on device #{device.id}: {e}")
            continue
        rows_by_table[t["table"]] = {row["index"]: row for row in rows}

    metrics: Dict[str, float] = {}
    for sel in selections:
        row = rows_by_table.get(sel["table"], {}).get(sel["index"])
        if not row:
            continue
        value = row.get(sel["column"])
        if value is None:
            continue
        try:
            metrics[f"{sel['table']}|{sel['index']}|{sel['column']}"] = float(value)
        except (ValueError, TypeError):
            continue

    return metrics
