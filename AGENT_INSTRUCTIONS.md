# NMS-Tool — AI Agent Master Instructions
> **For AI coding agents (Cursor, Claude, Copilot, GPT-4, etc.)**
> Read this entire file before touching any code. It maps every file, every responsibility, every data flow, and every rule for safe edits.

---

## 1. Project Overview

NMS-Tool is a **Network Management System** with a dual-deployment architecture:

| Mode | Who runs it | Database | Auth | Sync role |
|---|---|---|---|---|
| **Desktop** | Single user, local PC/Linux | SQLite | Single admin | **Pushes** data to server |
| **Server** | Multi-user, VPS/cloud | PostgreSQL | JWT + roles | **Receives** data from desktops |

Both modes run the **exact same Python backend and React frontend**. The only differences are environment variables (`APP_MODE=desktop` vs `APP_MODE=server`) and the deployment wrapper (Electron vs Docker).

**Default credentials:** username `admin`, password `admin` (stored bcrypt-hashed in `users` table).

---

## 2. Repository Layout

```
NMS-Tool/
│
├── core/                  ← SHARED Python engine. No HTTP here.
│   ├── config.py          ← Settings loader (reads .env)
│   ├── database.py        ← All SQLAlchemy models + DB init + seed
│   ├── snmp_engine.py     ← SNMP GET/WALK, subnet discovery, trap listener
│   ├── mib_parser.py      ← MIB file parser, in-memory OID map
│   ├── scheduler.py       ← Background polling scheduler
│   ├── alert_engine.py    ← Threshold checks, WebSocket broadcast, email/webhook
│   └── sync_agent.py      ← Cloud sync logic (desktop → server REST push)
│
├── api/                   ← FastAPI app
│   ├── main.py            ← App factory, lifespan startup/shutdown, static serve
│   └── routes/
│       ├── __init__.py
│       ├── auth.py        ← POST /auth/login, /auth/change-password
│       ├── devices.py     ← CRUD /devices + /devices/{id}/metrics + force-poll
│       ├── discovery.py   ← POST /discovery/scan (SSE progress stream)
│       ├── traps.py       ← Trap events, trap rules CRUD, test trap sender
│       ├── alerts.py      ← Alert list, ack, resolve
│       ├── mibs.py        ← Upload MIB, OID search, live OID tester
│       ├── reports.py     ← Summary report, uptime report
│       ├── settings.py    ← App config, sync config, SMTP config
│       └── ws_router.py   ← WebSocket /ws endpoint
│
├── frontend/
│   ├── package.json       ← React 18, recharts, react-router-dom, zustand, lucide-react
│   ├── vite.config.js     ← Dev proxy: /api → :8765, /ws → :8765
│   ├── tailwind.config.js ← Custom colors: navy, teal, status-*
│   ├── postcss.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx       ← ReactDOM.render entry
│       ├── App.jsx        ← BrowserRouter + protected routes
│       ├── index.css      ← Tailwind + component classes (.card, .btn-*, .badge-*, .input)
│       ├── store/
│       │   └── index.js   ← Zustand global state (auth, devices, alerts, traps, theme)
│       ├── utils/
│       │   └── api.js     ← axios client + named modules (devicesApi, trapsApi, etc.)
│       ├── hooks/
│       │   └── useWebSocket.js  ← WS auto-reconnect, handles device_update/new_alert/trap_received
│       ├── components/
│       │   └── Layout.jsx ← Sidebar nav + topbar + WS status badge + dark mode toggle
│       └── pages/
│           ├── Login.jsx       ← JWT login form
│           ├── Dashboard.jsx   ← Health ring, device grid, alert feed, charts
│           ├── Devices.jsx     ← Device list + right-panel detail + metric charts
│           ├── Discovery.jsx   ← Subnet scan UI + SSE progress + save devices
│           ├── Traps.jsx       ← Event log + rule builder modal + test trap sender
│           ├── Alerts.jsx      ← Alert center with ack/resolve actions
│           ├── MIBs.jsx        ← MIB upload, OID search, live OID tester
│           ├── Reports.jsx     ← Bar charts + uptime table
│           └── Settings.jsx    ← Sync config, SMTP, SNMP info, password change
│
├── desktop/
│   ├── main.js            ← Electron main process (spawns Python, system tray, loading screen)
│   └── preload.js         ← Electron context bridge (exposes electronAPI to renderer)
│
├── server/
│   ├── Dockerfile         ← Python 3.11 slim + SNMP libs
│   ├── docker-compose.yml ← PostgreSQL + nms-api + Nginx
│   ├── nginx.conf         ← SSL termination, WS proxy, rate limit
│   └── .env.example       ← Server env vars template
│
├── scripts/
│   ├── start.sh           ← Linux/Mac: install / dev / run modes
│   ├── start.bat          ← Windows: install / run
│   └── deploy-server.sh   ← One-command Linux VPS deploy
│
├── .env.example           ← All env vars documented
├── requirements.txt       ← Python deps
├── package.json           ← Electron app + electron-builder config
└── README.md              ← User-facing setup guide
```

---

## 3. Core Module Deep Dives

### 3.1 `core/config.py`
- Pydantic `Settings` class reads from `.env` file + environment variables.
- Key properties: `settings.get_database_url` (returns correct DB URL for mode), `settings.is_desktop`, `settings.is_server`.
- **To add a new config value:** add a typed field with `Field(default, env="ENV_VAR_NAME")`, add to `.env.example`.
- **Do NOT hardcode URLs, ports, or secrets anywhere else** — always use `from core.config import settings`.

### 3.2 `core/database.py`
**All models defined here. This is the single source of truth for the schema.**

| Model | Table | Purpose |
|---|---|---|
| `Device` | `devices` | Every monitored device. Central entity. |
| `DeviceMetric` | `device_metrics` | Time-series snapshots per device per poll. |
| `TrapEvent` | `trap_events` | Every received SNMP trap. |
| `Alert` | `alerts` | Threshold breaches and trap-generated alerts. |
| `TrapRule` | `trap_rules` | User-defined rules that process incoming traps. |
| `MibFile` | `mib_files` | Uploaded MIB file metadata + parsed OID sample. |
| `SyncQueue` | `sync_queue` | Offline-queue for desktop→server sync. |
| `User` | `users` | Auth users (bcrypt passwords). |
| `SystemSetting` | `system_settings` | Key-value config store for UI settings. |

**Enums:** `DeviceStatus`, `DeviceType`, `AlertSeverity`, `AlertStatus`, `SnmpVersion`, `SyncStatus` — all are `str` enums so they serialize cleanly to JSON.

**To add a column:** add a `Mapped[type]` field with `mapped_column(...)`. Alembic is included in `requirements.txt` for migrations, or in dev just delete `data/nms.db` to reset.

**`init_db()`** — called on startup. Creates all tables, then calls `seed_defaults()` which creates the admin user and 5 standard trap rules if they don't exist.

**`get_db()`** — FastAPI dependency. Use `db: AsyncSession = Depends(get_db)` in routes.

### 3.3 `core/snmp_engine.py`
The SNMP workhorse. All functions are `async`.

| Function | What it does |
|---|---|
| `snmp_get(ip, oids, community, version, port)` | SNMP GET for a list of OIDs → `{oid_str: value_str}` |
| `snmp_walk(ip, base_oid, community, version)` | Walk an OID subtree → `{oid_str: value_str}` |
| `ping_host(ip)` | ICMP ping → bool |
| `probe_snmp(ip, community)` | Try to get basic system info via SNMP → dict or None |
| `classify_device(sys_descr, sys_object_id)` | Fingerprint → DeviceType string |
| `discover_subnet(subnet, communities, progress_callback)` | Full async subnet scan → list of device dicts |
| `poll_device(device_dict)` | One full poll cycle → metrics dict |
| `send_test_trap(target_ip, port, community, trap_oid, version)` | Send a test SNMP trap |
| `TrapListener.start()` | Async SNMP trap receiver (port 162, fallback 1162) |
| `TrapListener.stop()` | Graceful shutdown |

**Constants:**
- `STANDARD_OIDS` — dict mapping friendly names to numeric OIDs for all common MIBs.
- `DEVICE_FINGERPRINTS` — dict mapping sysObjectID prefixes to device type strings.
- `SYSDESCR_KEYWORDS` — dict mapping sysDescr keywords to device types.
- `STANDARD_TRAP_NAMES` — OID → trap name mapping.
- `TRAP_PLAIN_ENGLISH` — trap name → human description.

**To add support for a new device type's metrics:** add its OID polling block inside `poll_device()` after the `# RF Link specific` section. Follow the same pattern: walk/get OIDs, parse values, add to `metrics` dict.

**To add a new device fingerprint:** add to `DEVICE_FINGERPRINTS` (by sysObjectID prefix) or `SYSDESCR_KEYWORDS` (by description substring).

### 3.4 `core/mib_parser.py`
- `BUILTIN_OID_MAP` — 25+ standard OIDs pre-loaded at startup.
- `_oid_map` — in-memory dict that gets merged with parsed MIBs. All resolution goes through here.
- `resolve_oid(oid)` — tries exact match, then prefix match (handles table instance OIDs like `.1.3.6.1.2.1.2.2.1.2.1`).
- `MibParser.parse(content, filename)` — parses raw MIB text, resolves numeric OIDs. Returns `{module_name, oids: {oid: {name, description, unit}}, oid_count}`.
- `save_mib_file(filename, content)` — writes to `./data/mibs/`, parses, loads into `_oid_map`.
- `load_all_saved_mibs()` — called on startup to reload all `.mib`/`.my` files.

**Note:** The MIB parser is a simplified implementation. It handles most real-world MIBs but may miss complex IMPORTS chains. If a MIB fails to parse OIDs, the file is still saved and can be re-processed.

### 3.5 `core/scheduler.py`
- `PollingScheduler` manages per-device `asyncio.Task` objects.
- `start()` — launches `_manage_poll_tasks()` loop.
- `_manage_poll_tasks()` — runs every 60s, syncs running tasks with DB device list (starts new, cancels removed).
- `_poll_device_loop(device_id, interval)` — infinite loop: poll → sleep(interval) → repeat.
- `_poll_once(device_id)` — single poll: load device from DB → call `snmp_engine.poll_device()` → update Device status → save DeviceMetric → call `alert_engine.evaluate_metrics()` → broadcast WebSocket.
- `force_poll(device_id)` — creates an immediate `_poll_once` task (used by the `/devices/{id}/poll` endpoint).

**Global instance:** `from core.scheduler import scheduler` — imported in `api/main.py`.

### 3.6 `core/alert_engine.py`
- `register_ws(ws)` / `unregister_ws(ws)` — tracks connected WebSocket clients.
- `broadcast_ws(event_type, data)` — sends JSON to all clients, auto-removes dead connections.
- `evaluate_metrics(device, metrics, db_session)` — checks `DEFAULT_THRESHOLDS` dict, creates `Alert` rows, broadcasts `new_alert`, sends notifications for critical.
- `handle_trap_alert(trap_data, db_session)` — matches trap OID against `TrapRule` rows, applies suppression window, creates `TrapEvent` and optionally `Alert`, broadcasts `trap_received`.
- `send_notifications(title, message, severity)` — dispatches email + webhook in parallel.

**To add a new threshold metric:** add to `DEFAULT_THRESHOLDS` dict at top of file. Special case: for metrics where lower = worse (like `signal_dbm`), add a reversed check like the existing signal logic.

### 3.7 `core/sync_agent.py`
- `SyncAgent` — background async service.
- `start()` — runs if `settings.sync_enabled` and `settings.sync_server_url` are set.
- `_sync_cycle()` — pings server `/api/v1/ping`, then queries `SyncQueue` for pending items and pushes them.
- `_push_item(item)` — POSTs to `/api/v1/sync/{entity_type}` on the remote server.
- `queue_entity(entity_type, entity_id, operation, payload)` — call this anywhere to queue data for sync.

**Entity types:** `device`, `trap`, `alert`, `metric`

**Global instance:** `from core.sync_agent import sync_agent`

---

## 4. API Routes Reference

**Base prefix:** `/api/v1`

**Auth:** JWT Bearer token. Get token via `POST /auth/login`. Include as `Authorization: Bearer <token>` header. Currently all endpoints are open for simplicity — to add auth guards, use `Depends(get_current_user)` (needs implementing).

| Method | Path | File | Notes |
|---|---|---|---|
| POST | `/auth/login` | auth.py | `{username, password}` → `{access_token, role}` |
| POST | `/auth/change-password` | auth.py | `{current_password, new_password}` |
| GET | `/devices` | devices.py | Query params: `status`, `device_type`, `search`, `limit`, `offset` |
| GET | `/devices/summary` | devices.py | Dashboard KPIs: total/online/offline/warning/health_score/by_type |
| GET | `/devices/{id}` | devices.py | Single device |
| POST | `/devices` | devices.py | Create device `{name, ip_address, ...}` |
| PUT | `/devices/{id}` | devices.py | Update device |
| DELETE | `/devices/{id}` | devices.py | Soft-delete (sets `is_active=False`) |
| POST | `/devices/{id}/poll` | devices.py | Trigger immediate poll |
| GET | `/devices/{id}/metrics` | devices.py | Query param: `hours` (default 24, max 168) |
| POST | `/discovery/scan` | discovery.py | `{subnet, communities, max_concurrent}` → `{scan_id}` |
| GET | `/discovery/scan/{scan_id}` | discovery.py | Poll scan progress |
| GET | `/discovery/scan/{scan_id}/stream` | discovery.py | SSE stream of scan progress |
| POST | `/discovery/scan/{scan_id}/save` | discovery.py | `["ip1","ip2"]` → saves to devices table |
| GET | `/traps/events` | traps.py | Query: `hours`, `severity`, `source_ip`, `limit` |
| GET | `/traps/events/stats` | traps.py | Last 24h totals |
| GET | `/traps/rules` | traps.py | All trap rules |
| POST | `/traps/rules` | traps.py | Create rule |
| PUT | `/traps/rules/{id}` | traps.py | Update rule |
| PATCH | `/traps/rules/{id}/toggle` | traps.py | Enable/disable |
| DELETE | `/traps/rules/{id}` | traps.py | Delete rule |
| POST | `/traps/test` | traps.py | Send test trap `{target_ip, port, community, trap_oid, version}` |
| GET | `/traps/standard-types` | traps.py | List standard trap OIDs for UI |
| GET | `/alerts` | alerts.py | Query: `status`, `severity`, `hours`, `limit` |
| GET | `/alerts/summary` | alerts.py | last_24h / critical_24h / unacknowledged |
| POST | `/alerts/{id}/acknowledge` | alerts.py | `{acknowledged_by, notes}` |
| POST | `/alerts/{id}/resolve` | alerts.py | No body |
| GET | `/mibs` | mibs.py | List all MIB files |
| POST | `/mibs/upload` | mibs.py | Multipart file upload |
| DELETE | `/mibs/{id}` | mibs.py | Delete MIB (not standard ones) |
| GET | `/mibs/search?q=` | mibs.py | Search OID names/descriptions |
| GET | `/mibs/resolve/{oid}` | mibs.py | OID → name/description/unit |
| POST | `/mibs/test-oid` | mibs.py | `{ip, oid, community}` → live value |
| GET | `/reports/summary` | reports.py | Query: `days` (default 7) |
| GET | `/reports/uptime` | reports.py | Per-device uptime stats |
| GET | `/settings` | settings.py | All current settings |
| POST | `/settings/sync` | settings.py | `{server_url, api_key, interval_minutes}` |
| POST | `/settings/sync/test` | settings.py | Test server connectivity |
| POST | `/settings/smtp/test` | settings.py | Test SMTP connection |
| PUT | `/settings/custom/{key}` | settings.py | Set arbitrary key-value setting |
| GET | `/ping` | main.py | Health check, always returns 200 |
| GET | `/health` | main.py | DB status, scheduler status, sync status |
| WS | `/ws` | ws_router.py | WebSocket (send "ping" → get "pong" keepalive) |

---

## 5. Frontend Architecture

### State Management — `src/store/index.js`
Zustand store. One global store. Key slices:

| Slice | State | Setters |
|---|---|---|
| Auth | `token`, `user` | `setAuth(token, user)`, `logout()` |
| Devices | `devices[]`, `deviceSummary{}` | `setDevices()`, `setDeviceSummary()`, `updateDeviceStatus(id, status, metrics)` |
| Alerts | `alerts[]`, `alertSummary{}` | `setAlerts()`, `setAlertSummary()`, `addAlert(alert)` |
| Traps | `recentTraps[]` | `addTrap(trap)` |
| UI | `wsConnected`, `theme`, `sidebarOpen` | `setWsConnected()`, `toggleTheme()`, `toggleSidebar()` |

**To add new global state:** add the field and its setter to the `create()` call. Don't create separate stores.

### API Client — `src/utils/api.js`
- Default axios instance with `baseURL: '/api/v1'`, auto-attaches JWT, redirects to `/login` on 401.
- Named modules: `devicesApi`, `discoveryApi`, `trapsApi`, `alertsApi`, `mibsApi`, `reportsApi`, `settingsApi`.
- **To add an API call:** add a method to the relevant named module. Keep it a one-liner calling `api.get/post/put/delete`.

### WebSocket — `src/hooks/useWebSocket.js`
- Auto-reconnects every 3s on disconnect.
- 30s ping interval to keep connection alive.
- Handles 3 event types from server:
  - `device_update` → calls `updateDeviceStatus()`
  - `new_alert` → calls `addAlert()` + shows toast
  - `trap_received` → calls `addTrap()` + shows toast for critical

**To handle a new WS event type:** add a `case` in the `switch (msg.type)` block.

### Routing — `src/App.jsx`
- All routes wrapped in `<ProtectedRoute>` which redirects to `/login` if no token.
- Routes: `/`, `/devices`, `/discovery`, `/traps`, `/alerts`, `/mibs`, `/reports`, `/settings`.
- **To add a new page:** create `src/pages/NewPage.jsx`, import in `App.jsx`, add route, add nav item to `Layout.jsx`.

### Sidebar Nav — `src/components/Layout.jsx`
- `NAV` array at top of file defines all sidebar links: `{ to, icon, label }`.
- Alert badge auto-shows on Alerts link when `alertSummary.unacknowledged > 0`.
- WS status shown in sidebar footer.

### CSS / Design System — `src/index.css`
**Component classes (use these, don't write inline styles):**

| Class | Purpose |
|---|---|
| `.card` | White box with border + shadow. Darkmode aware. |
| `.btn-primary` | Teal filled button |
| `.btn-secondary` | Gray outlined button |
| `.btn-danger` | Red filled button |
| `.badge` | Base pill badge (combine with modifier) |
| `.badge-critical` | Red badge |
| `.badge-warning` | Amber badge |
| `.badge-info` | Blue badge |
| `.badge-online` | Green badge |
| `.input` | Styled form input |
| `.label` | Form label above input |
| `.status-dot` | Small colored status circle |

**Colors (Tailwind custom):**
- `navy-{50-900}` — dark blue sidebar/backgrounds
- `teal-{50-700}` — primary brand color (buttons, active states)
- `status-online/offline/warning/unknown` — status indicator colors

---

## 6. Data Flow Maps

### Flow 1: Device Discovery → Add → First Poll
```
User enters subnet in Discovery.jsx
  → POST /discovery/scan  (discovery.py)
    → background: discover_subnet() in snmp_engine.py
      → probe_snmp() for each IP
        → snmp_get() 6 base OIDs
          → classify_device() returns type
  → SSE stream updates Discovery.jsx progress bar
  → User selects IPs → POST /discovery/scan/{id}/save
    → Creates Device rows in DB
  → scheduler._manage_poll_tasks() picks up new devices on next 60s cycle
    → _poll_device_loop(device_id, interval) starts
      → poll_device() called every N seconds
        → Updates device.status in DB
        → Creates DeviceMetric row
        → evaluate_metrics() checks thresholds → may create Alert
        → broadcast_ws("device_update", ...) → useWebSocket.js → updateDeviceStatus()
```

### Flow 2: Incoming SNMP Trap → Alert → Notification
```
Remote device sends SNMP trap UDP to port 162
  → TrapListener._trap_receiver() (snmp_engine.py)
    → extracts trap_oid from snmpTrapOID varbind
    → calls self.callback(trap_data)
      → handle_trap_alert(trap_data, db_session) (alert_engine.py)
        → matches trap_oid against TrapRule rows
        → checks suppression window
        → creates TrapEvent row
        → creates Alert row (if rule says so)
        → broadcast_ws("trap_received", ...) → toast in browser
        → send_notifications() if rule has email/webhook
```

### Flow 3: Desktop Sync to Server
```
Desktop runs normally (fully offline capable)
  Any new device/alert/trap creates a SyncQueue row (status=pending)
    ↓ (every sync_interval_minutes)
SyncAgent._sync_cycle()
  → GET /api/v1/ping on server
    → If unreachable: log warning, leave queue as pending, retry next cycle
    → If reachable: 
      → Query SyncQueue WHERE status=pending ORDER BY created_at
      → For each item: POST /api/v1/sync/{entity_type} on server
        → On 200: set status=synced
        → On error: increment attempts; after 5 failures set status=failed
```

### Flow 4: Real-time Dashboard Updates
```
Browser WebSocket connects to /ws
  → register_ws(websocket) in alert_engine.py
  → Every poll cycle: broadcast_ws("device_update", {device_id, status, metrics})
    → useWebSocket.js receives it
      → updateDeviceStatus() in Zustand store
        → React re-renders device grid cards without page reload
  → Every new alert: broadcast_ws("new_alert", {...})
    → addAlert() + toast notification
  → Every trap: broadcast_ws("trap_received", {...})
    → addTrap() + toast for critical
```

---

## 7. Environment Variables Reference

All defined in `core/config.py`. Set in `.env` file. All have defaults.

| Variable | Default | Purpose |
|---|---|---|
| `APP_MODE` | `desktop` | `desktop` or `server` |
| `API_HOST` | `127.0.0.1` | Bind host. Use `0.0.0.0` for server. |
| `API_PORT` | `8765` | HTTP listen port |
| `SECRET_KEY` | `dev-secret-key-...` | JWT signing key. **Change in production.** |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` | JWT expiry (24h default) |
| `SQLITE_DB_PATH` | `./data/nms.db` | Desktop SQLite path |
| `DATABASE_URL` | `None` | PostgreSQL URL (server mode) |
| `SNMP_TRAP_PORT` | `162` | UDP trap listen port |
| `SNMP_DEFAULT_COMMUNITY` | `public` | Default SNMP community |
| `SNMP_TIMEOUT` | `5` | SNMP query timeout (seconds) |
| `SNMP_RETRIES` | `2` | SNMP retry count |
| `SYNC_ENABLED` | `false` | Enable cloud sync (desktop) |
| `SYNC_SERVER_URL` | `None` | Server URL to sync to |
| `SYNC_API_KEY` | `None` | Site identifier / API key |
| `SYNC_INTERVAL_MINUTES` | `5` | Sync frequency |
| `SMTP_HOST` | `None` | Email server hostname |
| `SMTP_PORT` | `587` | Email server port |
| `SMTP_USER` | `None` | SMTP username |
| `SMTP_PASSWORD` | `None` | SMTP password |
| `SMTP_FROM` | `nms@yourdomain.com` | From address for alert emails |
| `WEBHOOK_URL` | `None` | Webhook URL (Slack/Teams/Discord) |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `LOG_FILE` | `./data/nms.log` | Log file path |

---

## 8. Common Tasks — Where to Edit

### Add a new device metric (e.g. temperature sensor)
1. **`core/snmp_engine.py`** — add OID to `STANDARD_OIDS` dict, add polling block in `poll_device()` for target device type.
2. **`core/database.py`** — add column to `DeviceMetric` model (e.g. `temperature_celsius: Mapped[Optional[float]]`).
3. **`core/alert_engine.py`** — add threshold entry to `DEFAULT_THRESHOLDS`, add message/title strings.
4. **`api/routes/devices.py`** — include new field in `/metrics` response dict.
5. **`frontend/src/pages/Devices.jsx`** — add chart or display for the metric in the detail panel.

### Add a new page
1. Create `frontend/src/pages/NewPage.jsx`.
2. Import in `frontend/src/App.jsx` and add `<Route path="/newpage" element={<NewPage />} />`.
3. Add entry to `NAV` array in `frontend/src/components/Layout.jsx`.

### Add a new API endpoint
1. Add the function to the appropriate route file in `api/routes/`.
2. If it needs a new Pydantic schema, define it at the top of that route file.
3. No need to touch `api/main.py` — routers are auto-included.

### Add support for SNMPv3 polling
1. **`core/snmp_engine.py`** — `snmp_get()` currently uses `CommunityData`. Add a branch for `version == "v3"` using `UsmUserData` from pysnmp.
2. **`core/database.py`** — `Device` already has `snmp_v3_username`, `snmp_v3_auth_key`, `snmp_v3_priv_key` columns ready.
3. **`api/routes/devices.py`** — `DeviceCreate` schema needs `snmp_v3_*` fields exposed.
4. **`frontend/src/pages/Devices.jsx`** — add v3 credential fields in the device form.

### Add multi-user role enforcement
1. **`api/routes/auth.py`** — implement `get_current_user(token: str = Depends(oauth2_scheme))` function that decodes JWT and returns `User`.
2. Add `current_user: User = Depends(get_current_user)` to any route that needs protection.
3. For admin-only routes, check `if current_user.role != "admin": raise HTTPException(403)`.

### Add a new WebSocket event type
1. **`core/alert_engine.py`** — call `await broadcast_ws("my_event", {...data...})` wherever the event originates.
2. **`frontend/src/hooks/useWebSocket.js`** — add `case 'my_event':` in the switch block.
3. Update store in `frontend/src/store/index.js` if the event needs to update global state.

### Change default polling thresholds
Edit `DEFAULT_THRESHOLDS` dict in **`core/alert_engine.py`**. Keys must match metric names in `DeviceMetric` model.

### Add support for a new vendor's RF link OIDs
1. **`core/snmp_engine.py`** — add OID constants near the top under `STANDARD_OIDS`.
2. In `poll_device()`, add a branch inside `if device_type == "rf_link":` for the new vendor.
3. Optionally add the vendor's sysObjectID prefix to `DEVICE_FINGERPRINTS`.

---

## 9. Desktop App (Electron) Details

**File:** `desktop/main.js`

Key behaviors:
- On startup: shows a full-screen loading animation while waiting for Python backend.
- `waitForBackend()` — polls `GET /api/v1/ping` every 500ms until 200 or 30s timeout.
- `getPythonPath()` — looks for `venv/bin/python` (dev) or `resources/venv/bin/python` (packaged).
- `getResourcePath()` — `process.resourcesPath` when packaged, `..` when dev.
- On window close: hides to system tray (doesn't kill Python).
- On tray → Quit: sets `app.isQuitting = true`, kills Python with SIGTERM then SIGKILL after 3s.

**To build installers:**
```bash
npm install           # in root (installs electron-builder)
npm run build:win     # → dist-electron/*.exe
npm run build:linux   # → dist-electron/*.deb + *.AppImage
npm run build:mac     # → dist-electron/*.dmg
```
**Requires:** a built Python venv at `./venv/` and built frontend at `./frontend/dist/`.

---

## 10. Server Deployment Details

**Files:** `server/docker-compose.yml`, `server/Dockerfile`, `server/nginx.conf`

```bash
# One-command deploy
bash scripts/deploy-server.sh

# Manual
cp server/.env.example server/.env
# edit server/.env
cd server && docker compose up -d
```

Services:
- `postgres` — PostgreSQL 16, volume `postgres_data`, internal only.
- `nms-api` — Python FastAPI, exposes `:8765` internally + `:162/UDP` for SNMP traps.
- `nginx` — reverse proxy on `:80`→redirect and `:443` SSL. Proxies `/api/` and `/ws` to `nms-api:8765`.

**To add Let's Encrypt SSL:** replace `server/ssl/cert.pem` and `server/ssl/key.pem` with real certs. Consider using `certbot` with `nginx` plugin, or mount the cert path into the nginx container.

**To scale:** increase `--workers` in `Dockerfile` CMD. For WebSocket-heavy loads, add Redis pub/sub broadcast (replace `_ws_clients` set in `alert_engine.py` with a Redis channel).

---

## 11. Rules for AI Agents

### ✅ Safe to edit freely
- Any file in `frontend/src/pages/` — isolated UI components.
- `frontend/src/index.css` — add new utility classes at bottom.
- `frontend/src/store/index.js` — add new state slices.
- `frontend/src/utils/api.js` — add new API call methods.
- `core/alert_engine.py` `DEFAULT_THRESHOLDS` dict — threshold values only.
- `STANDARD_OIDS`, `DEVICE_FINGERPRINTS`, `TRAP_PLAIN_ENGLISH` in `core/snmp_engine.py` — data only.
- `BUILTIN_OID_MAP` in `core/mib_parser.py` — data only.
- `.env.example`, `README.md`, `AGENT_INSTRUCTIONS.md` — documentation.

### ⚠️ Edit carefully (affects multiple parts)
- `core/database.py` — adding a column means updating the route response dict and potentially the frontend.
- `core/snmp_engine.py` `poll_device()` — metrics dict keys must match `DeviceMetric` column names.
- `frontend/src/App.jsx` — adding a route requires updating `Layout.jsx` NAV too.
- `api/routes/*.py` Pydantic schemas — must match what the frontend sends/expects.

### 🚫 Do not modify without understanding the full chain
- `core/config.py` — settings class; changes affect both desktop and server modes.
- `core/database.py` model relationships and enums — enum values are stored as strings in DB.
- `api/main.py` lifespan — startup order matters: DB init → MIBs → scheduler → sync agent.
- `core/alert_engine.py` `broadcast_ws()` and `_ws_clients` — thread-safety sensitive.
- `desktop/main.js` `waitForBackend()` and process management — race conditions possible.

### 🔒 Never do
- Hardcode secrets, passwords, or API keys in any source file.
- Store sensitive data in `localStorage` or `sessionStorage` in the frontend (not supported in Claude.ai artifacts context; use Zustand state).
- Delete or rename the `data/` directory at runtime.
- Change enum string values in `database.py` without a DB migration (breaks existing rows).
- Import `api/routes/*.py` from `core/` — `core` must stay HTTP-free.

---

## 12. Dependencies Summary

### Python (requirements.txt)
| Package | Why |
|---|---|
| `fastapi` | REST API framework |
| `uvicorn[standard]` | ASGI server with WebSocket support |
| `pysnmp` | SNMP v1/v2c/v3 (GET, WALK, trap sender and receiver) |
| `sqlalchemy` + `aiosqlite` + `asyncpg` | Async ORM, SQLite (desktop), PostgreSQL (server) |
| `pydantic-settings` | Typed settings from .env |
| `python-jose` | JWT token creation and verification |
| `passlib[bcrypt]` | Password hashing |
| `httpx` | Async HTTP client (used by sync agent and webhook) |
| `apscheduler` | Available but not currently used (scheduler is custom asyncio) |
| `netaddr` | IP subnet math for discovery |
| `psutil` | System info (available for future local-agent metrics) |

### JavaScript (frontend/package.json)
| Package | Why |
|---|---|
| `react` + `react-dom` | UI framework |
| `react-router-dom` | Client-side routing |
| `recharts` | All charts (AreaChart, BarChart, PieChart, LineChart) |
| `zustand` | Global state management |
| `axios` | HTTP API client |
| `react-hot-toast` | Toast notifications |
| `lucide-react` | Icons (consistent icon set) |
| `clsx` | Conditional className utility |
| `tailwindcss` | Utility CSS framework |
| `date-fns` | Date formatting utilities |

---

## 13. Known Limitations / Future Work

| Area | Current State | How to improve |
|---|---|---|
| Auth | No per-route enforcement | Implement `get_current_user` dependency + add to routes |
| SNMPv3 | Database columns exist, `snmp_get()` doesn't use them yet | Add `UsmUserData` branch in `snmp_engine.py` |
| MIB Parser | Simple regex, may miss complex IMPORTS chains | Use `pysmi` library for full RFC-compliant parsing |
| WS scale | In-memory `_ws_clients` set | Replace with Redis pub/sub for multi-worker/multi-server |
| Sync API | Server-side `/api/v1/sync/*` endpoints not implemented | Add `api/routes/sync.py` with endpoints for device/trap/alert/metric ingest |
| Metrics retention | No pruning — `device_metrics` grows forever | Add a scheduled job to delete metrics older than N days |
| Electron build | CI pipeline implemented via unified workflow | Run "Release — Bump, Tag & Build" manually in GitHub Actions |
| Tests | None | Add `pytest` + `httpx.AsyncClient` for API routes, `vitest` for React |

---

## 14. Versioning & Release Rules

- **Tag Priority**: The Git tag (e.g., `vX.Y.Z`) is the priority and primary source of truth for the release version naming and installer builds.
- **Unified Release Flow**: Releasing must always run through the unified **Release — Bump, Tag & Build** GitHub Actions workflow (triggered manually via `workflow_dispatch`). This workflow:
  1. Computes the target SemVer based on inputs.
  2. Updates `version` in `package.json`, `frontend/package.json`, and `core/config.py`.
  3. Commits the version bump and pushes the tag (e.g., `vX.Y.Z`) to `master`.
  4. Runs the build jobs checked out to that specific tag to compile and package Windows, macOS, and Linux installers.
- **No Direct Master Builds**: Pushes to `master` branch do not trigger builds directly. Releases are strictly tag-centric to avoid redundant builder workflows.
