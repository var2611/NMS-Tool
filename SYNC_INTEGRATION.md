# SentinelNMS — Desktop ↔ Cloud Sync Integration Guide

## Architecture

```
┌─────────────────────────────────┐         ┌──────────────────────────────────┐
│  SentinelNMS Desktop (Mac)      │         │  SentinelNMS Server (Docker)     │
│                                 │         │                                  │
│  • Polls local LAN devices      │──sync──▶│  • Receives device/metric data   │
│  • Stores in local SQLite       │  HTTPS  │  • Stores in PostgreSQL          │
│  • Sync Agent runs every N min  │         │  • Shows "Synced from Site-HQ"   │
│  • Queues data offline          │         │  • Multi-site dashboard          │
└─────────────────────────────────┘         └──────────────────────────────────┘
         Site Name: "Office-HQ"                 Accessible from anywhere
```

---

## Step 1 — Configure the Server

### 1a. Set gateway key in Docker .env
```bash
# server/.env
SYNC_API_KEY=my-gateway-secret-key-2024
```

Leave `SYNC_API_KEY` **empty** to allow any desktop to sync without a key (open gateway — only use on private networks).

> **Enabling the key on an already-running deployment — order matters.**
> Agents with the wrong key get `403` on every push (queued items retry, then park as
> "failed" — recover them with Settings → Sync log → *Retry failed*), so:
> 1. Generate a key: `openssl rand -hex 24`
> 2. Enter it on **every desktop agent first** (Settings → Cloud Sync → API key).
>    The server still accepts anything at this point, so nothing breaks.
> 3. Then set `SYNC_API_KEY` in `server/.env` and restart the server stack.
> 4. On each agent, hit **Test Connection** — it now verifies the key against a
>    protected endpoint and tells you outright if the server rejects it.

### 1b. Restart Docker
```bash
cd server && docker compose --env-file .env up -d
```

---

## Step 2 — Configure the Desktop Mac App

### Option A — Via the Settings UI (recommended)
1. Open SentinelNMS desktop app
2. Go to **Settings → Cloud Sync**
3. Fill in:
   - **Site Name**: `Office-HQ` (or any unique name for this desktop installation)
   - **Cloud Server URL**: `http://localhost:8765` (for local Docker) or `https://your-server-ip`
   - **Gateway API Key**: same key as `SYNC_API_KEY` in server .env (leave empty if server has no key)
   - **Sync every**: 5 minutes
4. Click **Save**, then **Test Connection**

### Option B — Via .env file
Edit `~/Library/Application Support/sentinelnms-desktop/.env`:
```bash
SYNC_ENABLED=true
SYNC_SERVER_URL=http://localhost:8765
SYNC_API_KEY=my-gateway-secret-key-2024
SYNC_SITE_NAME=Office-HQ
SYNC_INTERVAL_MINUTES=5
```
Restart the desktop app.

---

## Step 3 — Verify Sync is Working

### On the desktop app
- Settings → Cloud Sync → status shows **Connected ✓**
- "Last sync: just now"

### On the server web UI (`http://localhost:8765`)
- Settings → **Connected Desktop Agents** table shows "Office-HQ" with status **online**
- Devices page shows synced devices with badge **🔄 Office-HQ**
- Device detail page shows: "🔄 Synced from Office-HQ · synced 2 min ago"

---

## API Gateway Endpoints

The server exposes these sync endpoints (all require `X-API-Key` header):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/sync/devices` | Push device data |
| `POST` | `/api/v1/sync/metrics` | Push metric snapshots |
| `POST` | `/api/v1/sync/alerts` | Push alerts |
| `POST` | `/api/v1/sync/traps` | Push SNMP trap events |
| `POST` | `/api/v1/sync/heartbeat` | Keepalive ping |
| `GET`  | `/api/v1/sync/sites` | List all connected agents |

### Example: push a device manually
```bash
curl -X POST http://localhost:8765/api/v1/sync/devices \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-gateway-secret-key-2024" \
  -d '{
    "operation": "create",
    "entity_type": "device",
    "entity_id": 1,
    "site_name": "Office-HQ",
    "data": {
      "name": "Core-Switch-01",
      "ip_address": "192.168.1.1",
      "device_type": "router",
      "status": "online",
      "snmp_community": "public"
    }
  }'
```

---

## Multi-Site Setup (multiple desktops → one server)

```
Office-HQ Desktop  ─── site_name="Office-HQ"    ──┐
Branch-Mumbai      ─── site_name="Branch-Mumbai" ──┼──▶ Cloud Server
Home-Lab Desktop   ─── site_name="Home-Lab"      ──┘
```

All sites use the **same** `SYNC_API_KEY` (gateway key), but each has a **unique** `SYNC_SITE_NAME`.

The server deduplicates devices by `IP + site_name`, so `192.168.1.1` from "Office-HQ" and `192.168.1.1` from "Branch-Mumbai" are stored as separate devices — they're on different LANs.

---

## What gets synced

| Data | Synced | Notes |
|------|--------|-------|
| Devices | ✅ | IP, name, type, SNMP info, status |
| Metrics | ✅ | CPU, memory, disk, bandwidth, ping |
| Alerts | ✅ | Threshold breaches from desktop |
| SNMP Traps | ✅ | Raw trap events |
| MIB files | ❌ | Not synced — manage on server separately |
| Settings | ❌ | Each site keeps its own settings |

---

## Device Source Badges

| Badge | Meaning |
|-------|---------|
| `💻 Local` | Added manually on the server |
| `🔍 Discovered` | Found via Auto-Discover scan on the server |
| `🔄 Office-HQ` | Synced from the desktop agent named "Office-HQ" |

---

## Offline Behaviour

The desktop sync agent queues all data locally when the server is unreachable.
When connection restores, it replays the queue in chronological order (up to 5 retries per item).
Items that fail 5 times are marked `failed` and skipped — they won't block new data.
