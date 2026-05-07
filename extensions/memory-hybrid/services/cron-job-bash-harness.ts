/**
 * Default OpenClaw cron *messages* for hybrid-mem jobs: durable file logs, per-step exit
 * ledger, single bash session — pattern from production operator runs (issue: cron observability).
 *
 * The executing agent runs the embedded bash; logs land under ~/.openclaw/logs/cron-hybrid-mem
 * (or a /tmp fallback if that path is not writable).
 */

export type HybridMemCronStep = { name: string; cmd: string };

/**
 * Bash script body: `set -euo pipefail`, HM_LOG / HM_EXIT, `hm_step`, and labeled steps.
 * Step `name` should be short and shell-safe; any character outside `[A-Za-z0-9-]` is replaced with `_`.
 */
export function buildHybridMemCronBashBody(jobSlug: string, steps: HybridMemCronStep[]): string {
  const lines = steps.map((s) => {
    const safe = s.name.replace(/[^a-zA-Z0-9-]/g, "_");
    return `hm_step "${safe}" ${s.cmd}`;
  });
  return [
    "set -euo pipefail",
    "set -x",
    'OW="${OPENCLAW_HOME:-$HOME/.openclaw}"',
    'HM_LOG_BASE="$OW/logs/cron-hybrid-mem"',
    'if ! mkdir -p "$HM_LOG_BASE" 2>/dev/null; then',
    '  HM_LOG_BASE="/tmp/openclaw-cron-hybrid-mem-${USER:-user}"',
    '  mkdir -p "$HM_LOG_BASE"',
    "fi",
    'RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"',
    `HM_JOB="${jobSlug}"`,
    'HM_LOG="${HM_LOG_BASE}/${HM_JOB}-${RUN_ID}.log"',
    'HM_EXIT="${HM_LOG_BASE}/${HM_JOB}-${RUN_ID}.exit.txt"',
    ': >"$HM_LOG"',
    ': >"$HM_EXIT"',
    "{",
    '  echo "HM_JOB=${HM_JOB}"',
    '  echo "RUN_ID=${RUN_ID}"',
    '  echo "DAY_UTC=$(date -u +%Y%m%d)"',
    '  echo "DATE_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    '  echo "--- openclaw --version ---"',
    "  (openclaw --version 2>&1 || true)",
    '  echo "--- steps ---"',
    '} >>"$HM_LOG"',
    "",
    "hm_step() {",
    '  local label="$1"',
    "  shift",
    "  set +e",
    '  "$@" 2>&1 | tee -a "$HM_LOG"',
    '  local ec="${PIPESTATUS[0]}"',
    "  set -e",
    '  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${label} exit=${ec}" >>"$HM_EXIT"',
    '  return "$ec"',
    "}",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Full task text (no guard prefix): optional preamble + execution rules + fenced bash.
 * Guard prefix is applied later by {@link resolveCronJob} in cmd-install.
 */
export function buildHybridMemCronTaskMessage(
  jobSlug: string,
  options: { preamble?: string; steps: HybridMemCronStep[] },
): string {
  const preamble = options.preamble?.trim();
  const bash = buildHybridMemCronBashBody(jobSlug, options.steps);
  const orchestration = [
    "EXECUTION (durable logs + per-step exits)",
    "Run the bash below in ONE foreground shell session and wait until it exits. Do not background this work and end the turn while commands are still running.",
    "- HM_LOG: full stdout/stderr for the run. HM_EXIT: one line per hm_step with UTC timestamp and exit= (first command in the pipeline).",
    "- Only after every hm_step succeeds (exit 0), perform the GUARD CHECK timestamp write. If any hm_step fails, do NOT update the guard file; reply with paths to HM_LOG and HM_EXIT and paste the full contents of HM_EXIT.",
    "",
    "```bash",
    bash,
    "```",
  ].join("\n");
  return [preamble, orchestration].filter(Boolean).join("\n\n");
}
