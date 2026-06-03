#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SentinelNMS — frp Tunnel SERVER setup
# Run this on your RustDesk server (or any Linux VPS with a public IP).
#
# What it does:
#   • Downloads frp (Fast Reverse Proxy) — a standalone binary, no dependencies
#   • Installs frps (server) as a systemd service on port 7800
#   • Does NOT touch RustDesk ports (21115-21119) — zero interference
#
# Usage:
#   ssh user@your-server
#   bash <(curl -s https://raw.githubusercontent.com/var2611/NMS-Tool/master/scripts/setup-tunnel-server.sh)
#
#   OR copy and run manually:
#   chmod +x setup-tunnel-server.sh && sudo ./setup-tunnel-server.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

FRP_VERSION="0.61.1"
FRP_TOKEN="${NMS_TUNNEL_TOKEN:-$(openssl rand -hex 16)}"
BIND_PORT=7800          # frp control channel — NOT used by RustDesk
NMS_REMOTE_PORT=18765   # NMS web/API exposed on this public port
NMS_SNMP_PORT=16200     # SNMP trap UDP port (optional)

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${CYAN}[frp-server]${NC} $1"; }
ok()    { echo -e "${GREEN}[frp-server]${NC} $1"; }
warn()  { echo -e "${YELLOW}[frp-server]${NC} $1"; }

ARCH=$(uname -m)
case $ARCH in
  x86_64)  FRP_ARCH="amd64" ;;
  aarch64) FRP_ARCH="arm64" ;;
  armv7l)  FRP_ARCH="arm"   ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

info "Installing frp v${FRP_VERSION} (${FRP_ARCH}) on this server"
info "RustDesk ports (21115-21119) are NOT touched"

# ── Download ───────────────────────────────────────────────────────────────
FRP_DIR="/opt/frp"
mkdir -p "$FRP_DIR"
TARBALL="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}"

info "Downloading frp from GitHub..."
curl -fsSL "$URL" | tar xz -C /tmp
cp "/tmp/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps" "$FRP_DIR/frps"
chmod +x "$FRP_DIR/frps"
ok "frps binary installed at $FRP_DIR/frps"

# ── Config ─────────────────────────────────────────────────────────────────
cat > "$FRP_DIR/frps.toml" << TOML
# frp SERVER config — SentinelNMS tunnel
# This coexists with RustDesk; all ports are different.

bindPort     = ${BIND_PORT}          # control channel (desktop connects here)
bindUDPPort  = ${BIND_PORT}          # UDP proxy support for SNMP traps

# Token — desktop client must use the same token
auth.method = "token"
auth.token  = "${FRP_TOKEN}"

# Logging
log.to     = "/var/log/frps-nms.log"
log.level  = "info"
log.maxDays = 3
TOML

ok "Config written to $FRP_DIR/frps.toml"

# ── systemd service ────────────────────────────────────────────────────────
cat > /etc/systemd/system/frps-nms.service << UNIT
[Unit]
Description=frp Tunnel Server — SentinelNMS
After=network.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${FRP_DIR}/frps -c ${FRP_DIR}/frps.toml
Restart=always
RestartSec=5
User=nobody

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable frps-nms
systemctl restart frps-nms
ok "systemd service 'frps-nms' started"

# ── Firewall ───────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow ${BIND_PORT}/tcp   comment "frp NMS control" 2>/dev/null || true
  ufw allow ${NMS_REMOTE_PORT}/tcp comment "frp NMS web" 2>/dev/null || true
  ufw allow ${NMS_SNMP_PORT}/udp   comment "frp NMS SNMP" 2>/dev/null || true
  ok "UFW rules added"
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=${BIND_PORT}/tcp
  firewall-cmd --permanent --add-port=${NMS_REMOTE_PORT}/tcp
  firewall-cmd --permanent --add-port=${NMS_SNMP_PORT}/udp
  firewall-cmd --reload
  ok "firewalld rules added"
fi

# ── Summary ────────────────────────────────────────────────────────────────
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        frp Server installed successfully!            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Server IP:       $SERVER_IP"
echo "  Control port:    $BIND_PORT (frp handshake)"
echo "  NMS web port:    $NMS_REMOTE_PORT  → http://$SERVER_IP:$NMS_REMOTE_PORT"
echo "  SNMP trap port:  $NMS_SNMP_PORT (UDP)"
echo ""
echo -e "${YELLOW}  TOKEN (save this — you need it for the client):${NC}"
echo -e "${CYAN}  $FRP_TOKEN${NC}"
echo ""
echo "  RustDesk ports 21115-21119 are untouched ✓"
echo ""
echo "  Next: run  scripts/setup-tunnel-client.sh  on your Mac/desktop"
echo "  and enter the token above when prompted."
echo ""
echo "  Logs:  journalctl -u frps-nms -f"
