#!/usr/bin/env bash
# Task queue runner — Issue #1000
#
# Ensures ~/.openclaw/workspace/state/task-queue/current.json exists (idle
# placeholder), prints status JSON for cron prompts, and can wrap shell commands
# with queue lifecycle (PID in current.json, history on completion, idle
# restore). Uses flock so only one mutating instance runs at a time.
#
# Crontab examples:
#   # Keep status file present for strategic / heartbeat jobs (no gateway required)
#   */10 * * * * OPENCLAW_HOME=$HOME/.openclaw /path/to/openclaw-hybrid-memory/scripts/task-queue.sh touch >>$HOME/.openclaw/logs/task-queue.log 2>&1
#
#   # Print queue JSON for a job script (after touch has run at least once)
#   0 8 * * * .../task-queue.sh status
#
# Copy to ~/.openclaw/scripts/ and chmod +x if you prefer a stable path outside the repo.
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
STATE_DIR="${TASK_QUEUE_STATE_DIR:-$OPENCLAW_HOME/workspace/state/task-queue}"
OPENCLAW_CMD="${OPENCLAW_CMD:-openclaw}"
LOCKFILE="${TASK_QUEUE_LOCKFILE:-/tmp/openclaw-task-queue.lock}"
RUN_PRODUCER="task-queue.sh"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }

# --- flock: exclusive lock for mutating operations (fd 200) ---
with_lock() {
  exec 200>"$LOCKFILE"
  if ! flock -n 200; then
    log "SKIP: another task-queue runner holds the lock ($LOCKFILE)"
    exit 0
  fi
  "$@"
}

# Same as with_lock but exit 2 when contended (so callers know work did not run).
with_lock_run() {
  exec 200>"$LOCKFILE"
  if ! flock -n 200; then
    log "SKIP: another task-queue runner holds the lock ($LOCKFILE)"
    exit 2
  fi
  "$@"
}

cmd_touch() {
  with_lock _cmd_touch_inner
}

_cmd_touch_inner() {
  OPENCLAW_HOME="$OPENCLAW_HOME" "$OPENCLAW_CMD" hybrid-mem task-queue-touch --state-dir "$STATE_DIR"
}

cmd_status() {
  OPENCLAW_HOME="$OPENCLAW_HOME" "$OPENCLAW_CMD" hybrid-mem task-queue-status --state-dir "$STATE_DIR"
}

# Exit 0 = busy (do not claim current.json), 1 = free
# Mirrors task-queue watchdog semantics: EPERM from kill(pid,0) means the process exists.
# Non–idle-placeholder entries without a usable PID are treated as busy so we do not clobber factory state.
_queue_is_busy() {
  # shellcheck disable=SC2016
  STATE_DIR="$STATE_DIR" node -e '
    const fs = require("fs");
    const path = require("path");
    const IDLE = "openclaw-hybrid-memory";
    const p = path.join(process.env.STATE_DIR, "current.json");
    const free = () => process.exit(1);
    const busy = () => process.exit(0);
    if (!fs.existsSync(p)) free();
    let j;
    try { j = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch { free(); }
    if (!j || typeof j !== "object") free();
    if (j.status === "idle" && j.producer === IDLE) free();
    if (j.pid != null && Number.isInteger(j.pid) && j.pid > 0) {
      try {
        process.kill(j.pid, 0);
        busy();
      } catch (e) {
        const code = e && e.code;
        if (code === "EPERM") busy();
        if (code === "ESRCH") free();
        free();
      }
    }
    busy();
  '
}

_write_current_running() {
  local title="$1" issue="$2" pid="$3"
  # shellcheck disable=SC2016
  STATE_DIR="$STATE_DIR" TITLE="$title" ISSUE="$issue" PID="$pid" RUN_PRODUCER="$RUN_PRODUCER" node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.env.STATE_DIR;
    const issueRaw = process.env.ISSUE;
    const payload = {
      status: "running",
      producer: process.env.RUN_PRODUCER,
      title: process.env.TITLE || undefined,
      pid: Number(process.env.PID),
      started: new Date().toISOString(),
      details: "Shell task-queue runner (issue #1000)",
    };
    if (issueRaw && String(issueRaw).trim() !== "") {
      const n = parseInt(issueRaw, 10);
      if (!Number.isNaN(n)) payload.issue = n;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify(payload, null, 2), "utf8");
  '
}

# Archives current.json only if it still matches this run (producer + child PID).
# History filenames include ms + random hex; writes use exclusive create to avoid collisions.
_archive_and_idle() {
  local exit_code="$1"
  local expected_pid="$2"
  # shellcheck disable=SC2016
  if ! STATE_DIR="$STATE_DIR" EXIT_CODE="$exit_code" RUN_PRODUCER="$RUN_PRODUCER" EXPECTED_PID="$expected_pid" node -e '
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const dir = process.env.STATE_DIR;
    const cur = path.join(dir, "current.json");
    const histDir = path.join(dir, "history");
    const expectedPid = parseInt(process.env.EXPECTED_PID, 10);
    const producer = process.env.RUN_PRODUCER;
    if (!fs.existsSync(cur)) process.exit(0);
    let prev;
    try { prev = JSON.parse(fs.readFileSync(cur, "utf8")); }
    catch { fs.unlinkSync(cur); process.exit(0); }
    if (prev.producer !== producer || prev.pid !== expectedPid) {
      process.stderr.write(
        "[task-queue.sh] skip archive: current.json was replaced (expected producer " +
          JSON.stringify(producer) +
          " pid " +
          String(expectedPid) +
          ")\n",
      );
      process.exit(0);
    }
    const code = parseInt(process.env.EXIT_CODE, 10);
    const ok = Number.isFinite(code) && code === 0;
    const suffix = ok ? "completed" : "failed";
    const body = JSON.stringify(
      {
        ...prev,
        status: ok ? "completed" : "failed",
        completed: new Date().toISOString(),
        exit_code: Number.isFinite(code) ? code : 1,
      },
      null,
      2,
    );
    fs.mkdirSync(histDir, { recursive: true });
    let wrote = false;
    for (let attempt = 0; attempt < 32 && !wrote; attempt++) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const ms = Date.now();
      const rand = crypto.randomBytes(4).toString("hex");
      const name = `${ts}-${ms}-${rand}-${suffix}.json`;
      const fp = path.join(histDir, name);
      try {
        fs.writeFileSync(fp, body, { encoding: "utf8", flag: "wx" });
        wrote = true;
      } catch (e) {
        if ((/** @type {NodeJS.ErrnoException} */ (e)).code !== "EEXIST") throw e;
      }
    }
    if (!wrote) {
      process.stderr.write("[task-queue.sh] could not write unique history file after 32 attempts\n");
      process.exit(2);
    }
    fs.unlinkSync(cur);
  '; then
    log "run: archive step failed (see stderr above)"
  fi
  if ! OPENCLAW_HOME="$OPENCLAW_HOME" "$OPENCLAW_CMD" hybrid-mem task-queue-touch --state-dir "$STATE_DIR" >/dev/null; then
    log "run: task-queue-touch after archive failed (non-fatal; preserving wrapped command exit code)"
  fi
}

cmd_run() {
  local TITLE="" ISSUE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title)
        if [[ $# -lt 2 || "$2" == "--" ]]; then
          log "run: --title requires a value"
          usage
          exit 1
        fi
        TITLE="$2"
        shift 2
        ;;
      --issue)
        if [[ $# -lt 2 || "$2" == "--" ]]; then
          log "run: --issue requires a value"
          usage
          exit 1
        fi
        ISSUE="$2"
        shift 2
        ;;
      *)
        break
        ;;
    esac
  done
  if [[ $# -gt 0 && "$1" == "--" ]]; then
    shift
  fi
  if [[ $# -lt 1 ]]; then
    log "run: missing command"
    exit 1
  fi
  with_lock_run _cmd_run_inner "$TITLE" "$ISSUE" "$@"
}

_cmd_run_inner() {
  local TITLE="$1" ISSUE="$2"
  shift 2
  OPENCLAW_HOME="$OPENCLAW_HOME" "$OPENCLAW_CMD" hybrid-mem task-queue-touch --state-dir "$STATE_DIR" >/dev/null || true
  if _queue_is_busy; then
    log "run: queue busy (current.json is not an idle placeholder or another worker holds it)"
    exit 2
  fi
  
  local child=""
  local current_written=false
  cleanup_on_signal() {
    if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
      kill "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
    fi
    if [[ "$current_written" == "true" && -n "$child" ]]; then
      _archive_and_idle 130 "$child"
    fi
    exit 130
  }
  trap cleanup_on_signal EXIT TERM INT
  
  "$@" &
  child=$!
  _write_current_running "$TITLE" "$ISSUE" "$child"
  current_written=true
  
  trap - EXIT TERM INT
  
  local ec=0
  wait "$child" || ec=$?
  _archive_and_idle "$ec" "$child"
  exit "$ec"
}

usage() {
  cat <<EOF
Usage:
  $(basename "$0") touch          Ensure state dir and idle current.json (flock; cron-safe)
  $(basename "$0") status         Print task-queue JSON (openclaw hybrid-mem task-queue-status)
  $(basename "$0") run [--title S] [--issue N] [--] <command> [args...]
                                  Run command with queue lifecycle (PID, history, restore idle)

Environment:
  OPENCLAW_HOME     Default: \$HOME/.openclaw
  TASK_QUEUE_STATE_DIR  Override state dir (default: \$OPENCLAW_HOME/workspace/state/task-queue)
  OPENCLAW_CMD      Default: openclaw
  TASK_QUEUE_LOCKFILE Default: /tmp/openclaw-task-queue.lock
EOF
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    touch) cmd_touch ;;
    status) cmd_status ;;
    run) cmd_run "$@" ;;
    help | -h | --help | "") usage ;;
    *)
      log "unknown command: $sub"
      usage
      exit 1
      ;;
  esac
}

main "$@"
