#!/usr/bin/env bash
# NMS-Tool startup script
# Usage:
#   ./scripts/start.sh          — start backend + open browser
#   ./scripts/start.sh dev      — start with frontend dev server (hot reload)
#   ./scripts/start.sh install  — first-time setup (venv + npm install)

set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)

MODE=${1:-run}
VENV="$ROOT/venv"
PYTHON="$VENV/bin/python"
PIP="$VENV/bin/pip"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${CYAN}[NMS]${NC} $1"; }
ok()   { echo -e "${GREEN}[NMS]${NC} $1"; }
warn() { echo -e "${YELLOW}[NMS]${NC} $1"; }
err()  { echo -e "${RED}[NMS]${NC} $1"; exit 1; }

# ─── Install ──────────────────────────────────────────────────────────────────
if [ "$MODE" = "install" ]; then
    info "Creating Python virtual environment..."
    python3 -m venv venv
    ok "venv created"

    info "Installing Python dependencies..."
    $PIP install --upgrade pip -q
    $PIP install -r requirements.txt -q
    ok "Python deps installed"

    info "Installing Node.js frontend dependencies..."
    cd frontend && npm install && cd ..
    ok "Node deps installed"

    # Create .env from example
    if [ ! -f .env ]; then
        cp .env.example .env
        ok ".env created from .env.example — edit it to configure"
    fi

    # Create data directory
    mkdir -p data/mibs

    ok "✅ NMS-Tool installed! Run: ./scripts/start.sh"
    exit 0
fi

# ─── Check venv ───────────────────────────────────────────────────────────────
if [ ! -f "$PYTHON" ]; then
    err "Python venv not found. Run: ./scripts/start.sh install"
fi

if [ ! -f ".env" ]; then
    cp .env.example .env
    warn ".env created from example. Edit it to configure."
fi

mkdir -p data/mibs

# ─── Dev Mode (frontend hot reload) ───────────────────────────────────────────
if [ "$MODE" = "dev" ]; then
    info "Starting NMS-Tool in development mode..."
    
    # Start backend
    $PYTHON -m uvicorn api.main:app \
        --host 127.0.0.1 --port 8765 --reload &
    BACKEND_PID=$!
    
    # Wait for backend
    info "Waiting for backend..."
    for i in $(seq 1 30); do
        if curl -s http://127.0.0.1:8765/api/v1/ping > /dev/null 2>&1; then
            ok "Backend ready"
            break
        fi
        sleep 1
    done
    
    # Start frontend dev server
    cd frontend && npm run dev &
    FRONTEND_PID=$!
    cd ..
    
    ok "🚀 NMS-Tool running!"
    ok "   Dashboard: http://localhost:3000"
    ok "   API docs:  http://localhost:8765/docs"
    ok "   Login:     admin / admin"
    echo ""
    
    # Open browser
    sleep 2
    if command -v xdg-open &>/dev/null; then xdg-open http://localhost:3000
    elif command -v open &>/dev/null; then open http://localhost:3000; fi
    
    # Cleanup on exit
    trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'NMS-Tool stopped'" EXIT
    wait

# ─── Production Run ───────────────────────────────────────────────────────────
else
    # Build frontend if dist doesn't exist
    if [ ! -d "frontend/dist" ]; then
        info "Building frontend..."
        cd frontend && npm install -q && npm run build && cd ..
        ok "Frontend built"
    fi

    info "Starting NMS-Tool..."
    
    $PYTHON -m uvicorn api.main:app \
        --host 127.0.0.1 --port 8765 &
    BACKEND_PID=$!
    
    # Wait for backend
    info "Waiting for backend to start..."
    for i in $(seq 1 30); do
        if curl -s http://127.0.0.1:8765/api/v1/ping > /dev/null 2>&1; then
            ok "Backend ready ✓"
            break
        fi
        sleep 1
    done
    
    ok "🚀 NMS-Tool is running!"
    ok "   Open: http://localhost:8765"
    ok "   Login: admin / admin"
    echo ""
    
    # Open browser
    sleep 1
    if command -v xdg-open &>/dev/null; then xdg-open http://localhost:8765
    elif command -v open &>/dev/null; then open http://localhost:8765; fi
    
    trap "kill $BACKEND_PID 2>/dev/null; echo 'NMS-Tool stopped'" EXIT
    wait $BACKEND_PID
fi
