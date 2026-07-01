"""
SNMP Engine — Core of NMS-Tool
Handles: device discovery, polling, trap listening
"""
import asyncio
import logging
import re
import socket
import struct
from datetime import datetime
from typing import Optional, Callable, Dict, Any, List
from ipaddress import IPv4Network, IPv4Address

from pysnmp.hlapi.asyncio import (
    SnmpEngine, CommunityData, UdpTransportTarget, ContextData,
    ObjectType, ObjectIdentity, getCmd, nextCmd, bulkCmd
)
from pysnmp.entity import engine as snmp_engine_mod, config as snmp_config
from pysnmp.entity.rfc3413 import ntfrcv
from pysnmp.carrier.asyncio.dgram import udp
from pysnmp.hlapi.asyncio.auth import UsmUserData
from pysnmp.proto import rfc1902

logger = logging.getLogger(__name__)

# ─── Standard OIDs ────────────────────────────────────────────────────────────

STANDARD_OIDS = {
    "sysDescr":      "1.3.6.1.2.1.1.1.0",
    "sysObjectID":   "1.3.6.1.2.1.1.2.0",
    "sysUpTime":     "1.3.6.1.2.1.1.3.0",
    "sysContact":    "1.3.6.1.2.1.1.4.0",
    "sysName":       "1.3.6.1.2.1.1.5.0",
    "sysLocation":   "1.3.6.1.2.1.1.6.0",
    "ifNumber":      "1.3.6.1.2.1.2.1.0",
    "ifDescr":       "1.3.6.1.2.1.2.2.1.2",
    "ifOperStatus":  "1.3.6.1.2.1.2.2.1.8",
    "ifInOctets":    "1.3.6.1.2.1.2.2.1.10",
    "ifOutOctets":   "1.3.6.1.2.1.2.2.1.16",
    "hrProcessorLoad": "1.3.6.1.2.1.25.3.3.1.2",
    "hrStorageUsed": "1.3.6.1.2.1.25.2.3.1.6",
    "hrStorageSize": "1.3.6.1.2.1.25.2.3.1.5",
    "hrStorageDescr": "1.3.6.1.2.1.25.2.3.1.3",
    # Printer MIB
    "prtMarkerSuppliesLevel":    "1.3.6.1.2.1.43.11.1.1.9",
    "prtMarkerSuppliesMaxCapacity": "1.3.6.1.2.1.43.11.1.1.8",
    "prtMarkerSuppliesDescription": "1.3.6.1.2.1.43.11.1.1.6",
    "prtGeneralPrinterName":    "1.3.6.1.2.1.43.5.1.1.16",
}

# ─── Device Type Fingerprinting ───────────────────────────────────────────────

DEVICE_FINGERPRINTS = {
    # Printers
    "1.3.6.1.4.1.11": "printer",    # HP
    "1.3.6.1.4.1.253": "printer",   # Xerox
    "1.3.6.1.4.1.367": "printer",   # Ricoh
    "1.3.6.1.4.1.2435": "printer",  # Brother
    "1.3.6.1.4.1.1602": "printer",  # Canon
    # RF Links
    "1.3.6.1.4.1.10002": "rf_link", # Ubiquiti
    "1.3.6.1.4.1.17713": "rf_link", # LigoWave
    "1.3.6.1.4.1.161": "rf_link",   # Motorola/Cambium
    # Routers/Switches
    "1.3.6.1.4.1.9": "router",      # Cisco
    "1.3.6.1.4.1.11863": "router",  # TP-Link
    "1.3.6.1.4.1.14988": "router",  # MikroTik
    "1.3.6.1.4.1.4526": "router",   # Netgear
    # Servers/PC
    "1.3.6.1.4.1.311": "pc",        # Microsoft Windows
    "1.3.6.1.4.1.8072": "pc",       # Net-SNMP (Linux)
}

SYSDESCR_KEYWORDS = {
    "windows": "pc",
    "linux": "pc",
    "ubuntu": "pc",
    "debian": "pc",
    "centos": "pc",
    "laptop": "laptop",
    "notebook": "laptop",
    "printer": "printer",
    "print server": "printer",
    "laserjet": "printer",
    "ubiquiti": "rf_link",
    "airmax": "rf_link",
    "airfiber": "rf_link",
    "litebeam": "rf_link",
    "nanostation": "rf_link",
    "mikrotik": "router",
    "cisco": "router",
    "juniper": "router",
}


# ─── SNMP GET Helper ─────────────────────────────────────────────────────────

async def snmp_get(ip: str, oids: List[str], community: str = "public",
                   version: str = "v2c", port: int = 161,
                   timeout: int = 5, retries: int = 1) -> Dict[str, Any]:
    """Perform SNMP GET for a list of OIDs. Returns dict of {oid: value}."""
    results = {}
    
    if version == "v1":
        auth_data = CommunityData(community, mpModel=0)
    else:
        auth_data = CommunityData(community, mpModel=1)

    transport = UdpTransportTarget(
        (ip, port), timeout=timeout, retries=retries
    )

    object_types = [ObjectType(ObjectIdentity(oid)) for oid in oids]

    snmp_eng = SnmpEngine()
    error_indication, error_status, error_index, var_binds = await getCmd(
        snmp_eng, auth_data, transport, ContextData(), *object_types
    )

    if error_indication:
        logger.debug(f"SNMP GET {ip}: {error_indication}")
        return results
    if error_status:
        logger.debug(f"SNMP GET {ip} error: {error_status.prettyPrint()}")
        return results

    for var_bind in var_binds:
        oid_str = str(var_bind[0])
        val = var_bind[1]
        try:
            results[oid_str] = val.prettyPrint()
        except Exception:
            results[oid_str] = str(val)

    return results


async def snmp_walk(ip: str, base_oid: str, community: str = "public",
                    version: str = "v2c", port: int = 161,
                    timeout: int = 5, max_rows: int = 50) -> Dict[str, str]:
    """Walk an OID subtree.

    pysnmp 6.x: nextCmd is a single-shot coroutine (not an async generator).
    We call it repeatedly in a manual loop, advancing the OID each time,
    until we leave the base subtree or hit max_rows.
    """
    results = {}

    if version == "v1":
        auth_data = CommunityData(community, mpModel=0)
    else:
        auth_data = CommunityData(community, mpModel=1)

    snmp_eng = SnmpEngine()
    current_oid = base_oid
    count = 0

    while count < max_rows:
        try:
            transport = UdpTransportTarget((ip, port), timeout=timeout, retries=1)
            err_ind, err_stat, err_idx, var_binds = await nextCmd(
                snmp_eng, auth_data, transport, ContextData(),
                ObjectType(ObjectIdentity(current_oid))
            )
        except Exception:
            break

        if err_ind or err_stat:
            break

        if not var_binds:
            break

        # var_binds in pysnmp 6.x is a list of lists: [[ObjectType, ...]]
        row = var_binds[0] if var_binds and isinstance(var_binds[0], list) else var_binds
        advanced = False
        # Build the subtree prefix once: "1.3.6.1.2.1.2.2.1.2" → must match "1.3.6.1.2.1.2.2.1.2."
        subtree_prefix = base_oid.rstrip('.') + '.'
        for var_bind in row:
            oid_str = str(var_bind[0])
            # Stop if we've walked outside the requested subtree
            if not oid_str.startswith(subtree_prefix):
                return results
            # Also stop if OID didn't advance (avoid infinite loop)
            if oid_str == current_oid:
                return results
            try:
                results[oid_str] = var_bind[1].prettyPrint()
            except Exception:
                results[oid_str] = str(var_bind[1])
            count += 1
            current_oid = oid_str
            advanced = True

        if not advanced:
            break

    return results


# ─── Device Discovery ─────────────────────────────────────────────────────────

async def ping_host(ip: str, timeout: float = 1.0) -> bool:
    """Quick ICMP reachability check — cross-platform (Windows & Linux/Mac)."""
    import platform
    system = platform.system().lower()
    if system == "windows":
        # -n 1 = one ping, -w = timeout in milliseconds
        cmd = ["ping", "-n", "1", "-w", str(int(timeout * 1000)), ip]
    else:
        # -c 1 = one ping, -W = timeout in seconds
        cmd = ["ping", "-c", "1", "-W", str(int(timeout)), ip]
    try:
        kwargs = {}
        if system == "windows":
            import subprocess
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            **kwargs
        )
        await asyncio.wait_for(proc.communicate(), timeout=timeout + 2)
        return proc.returncode == 0
    except Exception:
        return False


async def probe_snmp(ip: str, community: str = "public",
                     port: int = 161, timeout: int = 3) -> Optional[Dict]:
    """Try to get basic SNMP info from a host."""
    oids = [
        STANDARD_OIDS["sysDescr"],
        STANDARD_OIDS["sysObjectID"],
        STANDARD_OIDS["sysName"],
        STANDARD_OIDS["sysLocation"],
        STANDARD_OIDS["sysContact"],
        STANDARD_OIDS["sysUpTime"],
    ]
    try:
        result = await snmp_get(ip, oids, community=community, port=port, timeout=timeout)
        if result:
            return result
    except Exception as e:
        logger.debug(f"SNMP probe failed for {ip}: {e}")
    return None


def classify_device(sys_descr: str, sys_object_id: str) -> str:
    """Classify device type from sysDescr and sysObjectID."""
    if sys_descr:
        desc_lower = sys_descr.lower()
        for keyword, dtype in SYSDESCR_KEYWORDS.items():
            if keyword in desc_lower:
                return dtype

    if sys_object_id:
        for prefix, dtype in DEVICE_FINGERPRINTS.items():
            if sys_object_id.startswith(prefix):
                return dtype

    return "unknown"


async def discover_subnet(
    subnet: str,
    communities: List[str] = None,
    progress_callback: Optional[Callable] = None,
    max_concurrent: int = 50
) -> List[Dict]:
    """
    Scan a subnet for SNMP-enabled devices.
    Returns list of discovered device dicts.
    """
    if communities is None:
        communities = ["public", "private"]

    try:
        network = IPv4Network(subnet, strict=False)
    except ValueError as e:
        raise ValueError(f"Invalid subnet: {e}")

    hosts = list(network.hosts())
    total = len(hosts)
    discovered = []
    sem = asyncio.Semaphore(max_concurrent)

    async def probe_host(ip_obj, index):
        async with sem:
            ip = str(ip_obj)
            if progress_callback:
                await progress_callback(index, total, ip, "scanning")

            # Try each community string
            for community in communities:
                result = await probe_snmp(ip, community=community)
                if result:
                    sys_descr = result.get(STANDARD_OIDS["sysDescr"], "")
                    sys_obj_id = result.get(STANDARD_OIDS["sysObjectID"], "")
                    sys_name = result.get(STANDARD_OIDS["sysName"], "")
                    
                    device_type = classify_device(sys_descr, sys_obj_id)
                    
                    device_info = {
                        "ip_address": ip,
                        "device_type": device_type,
                        "sys_descr": sys_descr,
                        "sys_object_id": sys_obj_id,
                        "sys_name": sys_name,
                        "sys_location": result.get(STANDARD_OIDS["sysLocation"], ""),
                        "sys_contact": result.get(STANDARD_OIDS["sysContact"], ""),
                        "snmp_community": community,
                        "status": "online",
                        "auto_discovered": True,
                        "name": sys_name or f"Device-{ip.replace('.', '-')}",
                    }
                    discovered.append(device_info)
                    
                    if progress_callback:
                        await progress_callback(index, total, ip, "found", device_info)
                    return

            if progress_callback:
                await progress_callback(index, total, ip, "no_snmp")

    tasks = [probe_host(host, i) for i, host in enumerate(hosts)]
    await asyncio.gather(*tasks, return_exceptions=True)
    return discovered


# ─── Device Poller ────────────────────────────────────────────────────────────

async def poll_device(device: Dict) -> Dict:
    """
    Poll a single device and return metrics dict.
    Auto-adapts based on device_type.
    """
    ip = device["ip_address"]
    community = device.get("snmp_community", "public")
    device_type = device.get("device_type", "unknown")
    metrics = {"timestamp": datetime.utcnow().isoformat(), "device_id": device.get("id")}

    try:
        # Base system poll
        base_oids = [STANDARD_OIDS["sysUpTime"]]
        base_result = await snmp_get(ip, base_oids, community=community)
        
        if not base_result:
            # Fall back to ICMP ping
            is_pingable = await ping_host(ip)
            if is_pingable:
                return {**metrics, "status": "online", "notes": "Responding to ping (no SNMP response)"}
            return {**metrics, "status": "offline", "error": "No SNMP response"}

        metrics["status"] = "online"
        uptime_raw = base_result.get(STANDARD_OIDS["sysUpTime"], "0")
        try:
            metrics["uptime_seconds"] = int(uptime_raw.split("(")[1].split(")")[0]) // 100 if "(" in uptime_raw else 0
        except Exception:
            metrics["uptime_seconds"] = 0

        # CPU & Memory (HOST-RESOURCES-MIB)
        cpu_result = await snmp_walk(ip, STANDARD_OIDS["hrProcessorLoad"], community=community, max_rows=8)
        if cpu_result:
            cpu_vals = [float(v) for v in cpu_result.values() if v.isdigit()]
            if cpu_vals:
                metrics["cpu_percent"] = round(sum(cpu_vals) / len(cpu_vals), 1)

        storage_descr = await snmp_walk(ip, STANDARD_OIDS["hrStorageDescr"], community=community, max_rows=10)
        storage_used = await snmp_walk(ip, STANDARD_OIDS["hrStorageUsed"], community=community, max_rows=10)
        storage_size = await snmp_walk(ip, STANDARD_OIDS["hrStorageSize"], community=community, max_rows=10)

        for oid, raw_descr in storage_descr.items():
            idx = oid.split(".")[-1]
            descr = _decode_snmp_string(raw_descr, raw_descr).lower()
            used_oid = f"1.3.6.1.2.1.25.2.3.1.6.{idx}"
            size_oid = f"1.3.6.1.2.1.25.2.3.1.5.{idx}"
            used = int(storage_used.get(used_oid, 0) or 0)
            size = int(storage_size.get(size_oid, 1) or 1)
            if size > 0:
                pct = round((used / size) * 100, 1)
                if "ram" in descr or "memory" in descr or "physical" in descr:
                    metrics["memory_percent"] = pct
                elif "disk" in descr or descr.strip() == "/" or "c:" in descr or "d:" in descr:
                    metrics["disk_percent"] = pct

        # Interface bandwidth — only walk interfaces that the user has explicitly
        # selected for monitoring.  New devices start with no monitored interfaces
        # (ping + basic SNMP only) until the user chooses ports in the UI.
        monitored_indexes = set(
            (device.get("tags") or {}).get("monitored_interfaces", [])
        )

        interfaces = []
        if monitored_indexes:
            if_status = await snmp_walk(ip, STANDARD_OIDS["ifOperStatus"], community=community, max_rows=64)
            if_in    = await snmp_walk(ip, STANDARD_OIDS["ifInOctets"],    community=community, max_rows=64)
            if_out   = await snmp_walk(ip, STANDARD_OIDS["ifOutOctets"],   community=community, max_rows=64)
            if_descr = await snmp_walk(ip, STANDARD_OIDS["ifDescr"],       community=community, max_rows=64)

            for oid, status in if_status.items():
                idx = oid.split(".")[-1]
                if int(idx) not in monitored_indexes:
                    continue
                descr_oid = f"1.3.6.1.2.1.2.2.1.2.{idx}"
                in_oid = f"1.3.6.1.2.1.2.2.1.10.{idx}"
                out_oid = f"1.3.6.1.2.1.2.2.1.16.{idx}"
                raw_name = if_descr.get(descr_oid, f"if{idx}")
                interfaces.append({
                    "index": int(idx),
                    "name": _decode_snmp_string(raw_name, f"if{idx}"),
                    "status": "up" if status == "1" else "down",
                    "bytes_in": int(if_in.get(in_oid, 0) or 0),
                    "bytes_out": int(if_out.get(out_oid, 0) or 0),
                })
        if interfaces:
            metrics["interfaces"] = interfaces

        # Printer-specific
        if device_type == "printer":
            supply_levels = await snmp_walk(ip, STANDARD_OIDS["prtMarkerSuppliesLevel"], community=community, max_rows=10)
            supply_max = await snmp_walk(ip, STANDARD_OIDS["prtMarkerSuppliesMaxCapacity"], community=community, max_rows=10)
            supply_descr = await snmp_walk(ip, STANDARD_OIDS["prtMarkerSuppliesDescription"], community=community, max_rows=10)
            
            supplies = []
            for oid, level in supply_levels.items():
                idx_parts = oid.split(".")
                idx = ".".join(idx_parts[-2:])
                max_oid = f"1.3.6.1.2.1.43.11.1.1.8.{idx}"
                desc_oid = f"1.3.6.1.2.1.43.11.1.1.6.{idx}"
                max_val = int(supply_max.get(max_oid, 100) or 100)
                level_val = int(level or 0)
                if max_val > 0:
                    pct = round((level_val / max_val) * 100, 1)
                else:
                    pct = -1
                supplies.append({
                    "name": supply_descr.get(desc_oid, f"Supply {idx}"),
                    "level_percent": pct,
                    "level_raw": level_val,
                    "max_raw": max_val
                })
            metrics["supplies"] = supplies
            if supplies:
                toner = [s for s in supplies if "toner" in s["name"].lower() or "ink" in s["name"].lower()]
                if toner:
                    metrics["toner_percent"] = toner[0]["level_percent"]

        # RF Link specific (Ubiquiti example OIDs)
        if device_type == "rf_link":
            ubnt_signal_oid = "1.3.6.1.4.1.41112.1.4.7.1.3"  # Ubiquiti signal
            ubnt_noise_oid = "1.3.6.1.4.1.41112.1.4.7.1.4"
            ubnt_ccq_oid = "1.3.6.1.4.1.41112.1.4.7.1.13"
            
            rf_result = await snmp_get(ip, [ubnt_signal_oid + ".1", ubnt_noise_oid + ".1", ubnt_ccq_oid + ".1"], community=community)
            for oid, val in rf_result.items():
                try:
                    if ubnt_signal_oid in oid:
                        metrics["signal_dbm"] = float(val) / 10 if abs(float(val)) > 100 else float(val)
                    elif ubnt_noise_oid in oid:
                        metrics["noise_dbm"] = float(val) / 10 if abs(float(val)) > 100 else float(val)
                    elif ubnt_ccq_oid in oid:
                        metrics["ccq_percent"] = float(val)
                except Exception:
                    pass

        return metrics

    except Exception as e:
        logger.error(f"Error polling {ip}: {e}")
        return {**metrics, "status": "offline", "error": str(e)}


# ─── Ping with latency ────────────────────────────────────────────────────────

async def ping_latency(ip: str, timeout: float = 2.0) -> Optional[float]:
    """Ping a host and return round-trip latency in milliseconds, or None if unreachable."""
    import platform
    import re as _re
    system = platform.system().lower()
    if system == "windows":
        cmd = ["ping", "-n", "1", "-w", str(int(timeout * 1000)), ip]
    else:
        cmd = ["ping", "-c", "1", "-W", str(int(max(1, timeout))), ip]
    try:
        kwargs = {}
        if system == "windows":
            import subprocess
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            **kwargs
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 2)
        if proc.returncode == 0:
            output = stdout.decode()
            m = _re.search(r'time[=<](\d+\.?\d*)\s*ms', output, _re.IGNORECASE)
            if m:
                return round(float(m.group(1)), 2)
            # fallback: any number before ms
            m = _re.search(r'(\d+\.?\d+)\s*ms', output)
            if m:
                return round(float(m.group(1)), 2)
        return None
    except Exception:
        return None


# ─── Interface discovery ──────────────────────────────────────────────────────

def _decode_snmp_string(val: str, fallback: str = "") -> str:
    """Convert pysnmp OctetString hex (0x...) to a readable ASCII/UTF-8 string."""
    if not val:
        return fallback
    if val.startswith("0x"):
        try:
            raw = bytes.fromhex(val[2:])
            return raw.decode("utf-8").strip("\x00").strip() or fallback
        except Exception:
            try:
                return raw.decode("latin-1").strip("\x00").strip() or fallback
            except Exception:
                return fallback
    return val.strip() or fallback


_MAC_HEX = re.compile(r'^0x([0-9a-fA-F]{12})$', re.IGNORECASE)


def _decode_mib_value(raw: Optional[str]) -> Optional[str]:
    """Render a raw SNMP scalar from a vendor MIB table for display.

    MacAddress/PhysAddress columns (yLEthMac, yLVAPConfigMac, ...) come back
    as 6-byte hex strings (`0x0a1b2c3d4e5f`) — reformat those as colon-
    separated MACs, the form every NMS/UI expects. Other OctetStrings get the
    same hex→text decode as the standard interface walk; integers, enums, and
    already-printable text pass through untouched.
    """
    if raw is None:
        return None
    mac = _MAC_HEX.match(raw.strip())
    if mac:
        h = mac.group(1)
        return ":".join(h[i:i + 2] for i in range(0, 12, 2)).lower()
    return _decode_snmp_string(raw, raw)


async def list_device_interfaces(
    ip: str,
    community: str = "public",
    version: str = "v2c",
    port: int = 161,
    timeout: int = 5,
) -> List[Dict]:
    """Return all interfaces from a device via SNMP (index, name, status, speed)."""
    if_descr   = await snmp_walk(ip, STANDARD_OIDS["ifDescr"],    community, version, port, timeout, max_rows=64)
    if_status  = await snmp_walk(ip, STANDARD_OIDS["ifOperStatus"], community, version, port, timeout, max_rows=64)
    if_speed   = await snmp_walk(ip, "1.3.6.1.2.1.2.2.1.5",       community, version, port, timeout, max_rows=64)
    if_in      = await snmp_walk(ip, STANDARD_OIDS["ifInOctets"],  community, version, port, timeout, max_rows=64)
    if_out     = await snmp_walk(ip, STANDARD_OIDS["ifOutOctets"], community, version, port, timeout, max_rows=64)

    interfaces = []
    for oid, raw_name in if_descr.items():
        idx = oid.split(".")[-1]
        speed_raw = int(if_speed.get(f"1.3.6.1.2.1.2.2.1.5.{idx}", 0) or 0)
        name = _decode_snmp_string(raw_name, f"if{idx}")
        interfaces.append({
            "index": int(idx),
            "name": name,
            "status": "up" if if_status.get(f"1.3.6.1.2.1.2.2.1.8.{idx}", "2") == "1" else "down",
            "speed_mbps": round(speed_raw / 1_000_000, 1),
            "bytes_in":  int(if_in.get(f"1.3.6.1.2.1.2.2.1.10.{idx}", 0) or 0),
            "bytes_out": int(if_out.get(f"1.3.6.1.2.1.2.2.1.16.{idx}", 0) or 0),
        })

    return sorted(interfaces, key=lambda x: x["index"])


async def walk_mib_table(
    ip: str,
    columns: List[Dict],
    community: str = "public",
    version: str = "v2c",
    port: int = 161,
    timeout: int = 5,
    max_rows: int = 64,
) -> List[Dict]:
    """Walk a vendor-defined MIB table and return its rows keyed by column name.

    The MIB-aware counterpart to list_device_interfaces: instead of the
    hardcoded standard ifTable columns, it walks whatever column OIDs
    mib_parser.extract_port_tables found (`columns` is `[{"name": "yLEthName",
    "oid": "1.3.6.1.4.1.43265.100.1.3.2.1.1", "description": "..."}, ...]` in
    the table's declared order).

    SMIv2 table columns live at `<columnOid>.<rowIndex>` — exactly the layout
    list_device_interfaces relies on for ifTable — so each column is walked as
    its own subtree and rows are merged back together by their shared trailing
    index. Returns e.g. `[{"index": 1, "yLEthName": "eth0",
    "yLEthMac": "aa:bb:cc:dd:ee:ff", ...}, ...]`, sorted by index.
    """
    if not columns:
        return []

    walks = [
        (col, await snmp_walk(ip, col["oid"], community, version, port, timeout, max_rows=max_rows))
        for col in columns
    ]

    # A vendor table can have sparse columns (not every row reports every
    # field), so collect indexes from every column rather than trusting the
    # first one to enumerate all rows.
    indexes = set()
    for col, values in walks:
        prefix = col["oid"].rstrip(".") + "."
        for oid in values:
            suffix = oid[len(prefix):]
            if suffix.isdigit():
                indexes.add(int(suffix))

    rows = []
    for idx in sorted(indexes):
        row = {"index": idx}
        for col, values in walks:
            row[col["name"]] = _decode_mib_value(values.get(f'{col["oid"].rstrip(".")}.{idx}'))
        rows.append(row)

    return rows


# ─── Trap Listener ────────────────────────────────────────────────────────────

STANDARD_TRAP_NAMES = {
    "1.3.6.1.6.3.1.1.5.1": "coldStart",
    "1.3.6.1.6.3.1.1.5.2": "warmStart",
    "1.3.6.1.6.3.1.1.5.3": "linkDown",
    "1.3.6.1.6.3.1.1.5.4": "linkUp",
    "1.3.6.1.6.3.1.1.5.5": "authenticationFailure",
    "1.3.6.1.6.3.1.1.5.6": "egpNeighborLoss",
}

TRAP_PLAIN_ENGLISH = {
    "coldStart": "Device restarted completely (cold start)",
    "warmStart": "Device reloaded its configuration (warm start)",
    "linkDown": "A network interface went offline",
    "linkUp": "A network interface came back online",
    "authenticationFailure": "Someone tried to access this device with wrong credentials",
    "egpNeighborLoss": "Lost connection to a routing neighbor",
}

class TrapListener:
    def __init__(self, port: int = 162, callback: Optional[Callable] = None):
        self.port = port
        self.callback = callback
        self._running = False
        self._snmp_engine = None

    def _trap_receiver(self, snmp_engine, state_reference, context_engine_id,
                       context_name, var_binds, cb_ctx):
        """Called by pysnmp when a trap is received."""
        try:
            transport_domain, transport_address = snmp_engine.msgAndPduDsp.getTransportInfo(state_reference)
            source_ip = str(transport_address[0]) if transport_address else "unknown"
        except Exception:
            source_ip = "unknown"

        trap_data = {
            "source_ip": source_ip,
            "timestamp": datetime.utcnow().isoformat(),
            "snmp_version": "v2c",
            "var_binds": {},
            "trap_oid": None,
            "trap_name": None,
            "plain_english": None,
        }

        for oid, val in var_binds:
            oid_str = str(oid)
            val_str = val.prettyPrint()
            trap_data["var_binds"][oid_str] = val_str

            # snmpTrapOID (1.3.6.1.6.3.1.1.4.1.0) contains the trap OID
            if "1.3.6.1.6.3.1.1.4.1" in oid_str:
                trap_oid = val_str
                trap_data["trap_oid"] = trap_oid
                trap_name = STANDARD_TRAP_NAMES.get(trap_oid, "enterpriseSpecific")
                trap_data["trap_name"] = trap_name
                trap_data["plain_english"] = TRAP_PLAIN_ENGLISH.get(trap_name, f"Received trap: {trap_name}")

        if self.callback and trap_data["trap_oid"]:
            asyncio.create_task(self.callback(trap_data))

    async def start(self):
        """Start the SNMP trap listener (pysnmp 6.x compatible)."""
        self._running = True
        self._snmp_engine = SnmpEngine()

        try:
            port = self.port
            # Try requested port, fall back to +1000 if permission denied
            try:
                snmp_config.addTransport(
                    self._snmp_engine,
                    udp.domainName,
                    udp.UdpAsyncioTransport().openServerMode(("0.0.0.0", port))
                )
                logger.info(f"SNMP Trap listener started on UDP port {port}")
            except PermissionError:
                port = self.port + 1000
                snmp_config.addTransport(
                    self._snmp_engine,
                    udp.domainName,
                    udp.UdpAsyncioTransport().openServerMode(("0.0.0.0", port))
                )
                self.port = port
                logger.warning(f"Port {self.port - 1000} requires admin/root. Listening on {port} instead.")

            # Accept v1/v2c traps with common community strings
            for community in ("public", "private", "community"):
                try:
                    snmp_config.addV1System(self._snmp_engine, f"sentinel-{community}", community)
                except Exception:
                    pass

            ntfrcv.NotificationReceiver(self._snmp_engine, self._trap_receiver)
            self._snmp_engine.transportDispatcher.jobStarted(1)

            while self._running:
                self._snmp_engine.transportDispatcher.runDispatcher(0.1)
                await asyncio.sleep(0.01)

        except Exception as e:
            logger.error(f"Trap listener error: {e}")
            self._running = False

    async def stop(self):
        self._running = False
        if self._snmp_engine:
            try:
                self._snmp_engine.transportDispatcher.closeDispatcher()
            except Exception:
                pass
        logger.info("SNMP Trap listener stopped")


async def send_test_trap(target_ip: str, port: int = 162,
                         community: str = "public",
                         trap_oid: str = "1.3.6.1.6.3.1.1.5.1",
                         version: str = "v2c") -> Dict:
    """Send a test SNMP trap to a target."""
    from pysnmp.hlapi.asyncio import sendNotification, NotificationType

    if version == "v1":
        auth_data = CommunityData(community, mpModel=0)
    else:
        auth_data = CommunityData(community, mpModel=1)

    transport = UdpTransportTarget((target_ip, port), timeout=3, retries=1)
    snmp_eng = SnmpEngine()

    start_time = datetime.utcnow()
    try:
        error_indication, error_status, error_index, var_binds = await sendNotification(
            snmp_eng, auth_data, transport, ContextData(),
            "trap",
            NotificationType(ObjectIdentity(trap_oid))
        )
        elapsed_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

        if error_indication:
            return {"success": False, "error": str(error_indication), "elapsed_ms": elapsed_ms}
        return {
            "success": True,
            "elapsed_ms": elapsed_ms,
            "trap_oid": trap_oid,
            "trap_name": STANDARD_TRAP_NAMES.get(trap_oid, "enterpriseSpecific"),
            "target": f"{target_ip}:{port}",
            "version": version,
        }
    except Exception as e:
        elapsed_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)
        return {"success": False, "error": str(e), "elapsed_ms": elapsed_ms}
