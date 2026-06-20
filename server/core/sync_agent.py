"""
Sync Agent — Pushes local data to cloud NMS server
Queues data when offline, replays when connection restores
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional
import httpx
from core.config import settings

logger = logging.getLogger(__name__)


class SyncAgent:
    def __init__(self):
        self.enabled = settings.sync_enabled
        self.server_url = settings.sync_server_url
        self.api_key = settings.sync_api_key
        self.interval = settings.sync_interval_minutes * 60
        self._running = False
        self._client: Optional[httpx.AsyncClient] = None
        self._last_sync: Optional[datetime] = None
        self._last_error: Optional[str] = None
        self._is_connected = False

    @property
    def status(self):
        return {
            "enabled": self.enabled,
            "connected": self._is_connected,
            "last_sync": self._last_sync.isoformat() if self._last_sync else None,
            "last_error": self._last_error,
            "server_url": self.server_url,
        }

    async def start(self):
        if not self.enabled or not self.server_url:
            logger.info("Sync agent disabled or no server configured")
            return
        
        self._running = True
        self._client = httpx.AsyncClient(
            base_url=self.server_url,
            headers={"X-API-Key": self.api_key or "", "Content-Type": "application/json"},
            timeout=30.0
        )
        logger.info(f"Sync agent started → {self.server_url}")
        
        while self._running:
            try:
                await self._sync_cycle()
            except Exception as e:
                logger.error(f"Sync cycle error: {e}")
                self._last_error = str(e)
                self._is_connected = False
            await asyncio.sleep(self.interval)

    async def stop(self):
        self._running = False
        if self._client:
            await self._client.aclose()
            self._client = None

    async def reconfigure(self, server_url: str, api_key: str = "",
                          site_name: str = "", interval_minutes: int = 5):
        """
        Live-reconfigure sync with new settings and (re)start the agent.
        Called when the user saves Settings → Cloud Sync.
        """
        # Stop the current agent
        await self.stop()

        # Apply new config
        self.server_url = server_url
        self.api_key = api_key
        self.interval = interval_minutes * 60
        self.enabled = bool(server_url)
        self._is_connected = False
        self._last_error = None

        # Update the global settings object too so site_name is used in payloads
        if site_name:
            settings.sync_site_name = site_name

        # (Re)start if URL is set
        if self.enabled:
            import asyncio
            asyncio.create_task(self.start())
            logger.info(f"Sync agent reconfigured → {server_url} (site={site_name or settings.sync_site_name})")

    async def _sync_cycle(self):
        """Run one sync cycle: check connection, push pending data, write log."""
        from core.database import AsyncSessionLocal
        from core.database import SyncQueue, SyncStatus, SyncLog
        from sqlalchemy import select, func
        import time

        start_ms = time.monotonic()

        # ── 1. Test connection ─────────────────────────────────────────────────
        try:
            resp = await self._client.get("/api/v1/ping")
            if resp.status_code == 200:
                self._is_connected = True
                self._last_error = None
            else:
                self._is_connected = False
                self._last_error = f"Server returned HTTP {resp.status_code}"
                await self._write_log("offline", 0, 0, 0,
                                      int((time.monotonic() - start_ms) * 1000),
                                      self._last_error)
                return
        except Exception as e:
            self._is_connected = False
            self._last_error = f"Cannot reach server: {e}"
            logger.warning(f"Sync: server unreachable — {e}")
            await self._write_log("offline", 0, 0, 0,
                                  int((time.monotonic() - start_ms) * 1000),
                                  self._last_error)
            return

        # ── 2. Drain the entire queue in batches ──────────────────────────────
        # Process batches of BATCH_SIZE until the queue is empty or all items
        # in a batch fail (server-side error — stop retrying immediately).
        # This prevents the old "100 items per 5-minute cycle" bottleneck where
        # the queue never drained because new items arrived faster than the
        # fixed-size batch could push them.
        BATCH_SIZE = 200
        MAX_CYCLE_SECS = 240   # safety valve — never run longer than 4 min

        total_pushed = 0
        total_failed = 0
        last_error   = None
        still_pending = 0

        while (time.monotonic() - start_ms) < MAX_CYCLE_SECS:
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(SyncQueue)
                    .where(SyncQueue.status == SyncStatus.pending)
                    .order_by(SyncQueue.created_at)
                    .limit(BATCH_SIZE)
                )
                items = result.scalars().all()

                if not items:
                    # Queue is empty — we're done
                    break

                batch_pushed = 0
                batch_failed = 0
                for item in items:
                    success = await self._push_item(item)
                    if success:
                        item.status = SyncStatus.synced
                        item.last_attempt = datetime.utcnow()
                        batch_pushed += 1
                    else:
                        item.attempts += 1
                        item.last_attempt = datetime.utcnow()
                        if item.attempts >= 5:
                            item.status = SyncStatus.failed
                        last_error = item.error
                        batch_failed += 1

                # Count remaining BEFORE commit so we log the right number
                pending_result = await session.execute(
                    select(func.count(SyncQueue.id)).where(SyncQueue.status == SyncStatus.pending)
                )
                still_pending = (pending_result.scalar() or 0) - (len(items) - batch_pushed - batch_failed)

                await session.commit()

            total_pushed += batch_pushed
            total_failed += batch_failed

            logger.debug(
                f"Sync batch: pushed={batch_pushed} failed={batch_failed} "
                f"remaining≈{still_pending}"
            )

            # If nothing went through this batch, the server is having issues —
            # stop now and let the next scheduled cycle retry.
            if batch_pushed == 0:
                break

        duration = int((time.monotonic() - start_ms) * 1000)

        # ── 3. Write sync log entry ────────────────────────────────────────────
        if total_failed == 0:
            cycle_status = "success"
        elif total_pushed > 0:
            cycle_status = "partial"
        else:
            cycle_status = "failed"

        pushed = total_pushed
        failed = total_failed

        await self._write_log(cycle_status, pushed, failed, still_pending,
                              duration, last_error if failed > 0 else None)

        if pushed or failed:
            logger.info(f"Sync: pushed={pushed}, failed={failed}, pending={still_pending} ({duration}ms)")
        self._last_sync = datetime.utcnow()

    async def _write_log(self, status: str, pushed: int, failed: int,
                         pending: int, duration_ms: int, error: Optional[str]):
        """Append one entry to sync_log. Prune entries older than 7 days."""
        from core.database import AsyncSessionLocal, SyncLog
        from sqlalchemy import delete as sa_delete
        try:
            async with AsyncSessionLocal() as session:
                entry = SyncLog(
                    status=status,
                    items_pushed=pushed,
                    items_failed=failed,
                    items_pending=pending,
                    duration_ms=duration_ms,
                    error=error,
                    server_url=self.server_url,
                )
                session.add(entry)
                # Prune logs older than 7 days to keep the DB lean
                cutoff = datetime.utcnow().replace(hour=0, minute=0, second=0) - \
                         __import__('datetime').timedelta(days=7)
                await session.execute(
                    sa_delete(SyncLog).where(SyncLog.timestamp < cutoff)
                )
                await session.commit()
        except Exception as exc:
            logger.debug(f"Could not write sync log: {exc}")

    async def _push_item(self, item) -> bool:
        """Push a single queue item to the server."""
        endpoint_map = {
            "device": "/api/v1/sync/devices",
            "trap": "/api/v1/sync/traps",
            "alert": "/api/v1/sync/alerts",
            "metric": "/api/v1/sync/metrics",
        }
        endpoint = endpoint_map.get(item.entity_type)
        if not endpoint:
            return False

        try:
            payload = {
                "operation": item.operation,
                "entity_type": item.entity_type,
                "entity_id": item.entity_id,
                "data": item.payload,
                "site_id": settings.sync_api_key,          # kept for backward compat
                "site_name": settings.sync_site_name,       # human-readable site identifier
                "app_version": settings.app_version,
                "timestamp": item.created_at.isoformat() if item.created_at else None,
            }
            resp = await self._client.post(endpoint, json=payload)
            if resp.status_code in (200, 201):
                return True
            item.error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            return False
        except Exception as e:
            item.error = str(e)
            return False

    async def queue_entity(self, entity_type: str, entity_id: int,
                           operation: str, payload: dict):
        """Add an entity to the sync queue."""
        if not self.enabled:
            return
        from core.database import AsyncSessionLocal, SyncQueue
        async with AsyncSessionLocal() as session:
            item = SyncQueue(
                entity_type=entity_type,
                entity_id=entity_id,
                operation=operation,
                payload=payload,
            )
            session.add(item)
            await session.commit()


async def device_sync_payload(device, session, status: Optional[str] = None) -> dict:
    """Full device payload for cloud sync — single source of truth for which
    fields travel to the server (create/update/restore all use this).

    `associated_device_id` is a LOCAL row id that means nothing on the server,
    so the pairing is shipped as `associated_ip` and re-resolved remotely.
    """
    from core.database import Device
    from sqlalchemy import select

    associated_ip = None
    if device.associated_device_id:
        result = await session.execute(
            select(Device.ip_address).where(Device.id == device.associated_device_id)
        )
        associated_ip = result.scalar_one_or_none()

    return {
        "name":           device.name,
        "ip_address":     device.ip_address,
        "device_type":    device.device_type.value if device.device_type else "unknown",
        "status":         status or (device.status.value if device.status else "unknown"),
        "snmp_community": device.snmp_community,
        "snmp_port":      device.snmp_port,
        "poll_interval":  device.poll_interval,
        "notes":          device.notes,
        "sys_descr":      device.sys_descr,
        "sys_name":       device.sys_name,
        "sys_location":   device.sys_location,
        "sys_contact":    device.sys_contact,
        "vendor":         device.vendor,
        "model":          device.model,
        "auto_discovered": device.auto_discovered,
        "last_seen":      device.last_seen.isoformat() if device.last_seen else None,
        "uptime_seconds": device.uptime_seconds,
        "latitude":       device.latitude,
        "longitude":      device.longitude,
        "associated_ip":  associated_ip,
    }


# Global sync agent instance
sync_agent = SyncAgent()
