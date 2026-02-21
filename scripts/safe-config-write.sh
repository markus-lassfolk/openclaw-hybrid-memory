#!/usr/bin/env bash
#
# safe-config-write.sh — Validate openclaw.json after any modification.
# Usage:
#   safe-config-write.sh                  # validate current config
#   safe-config-write.sh --watch          # watch for changes and auto-validate
#   safe-config-write.sh --restore        # restore last known good backup
#
# On validation failure:
#   1. Reverts to last known good config
#   2. Reports the error to GlitchTip (if DSN is set)
#   3. Exits with code 1
#
# Designed to be called after any config write, or run as a watcher.

set -uo pipefail

CONFIG="/home/markus/.openclaw/openclaw.json"
BACKUP="/home/markus/.openclaw/openclaw.json.lastgood"
GLITCHTIP_DSN="${GLITCHTIP_DSN:-http://7d641cabffdb4557a7bd2f02c338dc80@192.168.1.99:8000/1}"

# ── Validate config by checking JSON syntax + running a lightweight openclaw parse ──
validate_config() {
    local errors=""

    # 1. JSON syntax check (instant)
    if ! python3 -m json.tool "$CONFIG" > /dev/null 2>&1; then
        errors="JSON syntax error in $CONFIG"
        echo "❌ $errors" >&2
        return 1
    fi

    # 2. Schema check: detect unknown top-level keys
    local known_keys='["meta","wizard","update","auth","agents","tools","messages","commands","channels","talk","gateway","memory","plugins","models"]'
    local unknown
    unknown=$(python3 -c "
import json, sys
with open('$CONFIG') as f:
    cfg = json.load(f)
known = set($known_keys)
unknown = [k for k in cfg.keys() if k not in known]
if unknown:
    print(','.join(unknown))
" 2>&1)

    if [ -n "$unknown" ]; then
        errors="Unrecognized top-level keys in openclaw.json: $unknown"
        echo "❌ $errors" >&2
        return 1
    fi

    # 3. Critical fields check
    local missing
    missing=$(python3 -c "
import json
with open('$CONFIG') as f:
    cfg = json.load(f)
issues = []
if 'gateway' not in cfg:
    issues.append('missing gateway section')
if 'auth' not in cfg:
    issues.append('missing auth section')
if issues:
    print('; '.join(issues))
" 2>&1)

    if [ -n "$missing" ]; then
        errors="Critical config issues: $missing"
        echo "❌ $errors" >&2
        return 1
    fi

    return 0
}

# ── Report error to GlitchTip ──
report_error() {
    local message="$1"
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%S)

    # Parse DSN: http(s)://KEY@HOST/PROJECT_ID
    local key host project_id store_url scheme
    scheme=$(echo "$GLITCHTIP_DSN" | sed -n 's|\(https\?\)://.*|\1|p')
    key=$(echo "$GLITCHTIP_DSN" | sed -n 's|https\?://\([^@]*\)@.*|\1|p')
    host=$(echo "$GLITCHTIP_DSN" | sed -n 's|https\?://[^@]*@\([^/]*\)/.*|\1|p')
    project_id=$(echo "$GLITCHTIP_DSN" | sed -n 's|.*/\([0-9]*\)$|\1|p')
    store_url="${scheme}://${host}/api/${project_id}/store/"

    curl -s -X POST "$store_url" \
        -H "Content-Type: application/json" \
        -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=${key}" \
        -d "{
            \"event_id\": \"$(python3 -c 'import uuid; print(uuid.uuid4().hex)')\",
            \"timestamp\": \"${timestamp}\",
            \"level\": \"error\",
            \"logger\": \"config-validator\",
            \"platform\": \"other\",
            \"message\": {\"formatted\": \"${message}\"},
            \"tags\": {\"source\": \"safe-config-write\", \"host\": \"$(hostname)\"},
            \"extra\": {\"config_path\": \"${CONFIG}\"}
        }" > /dev/null 2>&1 && echo "📡 Error reported to GlitchTip" >&2
}

# ── Save backup of known-good config ──
save_backup() {
    cp "$CONFIG" "$BACKUP"
    echo "💾 Saved known-good config backup" >&2
}

# ── Restore from backup ──
restore_backup() {
    if [ -f "$BACKUP" ]; then
        cp "$BACKUP" "$CONFIG"
        echo "⏪ Restored config from last known good backup" >&2
        return 0
    else
        echo "❌ No backup found at $BACKUP" >&2
        return 1
    fi
}

# ── Main ──
case "${1:-validate}" in
    --watch)
        echo "👁️  Watching $CONFIG for changes..."
        # Save current as known good if valid
        if validate_config; then
            save_backup
        fi
        # Watch for modifications (requires inotifywait)
        if ! command -v inotifywait &>/dev/null; then
            echo "Install inotify-tools: sudo apt install inotify-tools" >&2
            exit 1
        fi
        while inotifywait -q -e modify "$CONFIG" > /dev/null 2>&1; do
            sleep 0.5  # debounce
            echo "🔍 Config changed, validating..."
            if validate_config; then
                save_backup
                echo "✅ Config valid"
            else
                report_error "Config validation failed after modification — auto-reverting"
                restore_backup
            fi
        done
        ;;
    --restore)
        restore_backup
        ;;
    *)
        # One-shot validate
        if validate_config; then
            save_backup
            echo "✅ Config valid"
            exit 0
        else
            report_error "openclaw.json validation failed"
            if [ -f "$BACKUP" ]; then
                restore_backup
            fi
            exit 1
        fi
        ;;
esac
