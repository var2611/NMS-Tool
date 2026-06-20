"""
SNMP Engine Stub — Server Version
Active operations (polling, trap listening, subnet discovery, pinging) are disabled
on server instances. This file exposes the expected interfaces as no-ops.
"""
import logging
from datetime import datetime
from typing import Optional, Callable, Dict, Any, List

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
    "prtMarkerSuppliesLevel":    "1.3.6.1.2.1.43.11.1.1.9",
    "prtMarkerSuppliesMaxCapacity": "1.3.6.1.2.1.43.11.1.1.8",
    "prtMarkerSuppliesDescription": "1.3.6.1.2.1.43.11.1.1.6",
    "prtGeneralPrinterName":    "1.3.6.1.2.1.43.5.1.1.16",
}

DEVICE_FINGERPRINTS = {
    "1.3.6.1.4.1.11": "printer",
    "1.3.6.1.4.1.253": "printer",
    "1.3.6.1.4.1.367": "printer",
    "1.3.6.1.4.1.2435": "printer",
    "1.3.6.1.4.1.1602": "printer",
    "1.3.6.1.4.1.10002": "rf_link",
    "1.3.6.1.4.1.17713": "rf_link",
    "1.3.6.1.4.1.161": "rf_link",
    "1.3.6.1.4.1.9": "router",
    "1.3.6.1.4.1.11863": "router",
    "1.3.6.1.4.1.14988": "router",
    "1.3.6.1.4.1.4526": "router",
    "1.3.6.1.4.1.311": "pc",
    "1.3.6.1.4.1.8072": "pc",
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

STANDARD_TRAP_NAMES = {
    "1.3.6.1.6.3.1.1.5.1": "coldStart",
    "1.3.6.1.6.3.1.1.5.2": "warmStart",
    "1.3.6.1.6.3.1.1.5.3": "linkDown",
    "1.3.6.1.6.3.1.1.5.4": "linkUp",
    "1.3.6.1.6.3.1.1.5.5": "authenticationFailure",
    "1.3.6.1.6.3.1.1.5.6": "egpNeighborLoss",
}


async def snmp_get(ip: str, oids: List[str], community: str = "public",
                   version: str = "v2c", port: int = 161,
                   timeout: int = 5, retries: int = 1) -> Dict[str, Any]:
    logger.info(f"snmp_get called on server instance for IP {ip} - no-op")
    return {}


async def snmp_walk(ip: str, base_oid: str, community: str = "public",
                    version: str = "v2c", port: int = 161,
                    timeout: int = 5, max_rows: int = 50) -> Dict[str, str]:
    logger.info(f"snmp_walk called on server instance for IP {ip} - no-op")
    return {}


async def ping_host(ip: str, timeout: float = 1.0) -> bool:
    logger.info(f"ping_host called on server instance for IP {ip} - no-op")
    return False


async def probe_snmp(ip: str, community: str = "public",
                     port: int = 161, timeout: int = 3) -> Optional[Dict]:
    return None


def classify_device(sys_descr: str, sys_object_id: str) -> str:
    return "unknown"


async def discover_subnet(
    subnet: str,
    communities: List[str] = None,
    progress_callback: Optional[Callable] = None,
    max_concurrent: int = 50
) -> List[Dict]:
    logger.info(f"discover_subnet called on server instance for subnet {subnet} - no-op")
    return []


async def poll_device(device: Dict) -> Dict:
    logger.info(f"poll_device called on server instance for device {device.get('ip_address')} - no-op")
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "device_id": device.get("id"),
        "status": "offline",
        "error": "Active polling is disabled on server instances."
    }


async def ping_latency(ip: str, timeout: float = 2.0) -> Optional[float]:
    logger.info(f"ping_latency called on server instance for IP {ip} - no-op")
    return None


def _decode_snmp_string(val: str, fallback: str = "") -> str:
    return val


def _decode_mib_value(raw: Optional[str]) -> Optional[str]:
    return raw


async def list_device_interfaces(
    ip: str,
    community: str = "public",
    version: str = "v2c",
    port: int = 161,
    timeout: int = 5,
) -> List[Dict]:
    logger.info(f"list_device_interfaces called on server instance for IP {ip} - no-op")
    return []


async def walk_mib_table(
    ip: str,
    columns: List[Dict],
    community: str = "public",
    version: str = "v2c",
    port: int = 161,
    timeout: int = 5,
    max_rows: int = 64,
) -> List[Dict]:
    logger.info(f"walk_mib_table called on server instance for IP {ip} - no-op")
    return []


class TrapListener:
    def __init__(self, port: int = 162, callback: Optional[Callable] = None):
        self.port = port
        self.callback = callback
        self._running = False

    async def start(self):
        logger.info("TrapListener.start called on server instance - no-op")
        self._running = True

    async def stop(self):
        logger.info("TrapListener.stop called on server instance - no-op")
        self._running = False


async def send_test_trap(target_ip: str, port: int = 162,
                         community: str = "public",
                         trap_oid: str = "1.3.6.1.6.3.1.1.5.1",
                         version: str = "v2c") -> Dict:
    return {"success": False, "error": "Active trap transmission is disabled on server instances."}
