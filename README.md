# NMS-Tool — Network Management System

A complete, dual-deployment NMS for monitoring PCs, laptops, printers, RF links, and any SNMP-enabled device.

- **Desktop App** — standalone Windows/Linux installer with local SQLite, works fully offline
- **Server App** — multi-user web app with PostgreSQL, Docker deployment, SSL
- **Sync Bridge** — desktop app silently syncs data to server when configured; queues offline, replays on reconnect

---

## Quick Start (Desktop / Development)

### 1. Prerequisites
- Python 3.10+
- Node.js 18+

### 2. First-time install
```bash
# Linux / Mac
bash scripts/start.sh install

# Windows
scripts\start.bat install
```

### 3. Run
```bash
# Linux / Mac
bash scripts/start.sh

# Windows
scripts\start.bat

# Development (hot reload, React dev server on :3000)
bash scripts/start.sh dev
```

Open **http://localhost:8765** — login: **admin / admin**

---

## Features

### Dashboard
- Live network health score ring
- Device status grid (all devices, color-coded status)
- Alerts-by-day area chart
- Device type distribution pie chart
- Real-time alert feed via WebSocket

### Auto-Discovery
- Scan any subnet (e.g. `192.168.1.0/24`)
- Live progress bar as scan runs
- Auto-classifies device types (PC, Printer, RF Link, Router...)
- Select and add discovered devices in one click

### Device Monitoring
- Automatic background polling (configurable interval per device)
- CPU, Memory, Disk metrics (HOST-RESOURCES-MIB)
- Interface bandwidth (ifInOctets/ifOutOctets)
- **RF Link**: signal dBm, noise, CCQ% (Ubiquiti AirMax OIDs)
- **Printer**: toner/ink levels per supply cartridge
- Per-device metric history charts

### SNMP Traps
- Listens on UDP port 162 (auto-falls-back to 1162 if no root)
- SNMPv1, v2c, v3 all supported
- Rule engine: match by OID pattern → set severity, create alert, email, webhook
- Maintenance window suppression per rule
- Test trap sender built-in

### Alerts
- Auto-generated from threshold breaches and trap rules
- Acknowledge and resolve workflow
- Filter by severity/status/time range
- Real-time push via WebSocket (browser toast notifications)
- Email (SMTP) and webhook dispatch

### MIB Manager
- Upload any vendor .mib / .my file (Ubiquiti, MikroTik, HP, Cisco, etc.)
- OID search across all loaded MIBs
- Live OID tester — fetch real-time values from any device

### Cloud Sync (Desktop → Server)
- Configure server URL + API key in Settings
- Runs silently every N minutes
- Works offline: data queued locally when server unreachable
- Replays queue in order when connection restores

---

## Server Deployment

```bash
# Deploy to Linux VPS (installs Docker if needed)
bash scripts/deploy-server.sh
```

Manual Docker Compose:
```bash
cp server/.env.example server/.env
# Edit server/.env with your passwords
cd server && docker compose up -d
```

Access: `https://your-server-ip` — login: admin / admin

---

## Architecture

```
NMS-Tool/
├── core/               Python SNMP engine (shared by both apps)
│   ├── snmp_engine.py  Discovery, polling, trap listener
│   ├── mib_parser.py   MIB file parsing, OID resolution
│   ├── alert_engine.py Threshold checks, notifications
│   ├── scheduler.py    Background polling scheduler
│   ├── sync_agent.py   Cloud sync (desktop only)
│   └── database.py     SQLAlchemy models (SQLite/PostgreSQL)
│
├── api/                FastAPI REST + WebSocket
│   └── routes/         devices, discovery, traps, alerts, mibs, reports, settings
│
├── frontend/           React 18 + Tailwind + Recharts
│   └── src/pages/      Dashboard, Devices, Discovery, Traps, Alerts, MIBs, Reports, Settings
│
├── desktop/            Electron wrapper (desktop installer)
│   └── main.js         Spawns Python backend, shows browser window
│
├── server/             Server deployment
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── nginx.conf
│
└── scripts/
    ├── start.sh        Linux/Mac startup
    ├── start.bat       Windows startup
    └── deploy-server.sh  Server deploy
```

## Default Credentials
- Username: `admin`
- Password: `admin`
- **Change in Settings → Change Password immediately!**

## SNMP Notes
- Default community: `public`
- Trap port: 162 (requires root/admin) or 1162 (automatic fallback)
- To listen on 162 without root on Linux: `sudo setcap cap_net_bind_service=+ep $(which python3)`

## Sync API Keys
When running multiple desktop sites syncing to one server, give each site a unique API key. Set `SYNC_API_KEY=site-name` in each desktop's `.env` and configure the same key in Settings → Cloud Sync.
