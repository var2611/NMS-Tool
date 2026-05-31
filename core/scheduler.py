"""
Scheduler — Manages background polling tasks for all devices
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Set
from core.snmp_engine import poll_device
from core.alert_engine import evaluate_metrics, broadcast_ws
from core.database import AsyncSessionLocal, Device, DeviceMetric, DeviceStatus
from sqlalchemy import select, delete

logger = logging.getLogger(__name__)


class PollingScheduler:
    def __init__(self):
        self._running = False
        self._tasks: Dict[int, asyncio.Task] = {}
        self._poll_intervals: Dict[int, int] = {}

    async def start(self):
        self._running = True
        logger.info("Polling scheduler started")
        asyncio.create_task(self._manage_poll_tasks())
        asyncio.create_task(self._metrics_pruner())

    async def stop(self):
        self._running = False
        for task in self._tasks.values():
            task.cancel()
        logger.info("Polling scheduler stopped")

    async def _manage_poll_tasks(self):
        """Periodically sync polling tasks with DB device list."""
        while self._running:
            try:
                async with AsyncSessionLocal() as session:
                    result = await session.execute(
                        select(Device).where(Device.is_active == True)
                    )
                    devices = result.scalars().all()
                    
                    current_ids: Set[int] = set()
                    for device in devices:
                        current_ids.add(device.id)
                        interval = device.poll_interval or 300
                        
                        # Start new polling task if not already running
                        if device.id not in self._tasks or self._tasks[device.id].done():
                            self._poll_intervals[device.id] = interval
                            self._tasks[device.id] = asyncio.create_task(
                                self._poll_device_loop(device.id, interval)
                            )
                    
                    # Cancel tasks for removed devices
                    for device_id in list(self._tasks.keys()):
                        if device_id not in current_ids:
                            self._tasks[device_id].cancel()
                            del self._tasks[device_id]
                            
            except Exception as e:
                logger.error(f"Scheduler manage error: {e}")
            
            await asyncio.sleep(60)  # Re-sync device list every minute

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
        """Poll a device once and save results."""
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Device).where(Device.id == device_id)
            )
            device = result.scalar_one_or_none()
            if not device:
                return

            device_dict = {
                "id": device.id,
                "ip_address": device.ip_address,
                "snmp_community": device.snmp_community,
                "snmp_version": device.snmp_version.value if device.snmp_version else "v2c",
                "device_type": device.device_type.value if device.device_type else "unknown",
                "name": device.name,
            }

        # Poll (outside DB session to avoid holding connection)
        metrics = await poll_device(device_dict)

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
                device.last_seen = datetime.utcnow()
                if metrics.get("uptime_seconds"):
                    device.uptime_seconds = metrics["uptime_seconds"]
            elif new_status == "offline":
                device.consecutive_failures = (device.consecutive_failures or 0) + 1
                if device.consecutive_failures >= 3:
                    device.status = DeviceStatus.offline
                elif device.consecutive_failures >= 1:
                    device.status = DeviceStatus.warning

            device.last_polled = datetime.utcnow()

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
                custom_metrics=metrics.get("custom_metrics"),
            )
            
            # First interface bandwidth
            if metrics.get("interfaces"):
                iface = metrics["interfaces"][0]
                metric_row.interface_name = iface.get("name")
                metric_row.bytes_in = iface.get("bytes_in")
                metric_row.bytes_out = iface.get("bytes_out")

            session.add(metric_row)

            # Evaluate thresholds and create alerts
            device_dict_for_eval = {"id": device.id, "name": device.name}
            await evaluate_metrics(device_dict_for_eval, metrics, session)

            await session.commit()

        # Broadcast status update
        await broadcast_ws("device_update", {
            "device_id": device_id,
            "status": new_status,
            "metrics": {k: v for k, v in metrics.items() if k not in ("interfaces", "supplies")},
        })

    async def _metrics_pruner(self):
        """Delete device_metrics rows older than 30 days. Runs once per day."""
        while self._running:
            try:
                cutoff = datetime.utcnow() - timedelta(days=30)
                async with AsyncSessionLocal() as session:
                    result = await session.execute(
                        delete(DeviceMetric).where(DeviceMetric.timestamp < cutoff)
                    )
                    deleted = result.rowcount
                    await session.commit()
                    if deleted:
                        logger.info(f"Metrics pruner: deleted {deleted} rows older than 30 days")
            except Exception as e:
                logger.error(f"Metrics pruner error: {e}")
            await asyncio.sleep(86400)  # run every 24 hours

    def force_poll(self, device_id: int):
        """Trigger an immediate poll for a device."""
        asyncio.create_task(self._poll_once(device_id))


# Global scheduler instance
scheduler = PollingScheduler()
