#!/usr/bin/env bash
# NMS-Tool Server Auto-Update
#
# Keeps the dockerized server deployment in sync with GitHub master, and powers
# the admin "Update now" button in the web UI.
#
# Modes:
#   (no args)     cron auto mode — check origin/master, deploy if behind
#   --check       fetch + write data/update/check.json, never deploys
#   --triggered   consume UI trigger files (trigger-apply / trigger-check)
#                 written by the web API, then act on them
#   --install     register both cron jobs (10-min auto + 1-min trigger watcher)
#
# Progress is written as JSON to data/update/status.json — the directory is
# bind-mounted into the nms-api container, so the web UI can stream update
# progress live, even while the API container itself is being recreated.
#
# Logs: <repo>/data/auto-update.log

set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
LOG_FILE="$REPO_DIR/data/auto-update.log"
LOCK_FILE="/tmp/nms-auto-update.lock"
UPDATE_DIR="$REPO_DIR/data/update"
STATUS_FILE="$UPDATE_DIR/status.json"
CHECK_FILE="$UPDATE_DIR/check.json"

mkdir -p "$UPDATE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# write_status <phase> <step> <total> <message> [error]
write_status() {
    python3 - "$1" "$2" "$3" "$4" "${5:-}" "$FROM_COMMIT" "$TO_COMMIT" "$STARTED_AT" > "$STATUS_FILE.tmp" <<'PYEOF'
import json, sys, datetime
phase, step, total, message, error, frm, to, started = sys.argv[1:9]
print(json.dumps({
    "phase": phase,
    "step": int(step),
    "total": int(total),
    "message": message,
    "error": error or None,
    "from": frm or None,
    "to": to or None,
    "started_at": started or None,
    "updated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
}))
PYEOF
    mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

write_check() {
    local current remote behind commits
    current=$(git rev-parse --short HEAD)
    remote=$(git rev-parse --short origin/master)
    behind=$(git rev-list --count HEAD..origin/master)
    git log --pretty=format:'%h %s' HEAD..origin/master | head -10 > "$UPDATE_DIR/pending-commits.txt" || true
    python3 - "$current" "$remote" "$behind" "$UPDATE_DIR/pending-commits.txt" > "$CHECK_FILE.tmp" <<'PYEOF'
import json, sys, datetime
current, remote, behind, commits_path = sys.argv[1:5]
try:
    with open(commits_path) as f:
        commits = [l.strip() for l in f if l.strip()]
except OSError:
    commits = []
print(json.dumps({
    "current": current,
    "remote": remote,
    "behind": int(behind),
    "update_available": int(behind) > 0,
    "commits": commits,
    "checked_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
}))
PYEOF
    mv "$CHECK_FILE.tmp" "$CHECK_FILE"
    rm -f "$UPDATE_DIR/pending-commits.txt"
}

FROM_COMMIT=""
TO_COMMIT=""
STARTED_AT=""

# ─── --install: register cron jobs ──────────────────────────────────────────
if [ "${1:-}" = "--install" ]; then
    AUTO_LINE="*/10 * * * * /usr/bin/flock -n $LOCK_FILE bash $REPO_DIR/scripts/server-auto-update.sh >> $LOG_FILE 2>&1"
    TRIG_LINE="* * * * * { [ -f $UPDATE_DIR/trigger-apply ] || [ -f $UPDATE_DIR/trigger-check ]; } && /usr/bin/flock -n $LOCK_FILE bash $REPO_DIR/scripts/server-auto-update.sh --triggered >> $LOG_FILE 2>&1"
    # `|| true`: grep exits 1 on an empty crontab, which set -e would fatal on
    ( crontab -l 2>/dev/null | grep -v "server-auto-update.sh" || true ; echo "$AUTO_LINE" ; echo "$TRIG_LINE" ) | crontab -
    echo "Installed cron jobs:"
    echo "  auto    (10 min): $AUTO_LINE"
    echo "  trigger (1 min):  $TRIG_LINE"
    echo "Logs: $LOG_FILE"
    exit 0
fi

# ─── Resolve mode ────────────────────────────────────────────────────────────
MODE="auto"
if [ "${1:-}" = "--check" ]; then
    MODE="check"
elif [ "${1:-}" = "--triggered" ]; then
    if [ -f "$UPDATE_DIR/trigger-apply" ]; then
        rm -f "$UPDATE_DIR/trigger-apply" "$UPDATE_DIR/trigger-check"
        MODE="apply"
        log "UI trigger: apply update"
    elif [ -f "$UPDATE_DIR/trigger-check" ]; then
        rm -f "$UPDATE_DIR/trigger-check"
        MODE="check"
        log "UI trigger: check for updates"
    else
        exit 0   # trigger consumed by a previous run
    fi
fi

# ─── Check for new commits ──────────────────────────────────────────────────
git fetch origin master --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
write_check

if [ "$MODE" = "check" ]; then
    exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
    if [ "$MODE" = "apply" ]; then
        # Admin pressed the button but there is nothing to deploy — report it
        write_status "done" 5 5 "Already up to date — no new version on GitHub"
    fi
    exit 0   # auto mode stays quiet so the log only records real updates
fi

# ─── Update available — deploy it ───────────────────────────────────────────
FROM_COMMIT=$(git rev-parse --short HEAD)
TO_COMMIT=$(git rev-parse --short origin/master)
STARTED_AT=$(now_iso)

log "Update found: $FROM_COMMIT → $TO_COMMIT (mode: $MODE)"
log "  $(git log --oneline HEAD..origin/master | head -5 | tr '\n' '; ')"

write_status "pulling" 1 5 "Downloading new version from GitHub…"

# Back up any stray local edits instead of letting the pull fail — the server
# is a deploy target; all real changes must come through git.
if [ -n "$(git status --porcelain)" ]; then
    log "Local changes detected — stashing as backup"
    git stash push -u -m "auto-update backup $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE" 2>&1
fi

git pull --ff-only origin master --quiet
log "Pulled $(git rev-parse --short HEAD)"

# ─── Rebuild frontend (baked into the API image as frontend/dist) ──────────
write_status "frontend" 2 5 "Building web interface…"
log "Building frontend..."
if command -v node &>/dev/null; then
    ( cd frontend && npm install --silent && npm run build ) >> "$LOG_FILE" 2>&1
else
    docker run --rm -v "$REPO_DIR/frontend":/app -w /app node:20-alpine \
        sh -c "npm install --silent && npm run build" >> "$LOG_FILE" 2>&1
fi
log "Frontend built"

# ─── Rebuild + redeploy containers ──────────────────────────────────────────
write_status "containers" 3 5 "Rebuilding services — connection will drop for a moment…"
log "Rebuilding and restarting containers..."
( cd server && docker compose --env-file .env up -d --build ) >> "$LOG_FILE" 2>&1

# Drop dangling images left behind by the rebuild
docker image prune -f >> "$LOG_FILE" 2>&1

# ─── Wait for the new API: it applies DB migrations during startup ──────────
write_status "migrations" 4 5 "Applying database migrations and waiting for services…"
HEALTHY=false
for _ in $(seq 1 30); do
    sleep 5
    STATE=$(docker inspect --format '{{.State.Health.Status}}' nms-api 2>/dev/null || echo "missing")
    if [ "$STATE" = "healthy" ]; then HEALTHY=true; break; fi
done

write_check   # refresh "current" commit shown in the UI

if [ "$HEALTHY" = true ]; then
    write_status "done" 5 5 "Updated successfully to $(git rev-parse --short HEAD)"
    log "✅ Deployed $(git rev-parse --short HEAD) — nms-api is healthy"
else
    write_status "error" 4 5 "Services did not become healthy after the update" \
        "nms-api failed its health check — inspect with: docker logs nms-api"
    log "❌ nms-api is NOT healthy after deploy — check: docker logs nms-api"
    exit 1
fi
