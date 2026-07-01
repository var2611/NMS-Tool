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

from core.config import settings
MIB_DIR = Path(settings.sqlite_db_path).parent / "mibs"
try:
    MIB_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

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

        # Modern SMIv2 MIBs assign their module's own root OID via
        # `myModule MODULE-IDENTITY ... ::= { parent N }` rather than a plain
        # OBJECT IDENTIFIER — and that root is what every other OID in the
        # module chains through, so missing it means NOTHING resolves (this is
        # why real vendor MIBs were parsing to oid_count=0). Anchored to
        # start-of-line so the lazy `.*?` can't run from the `IMPORTS
        # MODULE-IDENTITY, OBJECT-TYPE, ... FROM SNMPv2-SMI` clause — that
        # mentions the same bare keyword as an imported symbol, not as a
        # declaration, and spans into whatever `::= {...}` happens to follow.
        module_identity_assignments = re.findall(
            r'^[ \t]*(\w[\w-]*)[ \t]+MODULE-IDENTITY\b.*?::=\s*\{([^}]+)\}',
            content, re.DOTALL | re.MULTILINE | re.IGNORECASE
        )

        all_assignments = oid_assignments + simple_assignments + module_identity_assignments

        # Build a name→numeric map from what we find
        name_map = {}
        for name, path in all_assignments:
            parts = path.strip().split()
            name_map[name] = parts

        # Vendor MIBs aren't always internally consistent — e.g. one real-world
        # file defines its enterprise root as `ylWiFi` but every other
        # assignment in the module chains off `yLWiFi` (capital L), a name
        # that's never actually defined. A strict-case lookup leaves the whole
        # module unresolved over a single typo, so fall back to a
        # case-insensitive match — the same leniency real MIB compilers use.
        name_map_lower = {name.lower(): name for name in name_map}

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
        known_bases_lower = {k.lower(): v for k, v in known_bases.items()}

        def resolve_path(parts, _chain=frozenset()):
            if not parts:
                return None
            base = parts[0]
            suffix = parts[1:]
            base_lower = base.lower()
            if base in known_bases:
                base_oid = known_bases[base]
            elif base_lower in known_bases_lower:
                base_oid = known_bases_lower[base_lower]
            else:
                canonical = base if base in name_map else name_map_lower.get(base_lower)
                if canonical is None or canonical in _chain:
                    return None  # unknown base, or a circular reference
                resolved = resolve_path(name_map[canonical], _chain | {canonical})
                if not resolved:
                    return None
                base_oid = resolved

            num_parts = [p for p in suffix if p.isdigit()]
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


# ─── Table-aware parsing — vendor port/interface discovery ───────────────────
#
# The regex parser above only builds a flat {oid: name} map, which is enough to
# label individual values but can't tell us "this group of OIDs forms a table
# of ports". Vendor MIBs that expose per-port data (e.g. YLWIFI-MIB's Ethernet/
# radio/VAP tables) describe each row's shape with the standard SMIv2 idiom:
#
#   yLEthTable OBJECT-TYPE       SYNTAX SEQUENCE OF YLEthEntry ...
#   yLEthEntry OBJECT-TYPE       SYNTAX YLEthEntry  INDEX { ifIndex } ...
#   YLEthEntry ::= SEQUENCE { yLEthName OCTET STRING, yLEthMac MacAddress, ... }
#   yLEthName  OBJECT-TYPE ... ::= { yLEthEntry 1 }
#   yLEthMac   OBJECT-TYPE ... ::= { yLEthEntry 2 }
#
# extract_port_tables() finds the `Xxx ::= SEQUENCE {...}` row definitions,
# resolves each column name to its numeric OID via the flat map already built
# by parse(), and keeps only the tables that "look like" interfaces/ports —
# i.e. they pair a name-ish column with a status/identity-ish column, the same
# shape as the standard ifTable (ifDescr + ifOperStatus).

_SEQUENCE_PATTERN = re.compile(r'(\w[\w-]*)\s*::=\s*SEQUENCE\s*\{([^}]*)\}', re.DOTALL)

_NAME_HINT   = re.compile(r'(?i)(name|descr|ssid|ifname|hostname)')
_STATUS_HINT = re.compile(r'(?i)(status|state|oper|enable|conn|admin)')
_IDENT_HINT  = re.compile(r'(?i)(mac|address|speed|rate|channel|freq|signal|rssi|port|radio|vlan|mtu)')
_TABLE_HINT  = re.compile(r'(?i)(eth|radio|vap|wlan|wifi|port|interface|repeater|link)')


def _sequence_fields(block: str) -> List[str]:
    """Pull ordered column names out of a `Xxx ::= SEQUENCE { name Type, ... }` body."""
    fields = []
    for segment in block.split(","):
        m = re.match(r'\s*(\w[\w-]*)', segment.strip())
        if m:
            fields.append(m.group(1))
    return fields


def _looks_like_port_table(entry_type: str, columns: List[Dict]) -> bool:
    """Heuristic: does this row shape resemble an interface/port (à la ifTable)?

    The row-type's own name must hint at being port/radio/link-ish first —
    that's what separates `yLEthEntry` from e.g. `yLSysConfigEntry`, whose
    columns (yLSysName, yLSysConfigTimeRebootEnable, ...) can otherwise trip
    the same "has a name-ish column + has an enable/status flag" pattern that
    genuine port tables show. Within a hinted table, require a name-ish column
    (yLEthName, yLVAPConfigIfname, ...) plus either a status-ish column
    (yLEthState, yLVAPConfigEnable, ...) or an identity-ish one (Mac, Channel,
    Speed, ...).
    """
    if not _TABLE_HINT.search(entry_type):
        return False
    names = [c["name"] for c in columns]
    has_name   = any(_NAME_HINT.search(n) for n in names)
    has_status = any(_STATUS_HINT.search(n) for n in names)
    has_ident  = any(_IDENT_HINT.search(n) for n in names)
    return has_name and (has_status or has_ident)


def extract_port_tables(content: str, parsed_oids: Dict[str, Dict]) -> List[Dict]:
    """Detect vendor-defined interface/port tables inside a MIB's source text.

    Returns a list of `{"table": "YLEthEntry", "columns": [{name, oid, description}]}`
    — one entry per detected port-like table, columns in declaration order so
    the first SNMP walk naturally aligns with the MIB's own row layout.
    """
    name_to_oid = {info["name"]: oid for oid, info in parsed_oids.items()}

    tables = []
    for entry_type, block in _SEQUENCE_PATTERN.findall(content):
        if not entry_type.endswith(("Entry", "ENTRY")):
            continue
        columns = []
        for fname in _sequence_fields(block):
            oid = name_to_oid.get(fname)
            if not oid:
                continue
            info = parsed_oids[oid]
            columns.append({"name": fname, "oid": oid, "description": info.get("description", "")})
        if len(columns) < 2:
            continue
        if _looks_like_port_table(entry_type, columns):
            tables.append({"table": entry_type, "columns": columns})

    return tables


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


def decode_mib_bytes(data: bytes) -> str:
    """Decode raw MIB file bytes, tolerating non-UTF-8 vendor encodings.

    Most MIBs are plain ASCII/UTF-8, but some vendors (e.g. Chinese hardware
    makers) ship MIBs in GB18030. Force-decoding those as UTF-8 with
    `errors="ignore"` leaves the (pure-ASCII) OID structure intact but turns
    every DESCRIPTION string into gibberish — the file "loads" but every
    label reads as garbage. Try strict UTF-8 first (so well-formed files are
    untouched), then GB18030, then fall back to Latin-1, which never raises.
    """
    for encoding in ("utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="ignore")


async def save_mib_file(filename: str, content: bytes) -> Tuple[str, Dict]:
    """Save an uploaded MIB file and parse it."""
    mib_path = MIB_DIR / filename
    with open(mib_path, "wb") as f:
        f.write(content)

    parser = MibParser()
    text = decode_mib_bytes(content)
    result = parser.parse(text, filename)
    load_mib_into_memory(result["oids"])

    return str(mib_path), result


def load_all_saved_mibs():
    """Load all saved MIB files on startup."""
    # Copy from root preloaded mibs directory if exists
    preloaded_dir = Path("./mibs")
    if preloaded_dir.exists() and preloaded_dir.is_dir():
        import shutil
        for mib_file in preloaded_dir.glob("*"):
            if mib_file.is_file() and mib_file.suffix.lower() in (".mib", ".my", ".txt"):
                dest = MIB_DIR / mib_file.name
                if not dest.exists():
                    try:
                        shutil.copy2(mib_file, dest)
                        logger.info(f"Preloaded MIB copied: {mib_file.name}")
                    except Exception as e:
                        logger.warning(f"Could not copy preloaded MIB {mib_file.name}: {e}")

    parser = MibParser()
    count = 0
    for pattern in ("*.mib", "*.my", "*.txt"):
        for mib_file in MIB_DIR.glob(pattern):
            try:
                text = decode_mib_bytes(mib_file.read_bytes())
                result = parser.parse(text, mib_file.name)
                load_mib_into_memory(result["oids"])
                count += 1
            except Exception as e:
                logger.warning(f"Could not load MIB {mib_file.name}: {e}")
    logger.info(f"Loaded {count} MIB files from disk")


async def sync_mibs_to_db():
    """Ensure every MIB file on disk is registered in the database MibFile table."""
    from core.database import AsyncSessionLocal, MibFile
    from sqlalchemy import select

    parser = MibParser()
    async with AsyncSessionLocal() as session:
        for pattern in ("*.mib", "*.my", "*.txt"):
            for mib_file in MIB_DIR.glob(pattern):
                filename = mib_file.name
                if filename.lower() == "readme.md":
                    continue

                try:
                    # Check if already registered
                    existing = await session.execute(
                        select(MibFile).where(MibFile.filename == filename)
                    )
                    mib_record = existing.scalar_one_or_none()

                    if not mib_record:
                        content = mib_file.read_bytes()
                        text = decode_mib_bytes(content)
                        parse_result = parser.parse(text, filename)

                        # Skip registering if it parsed 0 OIDs
                        if parse_result["oid_count"] == 0:
                            continue

                        mib_record = MibFile(
                            name=parse_result["module_name"],
                            filename=filename,
                            file_path=str(mib_file),
                            file_size=len(content),
                            oid_count=parse_result["oid_count"],
                            parsed_oids={k: v for k, v in list(parse_result["oids"].items())[:100]},
                            is_standard=False,
                            is_enabled=True,
                        )
                        session.add(mib_record)
                        logger.info(f"Registered preloaded MIB to DB: {filename}")
                except Exception as e:
                    logger.warning(f"Could not register preloaded MIB {filename}: {e}")
        await session.commit()
