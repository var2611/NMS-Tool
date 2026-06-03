#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SentinelNMS — frp Tunnel CLIENT setup (Mac / Linux desktop)
# Run this on the machine where SentinelNMS Docker is running.
#
# What it does:
#   • Downloads frp client (frpc)
#   • Creates a tunnel: your-server-ip:18765 → localhost:8765 (NMS web)
#                       your-server-ip:16200 → localhost:162  (SNMP traps UDP)
#   • Installs a LaunchAgent (Mac) or systemd service (Linux) so the tunnel
#     starts automatically and reconnects if the connection drops
#
# Requirements:
#   • frp SERVER already set up on your RustDesk server
#     (run scripts/setup-tunnel-server.sh there first)
#   • SentinelNMS Docker running locally on port 8765
#
# Usage:
#   bash scripts/setup-tunnel-client.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

FRP_VERSION="0.61.1"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${CYAN}[frp-client]${NC} $1"; }
ok()    { echo -e "${GREEN}[frp-client]${NC} $1"; }
warn()  { echo -e "${YELLOW}[frp-client]${NC} $1"; }
err()   { echo -e "${RED}[frp-client]${NC} $1"; exit 1; }

# ── Collect server details ─────────────────────────────────────────────────
echo ""
echo -e "${CYAN}SentinelNMS frp Tunnel Setup${NC}"
echo "─────────────────────────────"
echo ""

read -p "  RustDesk server IP or hostname: " SERVER_HOST
read -p "  frp control port [7800]:        " BIND_PORT
BIND_PORT=${BIND_PORT:-7800}
read -s -p "  Token (from server setup):      " FRP_TOKEN
echo ""

if [[ -z "$SERVER_HOST" || -z "$FRP_TOKEN" ]]; then
  err "Server host and token are required"
fi

NMS_REMOTE_PORT=18765
NMS_SNMP_PORT=16200
INSTALL_DIR="$HOME/.nms-tunnel"

# ── Download frp ───────────────────────────────────────────────────────────
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case $ARCH in
  x86_64)  FRP_ARCH="amd64" ;;
  arm64|aarch64) FRP_ARCH="arm64" ;;
  *) err "Unsupported arch: $ARCH" ;;
esac

TARBALL="frp_${FRP_VERSION}_${OS}_${FRP_ARCH}.tar.gz"
URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}"

mkdir -p "$INSTALL_DIR"
info "Downloading frp v${FRP_VERSION} for ${OS}/${FRP_ARCH}..."
curl -fsSL "$URL" | tar xz -C /tmp
cp "/tmp/frp_${FRP_VERSION}_${OS}_${FRP_ARCH}/frpc" "$INSTALL_DIR/frpc"
chmod +x "$INSTALL_DIR/frpc"
ok "frpc installed at $INSTALL_DIR/frpc"

# ── Write client config ────────────────────────────────────────────────────
cat > "$INSTALL_DIR/frpc.toml" << TOML
# frp CLIENT config — SentinelNMS tunnel
serverAddr = "${SERVER_HOST}"
serverPort = ${BIND_PORT}

auth.method = "token"
auth.token  = "${FRP_TOKEN}"

log.to     = "${INSTALL_DIR}/frpc.log"
log.level  = "info"
log.maxDays = 3

# ── NMS web / API (HTTP + WebSocket) ──────────────────────────────────────
[[proxies]]
name       = "nms-web"
type       = "tcp"
localIP    = "127.0.0.1"
localPort  = 8765
remotePort = ${NMS_REMOTE_PORT}

# ── SNMP traps (UDP 162) ─────────────────────────────────────────────────
[[proxies]]
name       = "nms-snmp"
type       = "udp"
localIP    = "127.0.0.1"
localPort  = 162
remotePort = ${NMS_SNMP_PORT}
TOML

ok "Config written to $INSTALL_DIR/frpc.toml"

# ── Test connection ────────────────────────────────────────────────────────
info "Testing connection to $SERVER_HOST:$BIND_PORT ..."
if "$INSTALL_DIR/frpc" -c "$INSTALL_DIR/frpc.toml" &
then
  FPC_PID=$!
  sleep 3
  if curl -s --max-time 3 "http://localhost:8765/api/v1/ping" | grep -q "ok"; then
    ok "NMS is reachable locally ✓"
  else
    warn "NMS not responding locally — make sure Docker is running"
  fi
  kill $FPC_PID 2>/dev/null
fi

# ── Auto-start ────────────────────────────────────────────────────────────
if [[ "$OS" == "darwin" ]]; then
  # macOS LaunchAgent
  PLIST="$HOME/Library/LaunchAgents/com.nms.frp-tunnel.plist"
  cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nms.frp-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/frpc</string>
    <string>-c</string>
    <string>${INSTALL_DIR}/frpc.toml</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/frpc.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/frpc-err.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  ok "LaunchAgent installed — tunnel starts automatically at login"

else
  # Linux systemd user service
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/nms-frp-tunnel.service" << UNIT
[Unit]
Description=SentinelNMS frp Tunnel
After=network-online.target

[Service]
ExecStart=${INSTALL_DIR}/frpc -c ${INSTALL_DIR}/frpc.toml
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable nms-frp-tunnel
  systemctl --user start nms-frp-tunnel
  ok "systemd user service installed — tunnel starts automatically"
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        frp Tunnel client running!                           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  NMS web UI:  http://${SERVER_HOST}:${NMS_REMOTE_PORT}"
echo "  SNMP traps:  ${SERVER_HOST}:${NMS_SNMP_PORT} (UDP)"
echo ""
echo "  Open NMS Settings → Cloud Sync and set:"
echo -e "  ${CYAN}Server URL: http://${SERVER_HOST}:${NMS_REMOTE_PORT}${NC}"
echo ""
echo "  Logs:   tail -f ${INSTALL_DIR}/frpc.log"
if [[ "$OS" == "darwin" ]]; then
echo "  Stop:   launchctl unload ~/Library/LaunchAgents/com.nms.frp-tunnel.plist"
echo "  Start:  launchctl load   ~/Library/LaunchAgents/com.nms.frp-tunnel.plist"
fi
