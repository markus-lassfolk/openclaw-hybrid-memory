#!/usr/bin/env bash
# Force-release the OpenClaw gateway port (default 18789)
#
# Use when "Port 18789 is already in use" or the gateway won't start because
# the port is held by a stale process or the kernel (TIME_WAIT). This script:
#   1. Stops the systemd gateway service (if present)
#   2. Finds any process listening on the port (ss, lsof, or fuser)
#   3. Sends SIGTERM, waits, then SIGKILL if the port is still in use
#
# Copy to ~/.openclaw/scripts/ and chmod +x. Set OPENCLAW_GATEWAY_PORT if different.
# Usage: ./scripts/force-release-gateway-port.sh
set -euo pipefail

PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_CMD="${OPENCLAW_CMD:-openclaw}"

echo "Force-releasing port $PORT (OpenClaw gateway)..."

# ─── Stop systemd gateway so we don't fight with it ───
if systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null; then
    echo "  Stopping systemd openclaw-gateway.service..."
    "$OPENCLAW_CMD" gateway stop 2>/dev/null || systemctl --user stop openclaw-gateway.service 2>/dev/null || true
    sleep 2
fi

# ─── Collect PIDs that are using the port ───
pids=""

# Method 1: ss -tlnp (Linux; may not show pid for non-root)
if command -v ss &>/dev/null; then
    pids=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
fi

# Method 2: lsof -i :PORT
if [ -z "$pids" ] && command -v lsof &>/dev/null; then
    pids=$(lsof -ti ":$PORT" 2>/dev/null | sort -u || true)
fi

# Method 3: fuser (outputs "PORT/tcp: pid1 pid2" to stderr)
if [ -z "$pids" ] && command -v fuser &>/dev/null; then
    pids=$(fuser "$PORT/tcp" 2>&1 | sed 's/.*://; s/^ *//' | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true)
fi

if [ -n "$pids" ]; then
    for pid in $pids; do
        [ -z "$pid" ] && continue
        if kill -0 "$pid" 2>/dev/null; then
            echo "  Killing PID $pid (listening on :$PORT)..."
            kill "$pid" 2>/dev/null || true
        fi
    done
    sleep 3
    # If port still in use, force kill
    pids2=""
    command -v ss &>/dev/null && pids2=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' || true)
    [ -z "$pids2" ] && command -v lsof &>/dev/null && pids2=$(lsof -ti ":$PORT" 2>/dev/null || true)
    [ -z "$pids2" ] && command -v fuser &>/dev/null && pids2=$(fuser "$PORT/tcp" 2>&1 | sed 's/.*://; s/^ *//' | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true)
    if [ -n "$pids2" ]; then
        for pid in $pids2; do
            [ -z "$pid" ] && continue
            echo "  Force killing PID $pid (SIGKILL)..."
            kill -9 "$pid" 2>/dev/null || true
        done
        sleep 2
    fi
fi

# ─── Report ───
if command -v ss &>/dev/null && ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
    echo "  WARN: Port $PORT still in use (process may not have exited yet, or socket in TIME_WAIT)."
    echo "  If no process is listed below, wait 60–120s for TIME_WAIT to clear, then try again."
    ss -tlnp 2>/dev/null | grep ":$PORT " || true
elif command -v lsof &>/dev/null && lsof -i ":$PORT" 2>/dev/null | grep -q .; then
    echo "  WARN: Port $PORT still in use."
    lsof -i ":$PORT" 2>/dev/null || true
else
    echo "  Port $PORT is free. You can start the gateway: openclaw gateway run"
fi
