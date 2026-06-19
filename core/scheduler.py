"""
Scheduler — Manages background polling tasks for all devices
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Set, Optional
from core.snmp_engine import poll_device, ping_latency
from core.alert_engine import evaluate_metrics, broadcast_ws
from core.database import AsyncSessionLocal, Device, DeviceMetric, DeviceStatus, SystemSetting
from core.sync_agent import sync_agent, device_sync_payload
from core.mib_metrics import collect_monitored_mib_metrics
from sqlalchemy import select, delete

logger = logging.getLogger(__name__)


class PollingScheduler:
    def __init__(self):
        self._running = False
        self._tasks: Dict[int, asyncio.Task] = {}
        self._poll_intervals: Dict[int, int] = {}
        # Previous bytes readings for bandwidth delta computation
        # {device_id: {iface_index: {bytes_in, bytes_out, timestamp}}}
        self._prev_bytes: Dict[int, Dict[int, Dict]] = {}

    async def start(self, poll: bool = True):
        self._running = True
        logger.info("Polling scheduler started")
        if poll:
            asyncio.create_task(self._manage_poll_tasks())
        asyncio.create_task(self._metrics_pruner())

    async def stop(self):
        self._running = False
        for task in self._tasks.values():
            task.cancel()
        logger.info("Polling scheduler stopped")

    async def _get_global_poll_interval(self) -> int:
        """Read global poll interval from DB SystemSetting, fallback to default 5."""
        try:
            async with AsyncSessionLocal() as session:
                row = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "poll_interval")
                )
                setting = row.scalar_one_or_none()
                if setting and setting.value:
                    return max(1, min(15, int(setting.value)))
        except Exception:
            pass
        return 5

    async def _get_snmp_timeout(self) -> int:
        """Read SNMP timeout from DB SystemSetting, fallback to config default."""
        try:
            async with AsyncSessionLocal() as session:
                row = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "snmp_timeout")
                )
                setting = row.scalar_one_or_none()
                if setting and setting.value:
                    return max(2, min(15, int(setting.value)))
        except Exception:
            pass
        from core.config import settings
        return settings.snmp_timeout

    async def _manage_poll_tasks(self):
        """Periodically sync polling tasks with DB device list.

        Devices with source='desktop_sync' are EXCLUDED from server-side SNMP
        polling. Their status and metrics arrive exclusively through the sync
        channel from the owning desktop agent. Polling them from the server
        would:
          • create conflicts if the server can't reach that LAN
          • overwrite live metrics from the desktop with stale/wrong values
          • double-count data and generate spurious alerts
        """
        while self._running:
            try:
                from core.config import settings
                is_desktop = settings.is_desktop
                global_interval = 5
                if is_desktop:
                    global_interval = await self._get_global_poll_interval()

                async with AsyncSessionLocal() as session:
                    result = await session.execute(
                        select(Device).where(
                            Device.is_active == True,
                            # Only poll locally-owned devices
                            (Device.source != "desktop_sync") | (Device.source == None),
                        )
                    )
                    devices = result.scalars().all()

                    current_ids: Set[int] = set()
                    for device in devices:
                        current_ids.add(device.id)
                        
                        if is_desktop:
                            interval = global_interval
                        else:
                            interval = device.poll_interval or 300

                        existing_task = self._tasks.get(device.id)
                        existing_interval = self._poll_intervals.get(device.id)

                        if existing_task is None or existing_task.done() or existing_interval != interval:
                            if existing_task and not existing_task.done():
                                logger.info(f"Interval changed for device {device.id} from {existing_interval}s to {interval}s. Restarting task.")
                                existing_task.cancel()
                            
                            self._poll_intervals[device.id] = interval
                            self._tasks[device.id] = asyncio.create_task(
                                self._poll_device_loop(device.id, interval)
                            )

                    for device_id in list(self._tasks.keys()):
                        if device_id not in current_ids:
                            self._tasks[device_id].cancel()
                            del self._tasks[device_id]
                            if device_id in self._poll_intervals:
                                del self._poll_intervals[device_id]

            except Exception as e:
                logger.error(f"Scheduler manage error: {e}")

            await asyncio.sleep(10)

    async def _poll_device_loop(self, device_id: int, interval: int):
        """Continuously poll a single device at its configured interval."""
        while self._running:
            try:
                await self._poll_once(device_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Poll error device {device_id}: {e}")
            await asyncio.sleep(interval)

    async def _poll_once(self, device_id: int):
        """Poll a device once — SNMP + ping — and save results."""
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Device).where(Device.id == device_id)
            )
            device = result.scalar_one_or_none()
            if not device:
                return

            snmp_timeout = await self._get_snmp_timeout()

            monitored_ifaces = []
            if device.tags and "monitored_interfaces" in device.tags:
                monitored_ifaces = device.tags["monitored_interfaces"]  # list of int indexes

            device_dict = {
                "id": device.id,
                "ip_address": device.ip_address,
                "snmp_community": device.snmp_community,
                "snmp_version": device.snmp_version.value if device.snmp_version else "v2c",
                "device_type": device.device_type.value if device.device_type else "unknown",
                "snmp_port": device.snmp_port or 161,
                "name": device.name,
                "snmp_timeout": snmp_timeout,
            }

        # ── Ping for latency ────────────────────────────────────────────────
        ping_ms: Optional[float] = await ping_latency(device_dict["ip_address"], timeout=2.0)

        # ── SNMP poll ───────────────────────────────────────────────────────
        metrics = await poll_device(device_dict)

        # ── Per-interface bandwidth delta ───────────────────────────────────
        now = datetime.utcnow()
        iface_metrics: Dict[int, Dict] = {}

        raw_interfaces = metrics.get("interfaces", [])

        # Track only what the user selected, or fall back to "up" interfaces only
        # (avoids storing 30+ inactive Windows adapters on every poll)
        if monitored_ifaces:
            tracked = [i for i in raw_interfaces if i.get("index") in monitored_ifaces]
        else:
            tracked = [i for i in raw_interfaces if i.get("status") == "up"]
        # Always include at least the first up interface even if no selection
        if not tracked and raw_interfaces:
            tracked = [raw_interfaces[0]]

        for iface in tracked:
            idx = iface.get("index")
            if idx is None:
                # Fallback: use position as index
                try:
                    idx = int(iface.get("name", "").lstrip("if") or 0)
                except Exception:
                    idx = raw_interfaces.index(iface) + 1

            cur_in  = iface.get("bytes_in", 0) or 0
            cur_out = iface.get("bytes_out", 0) or 0

            in_mbps: Optional[float]  = None
            out_mbps: Optional[float] = None

            prev = self._prev_bytes.get(device_id, {}).get(idx)
            if prev:
                elapsed = (now - prev["ts"]).total_seconds()
                if elapsed > 0 and cur_in >= prev["in"] and cur_out >= prev["out"]:
                    in_mbps  = round((cur_in  - prev["in"])  / elapsed / 125_000, 3)
                    out_mbps = round((cur_out - prev["out"]) / elapsed / 125_000, 3)

            # Store for next cycle
            if device_id not in self._prev_bytes:
                self._prev_bytes[device_id] = {}
            self._prev_bytes[device_id][idx] = {
                "in": cur_in, "out": cur_out, "ts": now
            }

            iface_metrics[idx] = {
                "name":     iface.get("name", f"if{idx}"),
                "status":   iface.get("status", "unknown"),
                "in_mbps":  in_mbps,
                "out_mbps": out_mbps,
                "bytes_in":  cur_in,
                "bytes_out": cur_out,
            }

        async with AsyncSessionLocal() as session:
            result = await session.execute(select(Device).where(Device.id == device_id))
            device = result.scalar_one_or_none()
            if not device:
                return

            # Update device status
            new_status = metrics.get("status", "unknown")
            if new_status == "online":
                device.status = DeviceStatus.online
                device.consecutive_failures = 0
                device.last_seen = now
                if metrics.get("uptime_seconds"):
                    device.uptime_seconds = metrics["uptime_seconds"]
            elif new_status == "offline":
                device.consecutive_failures = (device.consecutive_failures or 0) + 1
                if device.consecutive_failures >= 3:
                    device.status = DeviceStatus.offline
                elif device.consecutive_failures >= 1:
                    device.status = DeviceStatus.warning

            device.last_polled = now

            # Build custom_metrics: ping + all interface data
            custom: Dict = {}
            if ping_ms is not None:
                custom["ping_ms"] = ping_ms
            if iface_metrics:
                custom["interfaces"] = iface_metrics

            if device.mib_id and (device.tags or {}).get("monitored_mib_metrics"):
                try:
                    mib_metrics = await collect_monitored_mib_metrics(device, session)
                    if mib_metrics:
                        custom["mib_metrics"] = mib_metrics
                except Exception as e:
                    logger.warning(f"MIB metric collection failed for device #{device_id}: {e}")

            # Save metric snapshot
            metric_row = DeviceMetric(
                device_id=device_id,
                cpu_percent=metrics.get("cpu_percent"),
                memory_percent=metrics.get("memory_percent"),
                disk_percent=metrics.get("disk_percent"),
                signal_dbm=metrics.get("signal_dbm"),
                noise_dbm=metrics.get("noise_dbm"),
                ccq_percent=metrics.get("ccq_percent"),
                toner_percent=metrics.get("toner_percent"),
                custom_metrics=custom if custom else None,
            )

            # First monitored interface (or first available) → legacy bandwidth columns
            target_ifaces = (
                [iface_metrics[i] for i in sorted(monitored_ifaces) if i in iface_metrics]
                or list(iface_metrics.values())
            )
            if target_ifaces:
                primary = target_ifaces[0]
                metric_row.interface_name = primary.get("name")
                metric_row.bytes_in       = primary.get("bytes_in")
                metric_row.bytes_out      = primary.get("bytes_out")
                if primary.get("in_mbps") is not None:
                    metric_row.bandwidth_in_mbps  = primary["in_mbps"]
                    metric_row.bandwidth_out_mbps = primary["out_mbps"]

            session.add(metric_row)

            device_dict_for_eval = {"id": device.id, "name": device.name}
            await evaluate_metrics(device_dict_for_eval, metrics, session)

            await session.commit()

        # Broadcast update
        await broadcast_ws("device_update", {
            "device_id": device_id,
            "status": new_status,
            "ping_ms": ping_ms,
            "metrics": {k: v for k, v in metrics.items() if k not in ("interfaces", "supplies")},
        })

        # Queue for cloud sync (desktop mode only — sync_agent.enabled is False on server)
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(Device).where(Device.id == device_id))
            dev = result.scalar_one_or_none()
            if dev:
                device_payload = await device_sync_payload(dev, session, status=new_status)
                device_payload["uptime_seconds"] = metrics.get("uptime_seconds")
                await sync_agent.queue_entity("device", device_id, "update", device_payload)

        # Queue metric snapshot for sync
        metric_payload = {
            "ip_address":          device_dict.get("ip_address"),
            "timestamp":           now.isoformat(),
            "cpu_percent":         metrics.get("cpu_percent"),
            "memory_percent":      metrics.get("memory_percent"),
            "disk_percent":        metrics.get("disk_percent"),
            "bandwidth_in_mbps":   metrics.get("bandwidth_in_mbps"),
            "bandwidth_out_mbps":  metrics.get("bandwidth_out_mbps"),
            "signal_dbm":          metrics.get("signal_dbm"),
            "ccq_percent":         metrics.get("ccq_percent"),
            "custom_metrics":      {**(custom if custom else {}), "ping_ms": ping_ms},
        }
        await sync_agent.queue_entity("metric", device_id, "create", metric_payload)

    async def _metrics_pruner(self):
        """Clean up database storage. Runs once per day."""
        while self._running:
            try:
                from core.database import SyncStatus, SyncQueue, Alert, AlertSeverity, AlertStatus
                from sqlalchemy import func, select

                now = datetime.utcnow()
                cutoff_30d = now - timedelta(days=30)
                cutoff_24h = now - timedelta(hours=24)

                async with AsyncSessionLocal() as session:
                    # 1. Safe Pruning: delete synced metrics older than 30 days
                    result = await session.execute(
                        delete(DeviceMetric).where(
                            DeviceMetric.timestamp < cutoff_30d,
                            DeviceMetric.sync_status == SyncStatus.synced
                        )
                    )
                    deleted_metrics = result.rowcount

                    # 2. Sync Queue Pruning: delete synced queue items older than 24 hours
                    result_queue = await session.execute(
                        delete(SyncQueue).where(
                            SyncQueue.created_at < cutoff_24h,
                            SyncQueue.status == SyncStatus.synced
                        )
                    )
                    deleted_queue = result_queue.rowcount

                    # Log safe deletes
                    if deleted_metrics or deleted_queue:
                        logger.info(
                            f"Pruner: Deleted {deleted_metrics} synced metrics (>30d) "
                            f"and {deleted_queue} synced queue items (>24h)"
                        )

                    # 3. Emergency Pruning: Cap metrics table to 20 Million rows
                    count_result = await session.execute(select(func.count(DeviceMetric.id)))
                    total_rows = count_result.scalar() or 0

                    EMERGENCY_LIMIT = 20_000_000
                    if total_rows > EMERGENCY_LIMIT:
                        excess = total_rows - EMERGENCY_LIMIT
                        logger.warning(f"Database row count ({total_rows}) exceeds emergency limit ({EMERGENCY_LIMIT}). Pruning {excess} rows...")

                        # 3a. Delete oldest synced metrics first
                        subq = select(DeviceMetric.id).where(DeviceMetric.sync_status == SyncStatus.synced).order_by(DeviceMetric.timestamp.asc()).limit(excess).subquery()
                        result_synced = await session.execute(
                            delete(DeviceMetric).where(DeviceMetric.id.in_(select(subq.c.id)))
                        )
                        deleted_synced = result_synced.rowcount
                        logger.info(f"Emergency Pruner: Deleted {deleted_synced} oldest synced metrics")

                        # Recount
                        count_result = await session.execute(select(func.count(DeviceMetric.id)))
                        total_rows = count_result.scalar() or 0

                        if total_rows > EMERGENCY_LIMIT:
                            excess = total_rows - EMERGENCY_LIMIT
                            # 3b. Delete oldest pending/unsynced metrics as a last resort
                            subq_unsynced = select(DeviceMetric.id).order_by(DeviceMetric.timestamp.asc()).limit(excess).subquery()
                            result_unsynced = await session.execute(
                                delete(DeviceMetric).where(DeviceMetric.id.in_(select(subq_unsynced.c.id)))
                            )
                            deleted_unsynced = result_unsynced.rowcount
                            logger.error(
                                f"Emergency Pruner: Deleted {deleted_unsynced} unsynced metrics. "
                                f"Storage cap breached."
                            )

                            # Fire system alert warning
                            alert = Alert(
                                title="Storage Limit Reached",
                                message=(
                                    f"SentinelNMS has pruned {deleted_unsynced} unsynced metrics "
                                    f"to prevent local SQLite database lockup (breached {EMERGENCY_LIMIT} limit)."
                                ),
                                severity=AlertSeverity.critical,
                                status=AlertStatus.new,
                                source="system",
                            )
                            session.add(alert)

                    await session.commit()
            except Exception as e:
                logger.error(f"Metrics pruner error: {e}")
            await asyncio.sleep(86400)

    def force_poll(self, device_id: int):
        """Trigger an immediate poll for a device."""
        asyncio.create_task(self._poll_once(device_id))


# Global scheduler instance
scheduler = PollingScheduler()
