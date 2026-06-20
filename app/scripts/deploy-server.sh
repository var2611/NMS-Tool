#!/usr/bin/env bash
# NMS-Tool Server Deployment Script
# Run on your Linux server: bash scripts/deploy-server.sh

set -e
cd "$(dirname "$0")/.."

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${CYAN}[DEPLOY]${NC} $1"; }
ok()   { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[DEPLOY]${NC} $1"; }

# Check docker
if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
fi

if ! command -v docker compose &>/dev/null && ! docker compose version &>/dev/null 2>&1; then
    info "Installing Docker Compose..."
    sudo apt-get install -y docker-compose-plugin
fi

# Create .env if needed
if [ ! -f server/.env ]; then
    cp server/.env.example server/.env
    warn "Created server/.env — EDIT IT NOW with your passwords before continuing!"
    warn "  nano server/.env"
    echo ""
    read -p "Press Enter after editing server/.env..."
fi

# Build frontend
if [ ! -d "frontend/dist" ] || [ "$1" = "--rebuild" ]; then
    info "Building React frontend..."
    if command -v node &>/dev/null; then
        cd frontend && npm install && npm run build && cd ..
    else
        info "Node not found — building in Docker..."
        docker run --rm -v $(pwd)/frontend:/app -w /app node:20-alpine sh -c "npm install && npm run build"
    fi
    ok "Frontend built"
fi

# SSL placeholder (self-signed for testing)
mkdir -p server/ssl
if [ ! -f server/ssl/cert.pem ]; then
    info "Generating self-signed SSL certificate (replace with real cert for production)..."
    openssl req -x509 -newkey rsa:4096 -keyout server/ssl/key.pem -out server/ssl/cert.pem \
        -days 365 -nodes -subj "/CN=nms-tool" 2>/dev/null
    ok "SSL cert generated (self-signed — replace with Let's Encrypt for production)"
fi

# Deploy
info "Deploying NMS-Tool server..."
cd server
docker compose --env-file .env up -d --build

ok ""
ok "✅ NMS-Tool Server deployed!"
ok ""
ok "   Access:  https://$(hostname -I | awk '{print $1}')"
ok "   API docs: https://$(hostname -I | awk '{print $1}')/docs"
ok "   Login:   admin / admin  ← CHANGE THIS!"
ok ""
ok "   View logs:  docker compose logs -f"
ok "   Stop:       docker compose down"
ok ""
warn "IMPORTANT: Change the default admin password immediately!"
warn "IMPORTANT: Replace server/ssl/cert.pem with a real Let's Encrypt certificate!"
