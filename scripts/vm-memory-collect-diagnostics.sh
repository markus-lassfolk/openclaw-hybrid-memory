#!/usr/bin/env bash
# Deep diagnostic bundle for a memory alert incident directory.
# Usage: vm-memory-collect-diagnostics.sh /path/to/incident-dir
set -euo pipefail

INCIDENT_DIR="${1:?incident directory required}"
export HOME="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
JOURNAL_LINES="${VM_MEMORY_JOURNAL_LINES:-800}"
HEAP_SNAPSHOT="${VM_MEMORY_HEAP_SNAPSHOT:-0}"
TOKFILE="${GATEWAY_TOKEN_FILE:-$OPENCLAW_HOME/.secrets/gateway-token}"
LOG="$OPENCLAW_HOME/logs/vm-memory-collect-diagnostics.log"
LIVE_DEST="$INCIDENT_DIR/memory-diagnostics-live.json"
MANIFEST_DEST="$INCIDENT_DIR/incident-manifest.json"

mkdir -p "$INCIDENT_DIR" "$(dirname "$LOG")"
log() { echo "[$(date -Iseconds)] $*" >>"$LOG"; }

json_escape_env_writer() {
	STATUS="$1" ERROR_TEXT="$2" EXIT_CODE="$3" TIMED_OUT="$4" STDERR_FILE="${5:-}" node <<'NODE'
const fs = require('node:fs');
const stderrFile = process.env.STDERR_FILE || '';
let stderr = '';
if (stderrFile && fs.existsSync(stderrFile)) stderr = fs.readFileSync(stderrFile, 'utf8').trim();
const mem = process.memoryUsage();
const envelope = {
  ok: false,
  status: process.env.STATUS,
  error: process.env.ERROR_TEXT,
  exitCode: Number(process.env.EXIT_CODE || '-1'),
  timedOut: process.env.TIMED_OUT === 'true',
  timestamp: new Date().toISOString(),
  fallbackMemory: {
    rssBytes: mem.rss,
    heapTotalBytes: mem.heapTotal,
    heapUsedBytes: mem.heapUsed,
  },
};
if (stderr) envelope.stderr = stderr.slice(0, 8192);
process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
NODE
}

atomic_write_text() {
	local dest="$1"
	local tmp="${dest}.tmp-$$-$RANDOM"
	cat >"$tmp"
	mv -f "$tmp" "$dest"
}

write_failure() {
	local status="$1" error_text="$2" exit_code="$3" timed_out="$4" stderr_file="${5:-}"
	json_escape_env_writer "$status" "$error_text" "$exit_code" "$timed_out" "$stderr_file" | atomic_write_text "$LIVE_DEST"
}

validate_non_empty_json() {
	local path="$1"
	[[ -s "$path" ]] || return 2
	node -e 'const fs=require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"));' "$path" >/dev/null 2>&1
}

write_manifest() {
	MANIFEST_DEST="$MANIFEST_DEST" INCIDENT_DIR="$INCIDENT_DIR" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.INCIDENT_DIR;
const manifestPath = process.env.MANIFEST_DEST;
const critical = new Set(['memory-diagnostics-live.json', 'snapshot.json', 'leak-report.json']);
const names = new Set([...critical]);
try {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name !== path.basename(manifestPath)) names.add(ent.name);
  }
} catch {}
const artifacts = [];
const warnings = [];
for (const filename of [...names].sort()) {
  const full = path.join(dir, filename);
  let missing = !fs.existsSync(full);
  let size = -1;
  if (!missing) {
    try { size = fs.statSync(full).size; } catch { missing = true; }
  }
  const empty = !missing && size === 0;
  const item = { filename, size, missing, empty, critical: critical.has(filename) };
  artifacts.push(item);
  if (item.critical && item.missing) warnings.push(`Critical artifact missing: ${filename}`);
  else if (item.critical && item.empty) warnings.push(`Critical artifact is empty (0 bytes): ${filename}`);
}
const manifest = { timestamp: new Date().toISOString(), bundleDir: dir, artifacts, warnings };
const tmp = `${manifestPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, manifestPath);
NODE
}

log "collect start dir=$INCIDENT_DIR"

# Gateway journal
if systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null; then
	journalctl --user -u openclaw-gateway.service -n "$JOURNAL_LINES" --no-pager \
		>"$INCIDENT_DIR/journal-gateway.txt" 2>/dev/null || true
	systemctl --user show openclaw-gateway.service -p MainPID,MemoryCurrent,MemoryPeak,MemoryMax,ActiveState \
		>"$INCIDENT_DIR/systemd-gateway.txt" 2>/dev/null || true
fi

# Live HTTP diagnostics from hybrid-memory. Never redirect curl directly to the final
# artifact: curl creates/truncates the destination before it knows whether the gateway
# will return valid JSON. Capture to a temp file, validate, then atomically promote.
if [[ -r "$TOKFILE" ]]; then
	TOK="$(tr -d '\n\r' <"$TOKFILE")"
	QUERY=""
	if [[ "$HEAP_SNAPSHOT" == "1" ]]; then
		QUERY="?heapSnapshot=1"
	fi
	tmp_live="${LIVE_DEST}.tmp-$$-$RANDOM"
	tmp_err="${LIVE_DEST}.stderr-$$-$RANDOM"
	if curl -fsS -m 30 -H "Authorization: Bearer $TOK" \
		"http://127.0.0.1:${PORT}/plugins/memory-public/memory-diagnostics${QUERY}" \
		>"$tmp_live" 2>"$tmp_err"; then
		if validate_non_empty_json "$tmp_live"; then
			mv -f "$tmp_live" "$LIVE_DEST"
			log "memory-diagnostics HTTP ok heap=$HEAP_SNAPSHOT"
		elif [[ ! -s "$tmp_live" ]]; then
			write_failure "empty_output" "memory-diagnostics endpoint returned an empty response" 0 false "$tmp_err"
			log "memory-diagnostics HTTP returned empty output"
		else
			write_failure "invalid_json" "memory-diagnostics endpoint returned non-JSON output" 0 false "$tmp_err"
			log "memory-diagnostics HTTP returned invalid JSON"
		fi
	else
		code=$?
		status="command_failed"
		timed_out="false"
		if [[ "$code" == "28" ]]; then
			status="timeout"
			timed_out="true"
		fi
		write_failure "$status" "memory-diagnostics HTTP request failed" "$code" "$timed_out" "$tmp_err"
		log "memory-diagnostics HTTP failed exit=$code status=$status"
	fi
	rm -f "$tmp_live" "$tmp_err"
else
	write_failure "command_failed" "gateway token file is not readable: $TOKFILE" -1 false ""
	log "memory-diagnostics skipped: token file not readable"
fi

# Process list (gateway family)
ps ax -o pid,ppid,etimes,rss,vsz,comm,args 2>/dev/null | grep -E 'openclaw|gateway|PID' \
	>"$INCIDENT_DIR/ps-gateway.txt" || true

# Cgroup memory files
CG="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/openclaw-gateway.service"
if [[ -d "$CG" ]]; then
	{
		echo "memory.current=$(cat "$CG/memory.current" 2>/dev/null || echo n/a)"
		echo "memory.peak=$(cat "$CG/memory.peak" 2>/dev/null || echo n/a)"
		echo "memory.max=$(cat "$CG/memory.max" 2>/dev/null || echo n/a)"
	} >"$INCIDENT_DIR/cgroup-memory.txt"
fi

# Tail recent snapshot / hint logs
for f in vm-memory-snapshot.jsonl vm-memory-leak-hints.jsonl vm-memory-alerts.jsonl; do
	p="$OPENCLAW_HOME/logs/$f"
	if [[ -f "$p" ]]; then
		tail -n 48 "$p" >"$INCIDENT_DIR/recent-${f%.jsonl}.tail" 2>/dev/null || true
	fi
done

# openclaw diagnostics export (best-effort; may need Node 22+)
if command -v openclaw >/dev/null 2>&1; then
	timeout 120 openclaw gateway diagnostics export \
		--output "$INCIDENT_DIR/openclaw-diagnostics.zip" \
		--timeout 15000 \
		>>"$LOG" 2>&1 || log "openclaw diagnostics export skipped/failed"
fi

write_manifest
log "collect done dir=$INCIDENT_DIR"
