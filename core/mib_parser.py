"""
MIB Parser — Import, parse, and manage MIB files
Resolves OIDs to human-readable names/descriptions
"""
import os
import re
import logging
from pathlib import Path
from typing import Dict, Optional, List, Tuple

logger = logging.getLogger(__name__)

MIB_DIR = Path("./data/mibs")
MIB_DIR.mkdir(parents=True, exist_ok=True)

# Built-in OID knowledge base (common OIDs → friendly names)
BUILTIN_OID_MAP: Dict[str, Dict] = {
    "1.3.6.1.2.1.1.1.0": {"name": "sysDescr", "description": "System description", "unit": ""},
    "1.3.6.1.2.1.1.2.0": {"name": "sysObjectID", "description": "System object identifier", "unit": ""},
    "1.3.6.1.2.1.1.3.0": {"name": "sysUpTime", "description": "System uptime", "unit": "timeticks"},
    "1.3.6.1.2.1.1.4.0": {"name": "sysContact", "description": "Contact person", "unit": ""},
    "1.3.6.1.2.1.1.5.0": {"name": "sysName", "description": "Device hostname", "unit": ""},
    "1.3.6.1.2.1.1.6.0": {"name": "sysLocation", "description": "Physical location", "unit": ""},
    "1.3.6.1.2.1.2.1.0": {"name": "ifNumber", "description": "Number of interfaces", "unit": ""},
    "1.3.6.1.2.1.2.2.1.2": {"name": "ifDescr", "description": "Interface description", "unit": ""},
    "1.3.6.1.2.1.2.2.1.8": {"name": "ifOperStatus", "description": "Interface operational status", "unit": ""},
    "1.3.6.1.2.1.2.2.1.10": {"name": "ifInOctets", "description": "Bytes received", "unit": "bytes"},
    "1.3.6.1.2.1.2.2.1.16": {"name": "ifOutOctets", "description": "Bytes sent", "unit": "bytes"},
    "1.3.6.1.2.1.25.3.3.1.2": {"name": "hrProcessorLoad", "description": "CPU usage", "unit": "%"},
    "1.3.6.1.2.1.25.2.3.1.3": {"name": "hrStorageDescr", "description": "Storage description", "unit": ""},
    "1.3.6.1.2.1.25.2.3.1.5": {"name": "hrStorageSize", "description": "Storage total size", "unit": "KB"},
    "1.3.6.1.2.1.25.2.3.1.6": {"name": "hrStorageUsed", "description": "Storage used", "unit": "KB"},
    "1.3.6.1.2.1.43.11.1.1.6": {"name": "prtMarkerSuppliesDescription", "description": "Supply name (toner/ink)", "unit": ""},
    "1.3.6.1.2.1.43.11.1.1.8": {"name": "prtMarkerSuppliesMaxCapacity", "description": "Supply max capacity", "unit": ""},
    "1.3.6.1.2.1.43.11.1.1.9": {"name": "prtMarkerSuppliesLevel", "description": "Supply current level", "unit": ""},
    # Trap OIDs
    "1.3.6.1.6.3.1.1.5.1": {"name": "coldStart", "description": "Device performed a cold start", "unit": ""},
    "1.3.6.1.6.3.1.1.5.2": {"name": "warmStart", "description": "Device performed a warm start", "unit": ""},
    "1.3.6.1.6.3.1.1.5.3": {"name": "linkDown", "description": "A network interface went down", "unit": ""},
    "1.3.6.1.6.3.1.1.5.4": {"name": "linkUp", "description": "A network interface came back up", "unit": ""},
    "1.3.6.1.6.3.1.1.5.5": {"name": "authenticationFailure", "description": "SNMP authentication failure", "unit": ""},
}

# In-memory OID map (merged builtin + parsed MIBs)
_oid_map: Dict[str, Dict] = dict(BUILTIN_OID_MAP)


def resolve_oid(oid: str) -> Dict:
    """Resolve an OID to its name and description."""
    # Exact match
    if oid in _oid_map:
        return _oid_map[oid]
    
    # Prefix match (for table OIDs like 1.3.6.1.2.1.2.2.1.2.1)
    parts = oid.split(".")
    for i in range(len(parts), 0, -1):
        prefix = ".".join(parts[:i])
        if prefix in _oid_map:
            entry = dict(_oid_map[prefix])
            entry["index"] = ".".join(parts[i:])
            return entry
    
    return {"name": oid, "description": "Unknown OID", "unit": ""}


def oid_to_friendly(oid: str) -> str:
    """Get just the friendly name for an OID."""
    return resolve_oid(oid).get("name", oid)


class MibParser:
    """Parse .mib / .my / .txt MIB files and extract OID definitions."""

    OID_PATTERN = re.compile(
        r'(\w[\w-]*)\s+OBJECT(?:-TYPE|IDENTIFIER)\s+.*?::=\s*\{([^}]+)\}',
        re.DOTALL | re.IGNORECASE
    )
    DESC_PATTERN = re.compile(r'DESCRIPTION\s+"([^"]*)"', re.DOTALL)
    UNITS_PATTERN = re.compile(r'UNITS\s+"([^"]*)"')
    
    # Module name
    MODULE_PATTERN = re.compile(r'^(\S+)\s+DEFINITIONS\s*(?:::=)?\s*BEGIN', re.MULTILINE)

    def parse(self, content: str, filename: str = "") -> Dict:
        """
        Parse a MIB file content and return structured data.
        Returns: {module_name, oids: [{oid, name, description, unit}], raw_count}
        """
        module_name = filename.replace(".mib", "").replace(".my", "").replace(".txt", "")
        
        match = self.MODULE_PATTERN.search(content)
        if match:
            module_name = match.group(1)

        parsed_oids = {}
        
        # Simple line-by-line OID extraction
        oid_assignments = re.findall(
            r'(\w[\w-]*)\s+OBJECT[- ](?:TYPE|IDENTIFIER)\s*(?:.*?)?::=\s*\{([^}]+)\}',
            content, re.DOTALL | re.IGNORECASE
        )
        
        # Also catch plain assignments like: myObj OBJECT IDENTIFIER ::= { enterprises 12345 }
        simple_assignments = re.findall(
            r'(\w[\w-]*)\s+OBJECT\s+IDENTIFIER\s*::=\s*\{([^}]+)\}',
            content, re.IGNORECASE
        )
        
        all_assignments = oid_assignments + simple_assignments

        # Build a name→numeric map from what we find
        name_map = {}
        for name, path in all_assignments:
            parts = path.strip().split()
            name_map[name] = parts

        # Resolve to numeric OIDs
        known_bases = {
            "iso": "1",
            "org": "1.3",
            "dod": "1.3.6",
            "internet": "1.3.6.1",
            "mgmt": "1.3.6.1.2",
            "mib-2": "1.3.6.1.2.1",
            "enterprises": "1.3.6.1.4.1",
            "experimental": "1.3.6.1.3",
            "private": "1.3.6.1.4",
        }

        def resolve_path(parts):
            if not parts:
                return None
            base = parts[0]
            suffix = parts[1:]
            if base in known_bases:
                base_oid = known_bases[base]
            elif base in name_map:
                resolved = resolve_path(name_map[base])
                if not resolved:
                    return None
                base_oid = resolved
            else:
                return None
            
            num_parts = []
            for p in suffix:
                if p.isdigit():
                    num_parts.append(p)
                elif p in known_bases:
                    pass  # skip
            return base_oid + ("." + ".".join(num_parts) if num_parts else "")

        # Extract descriptions
        desc_blocks = re.findall(
            r'(\w[\w-]*)\s+OBJECT-TYPE.*?DESCRIPTION\s+"([^"]*)".*?::=\s*\{([^}]+)\}',
            content, re.DOTALL | re.IGNORECASE
        )
        desc_map = {name: desc for name, desc, _ in desc_blocks}
        unit_blocks = re.findall(r'(\w[\w-]*)\s+OBJECT-TYPE.*?UNITS\s+"([^"]*)"', content, re.DOTALL | re.IGNORECASE)
        unit_map = {name: unit for name, unit in unit_blocks}

        for name, parts in name_map.items():
            numeric = resolve_path(parts)
            if numeric and re.match(r'^[\d.]+$', numeric):
                parsed_oids[numeric] = {
                    "name": name,
                    "description": desc_map.get(name, "").strip()[:300],
                    "unit": unit_map.get(name, ""),
                }

        return {
            "module_name": module_name,
            "oids": parsed_oids,
            "oid_count": len(parsed_oids),
        }


def load_mib_into_memory(parsed_oids: Dict[str, Dict]):
    """Add parsed OIDs to the in-memory map."""
    global _oid_map
    _oid_map.update(parsed_oids)
    logger.info(f"Loaded {len(parsed_oids)} OIDs into memory map (total: {len(_oid_map)})")


def get_all_oids() -> Dict[str, Dict]:
    return dict(_oid_map)


def search_oids(query: str) -> List[Dict]:
    """Search OIDs by name or description."""
    query_lower = query.lower()
    results = []
    for oid, info in _oid_map.items():
        if (query_lower in info.get("name", "").lower() or
                query_lower in info.get("description", "").lower() or
                query in oid):
            results.append({"oid": oid, **info})
    return results[:50]


async def save_mib_file(filename: str, content: bytes) -> Tuple[str, Dict]:
    """Save an uploaded MIB file and parse it."""
    mib_path = MIB_DIR / filename
    with open(mib_path, "wb") as f:
        f.write(content)
    
    parser = MibParser()
    text = content.decode("utf-8", errors="ignore")
    result = parser.parse(text, filename)
    load_mib_into_memory(result["oids"])
    
    return str(mib_path), result


def load_all_saved_mibs():
    """Load all saved MIB files on startup."""
    parser = MibParser()
    count = 0
    for mib_file in MIB_DIR.glob("*.mib"):
        try:
            text = mib_file.read_text(errors="ignore")
            result = parser.parse(text, mib_file.name)
            load_mib_into_memory(result["oids"])
            count += 1
        except Exception as e:
            logger.warning(f"Could not load MIB {mib_file.name}: {e}")
    for mib_file in MIB_DIR.glob("*.my"):
        try:
            text = mib_file.read_text(errors="ignore")
            result = parser.parse(text, mib_file.name)
            load_mib_into_memory(result["oids"])
            count += 1
        except Exception as e:
            logger.warning(f"Could not load MIB {mib_file.name}: {e}")
    logger.info(f"Loaded {count} MIB files from disk")
