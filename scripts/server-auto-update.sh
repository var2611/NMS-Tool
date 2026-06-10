#!/usr/bin/env bash
# NMS-Tool Server Auto-Update
#
# Checks GitHub for new commits on master; when found, pulls, rebuilds the
# frontend + Docker image, and redeploys — zero-touch updates for the server.
#
# Install (adds a cron entry checking every 10 minutes):
#   bash scripts/server-auto-update.sh --install
#
# Run a single check manually:
#   bash scripts/server-auto-update.sh
#
# Logs: <repo>/data/auto-update.log

set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
LOG_FILE="$REPO_DIR/data/auto-update.log"
LOCK_FILE="/tmp/nms-auto-update.lock"

mkdir -p "$REPO_DIR/data"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

# ─── --install: register cron job ──────────────────────────────────────────
if [ "${1:-}" = "--install" ]; then
    CRON_LINE="*/10 * * * * /usr/bin/flock -n $LOCK_FILE bash $REPO_DIR/scripts/server-auto-update.sh >> $LOG_FILE 2>&1"
    ( crontab -l 2>/dev/null | grep -v "server-auto-update.sh" ; echo "$CRON_LINE" ) | crontab -
    echo "Installed cron job (every 10 min):"
    echo "  $CRON_LINE"
    echo "Logs: $LOG_FILE"
    exit 0
fi

# ─── Check for new commits ──────────────────────────────────────────────────
git fetch origin master --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [ "$LOCAL" = "$REMOTE" ]; then
    # Up to date — stay quiet so the log only records actual update events
    exit 0
fi

log "Update found: $(git rev-parse --short HEAD) → $(git rev-parse --short origin/master)"
log "  $(git log --oneline HEAD..origin/master | head -5 | tr '\n' '; ')"

# Back up any stray local edits instead of letting the pull fail — the server
# is a deploy target; all real changes must come through git.
if [ -n "$(git status --porcelain)" ]; then
    log "Local changes detected — stashing as backup"
    git stash push -u -m "auto-update backup $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE" 2>&1
fi

git pull --ff-only origin master --quiet
log "Pulled $(git rev-parse --short HEAD)"

# ─── Rebuild frontend (baked into the API image as frontend/dist) ──────────
log "Building frontend..."
if command -v node &>/dev/null; then
    ( cd frontend && npm install --silent && npm run build ) >> "$LOG_FILE" 2>&1
else
    docker run --rm -v "$REPO_DIR/frontend":/app -w /app node:20-alpine \
        sh -c "npm install --silent && npm run build" >> "$LOG_FILE" 2>&1
fi
log "Frontend built"

# ─── Rebuild + redeploy containers ──────────────────────────────────────────
log "Rebuilding and restarting containers..."
( cd server && docker compose --env-file .env up -d --build ) >> "$LOG_FILE" 2>&1

# Drop dangling images left behind by the rebuild
docker image prune -f >> "$LOG_FILE" 2>&1

# ─── Health check ────────────────────────────────────────────────────────────
sleep 15
if docker ps --filter "name=nms-api" --filter "status=running" | grep -q nms-api; then
    log "✅ Deployed $(git rev-parse --short HEAD) — nms-api is running"
else
    log "❌ nms-api is NOT running after deploy — check: docker logs nms-api"
    exit 1
fi
