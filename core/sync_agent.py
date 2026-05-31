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

    async def _sync_cycle(self):
        """Run one sync cycle: check connection, push pending data."""
        from core.database import AsyncSessionLocal
        from core.database import SyncQueue, SyncStatus
        from sqlalchemy import select

        # Test connection
        try:
            resp = await self._client.get("/api/v1/ping")
            if resp.status_code == 200:
                self._is_connected = True
                self._last_error = None
            else:
                self._is_connected = False
                return
        except Exception as e:
            self._is_connected = False
            self._last_error = f"Cannot reach server: {e}"
            logger.warning(f"Sync: server unreachable — queuing data locally")
            return

        # Push pending queue items
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(SyncQueue)
                .where(SyncQueue.status == SyncStatus.pending)
                .order_by(SyncQueue.created_at)
                .limit(100)
            )
            items = result.scalars().all()

            pushed = 0
            failed = 0
            for item in items:
                success = await self._push_item(item)
                if success:
                    item.status = SyncStatus.synced
                    item.last_attempt = datetime.utcnow()
                    pushed += 1
                else:
                    item.attempts += 1
                    item.last_attempt = datetime.utcnow()
                    if item.attempts >= 5:
                        item.status = SyncStatus.failed
                    failed += 1

            await session.commit()
            
            if pushed or failed:
                logger.info(f"Sync: pushed={pushed}, failed={failed}")
            self._last_sync = datetime.utcnow()

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
                "site_id": settings.sync_api_key,
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


# Global sync agent instance
sync_agent = SyncAgent()
