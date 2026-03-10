#!/usr/bin/env bash
# Gateway Watchdog (cron-only, no systemd)
#
# Run from crontab every 5 minutes. Does NOT use systemd. Checks if the
# OpenClaw gateway is running and responsive; if not, restores last-known-good
# config (keeps 3 snapshots) and tries each in reverse order until the gateway
# is healthy again. Starts the gateway with "openclaw gateway run" in the
# background when recovering (suitable for WSL2, containers, or when systemd
# user is unavailable).
#
# Crontab example:
#   */5 * * * * /home/markus/.openclaw/scripts/gateway-watchdog-cron.sh >> /home/markus/.openclaw/logs/watchdog.log 2>&1
#
# Copy to ~/.openclaw/scripts/ and chmod +x. Set OPENCLAW_HOME if your state dir is elsewhere.
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG="$OPENCLAW_HOME/openclaw.json"
BACKUP_DIR="$OPENCLAW_HOME/config-backups"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_CMD="${OPENCLAW_CMD:-openclaw}"
LOCKFILE="/tmp/openclaw-gateway-watchdog.lock"
LOGFILE="$OPENCLAW_HOME/logs/watchdog.log"
MAX_GOOD_SNAPSHOTS=3
MAX_RECOVERY_ATTEMPTS=3
RECOVERY_COUNTER="/tmp/openclaw-recovery-count"
START_WAIT=20
mkdir -p "$BACKUP_DIR" "$(dirname "$LOGFILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGFILE"; }

# Prevent concurrent runs
exec 200>"$LOCKFILE"
flock -n 200 || { log "SKIP: another watchdog instance running"; exit 0; }

# ─── Health check: is gateway running and responsive? (no systemd) ───
gateway_healthy() {
    OPENCLAW_GATEWAY_PORT="$PORT" "$OPENCLAW_CMD" gateway probe &>/dev/null
}

# ─── Kill whatever is listening on the gateway port ───
kill_port() {
    local pids
    pids=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
    if [ -n "$pids" ]; then
        for pid in $pids; do
            log "  Killing PID $pid on port $PORT"
            kill "$pid" 2>/dev/null || true
        done
        sleep 3
    fi
}

# ─── Start gateway in background (cron-only; no systemd) ───
start_gateway_bg() {
    kill_port
    log "  Starting gateway: $OPENCLAW_CMD gateway run --port $PORT"
    ( OPENCLAW_GATEWAY_PORT="$PORT" nohup "$OPENCLAW_CMD" gateway run --port "$PORT" >> "$LOGFILE" 2>&1 & )
    sleep "$START_WAIT"
}

# ─── Stamp current config as a last-good snapshot (keep N most recent) ───
stamp_last_good() {
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    cp "$CONFIG" "$BACKUP_DIR/openclaw.json.good.$ts"
    log "  Stamped last-good: openclaw.json.good.$ts"
    local snapshots
    snapshots=$(ls -1t "$BACKUP_DIR"/openclaw.json.good.* 2>/dev/null | tail -n +$((MAX_GOOD_SNAPSHOTS + 1)))
    if [ -n "$snapshots" ]; then
        echo "$snapshots" | xargs rm -f
        log "  Pruned old snapshots, keeping $MAX_GOOD_SNAPSHOTS most recent"
    fi
}

# ─── List good snapshots newest-first ───
list_good_snapshots() {
    ls -1t "$BACKUP_DIR"/openclaw.json.good.* 2>/dev/null
}

# ─── Main: health check ─────────────────────────────────────────────
if gateway_healthy; then
    # Gateway is responsive. Optionally stamp current config as last-good (if changed).
    latest=$(ls -1t "$BACKUP_DIR"/openclaw.json.good.* 2>/dev/null | head -n1)
    if [ -n "$latest" ]; then
        if ! cmp -s "$CONFIG" "$latest" 2>/dev/null; then
            stamp_last_good
            log "OK: Gateway healthy. Config changed → stamped new last-good."
        fi
    else
        stamp_last_good
        log "OK: Gateway healthy. No previous good snapshot → stamped."
    fi
    [ -f "$RECOVERY_COUNTER" ] && rm -f "$RECOVERY_COUNTER"
    exit 0
fi

# ─── Gateway not responsive — recovery ───────────────────────────────
ATTEMPTS=0
[ -f "$RECOVERY_COUNTER" ] && ATTEMPTS=$(cat "$RECOVERY_COUNTER" 2>/dev/null || echo 0)

if [ "$ATTEMPTS" -ge "$MAX_RECOVERY_ATTEMPTS" ]; then
    log "CRITICAL: Recovery attempts ($ATTEMPTS) exceeded. Manual fix needed."
    exit 1
fi

ATTEMPTS=$((ATTEMPTS + 1))
echo "$ATTEMPTS" > "$RECOVERY_COUNTER"
log "RECOVERY attempt $ATTEMPTS/$MAX_RECOVERY_ATTEMPTS"

# Step 1: Kill stale process and try current config
log "Step 1: Killing stale process on :$PORT and starting with current config..."
start_gateway_bg
if gateway_healthy; then
    log "OK: Gateway started with current config (attempt $ATTEMPTS)"
    rm -f "$RECOVERY_COUNTER"
    exit 0
fi

# Step 2: Try each last-good snapshot, newest first
SNAPSHOTS=$(list_good_snapshots)
if [ -n "$SNAPSHOTS" ]; then
    for snapshot in $SNAPSHOTS; do
        if cmp -s "$CONFIG" "$snapshot" 2>/dev/null; then
            log "Step 2: Snapshot $(basename "$snapshot") equals current config — skipping"
            continue
        fi
        log "Step 2: Restoring $(basename "$snapshot") and starting gateway..."
        cp "$CONFIG" "$CONFIG.bad.$(date +%s)"
        cp "$snapshot" "$CONFIG"
        start_gateway_bg
        if gateway_healthy; then
            log "OK: Gateway started after restoring $(basename "$snapshot")"
            rm -f "$RECOVERY_COUNTER"
            exit 0
        fi
        log "WARN: Snapshot $(basename "$snapshot") did not bring gateway up"
    done
else
    log "Step 2: No last-good snapshots in $BACKUP_DIR. Skipping restore."
fi

log "FAIL: Recovery attempt $ATTEMPTS/$MAX_RECOVERY_ATTEMPTS failed. Will retry in 5 min."
exit 1
