/**
 * Default OpenClaw cron *messages* for hybrid-mem jobs: durable file logs, per-step exit
 * ledger, single bash session — pattern from production operator runs (issue: cron observability).
 *
 * The executing agent runs the embedded bash; logs land under ~/.openclaw/logs/cron-hybrid-mem
 * (or a /tmp fallback if that path is not writable).
 */

export type HybridMemCronStep = { name: string; cmd: string };

export const HYBRID_MEM_CRON_ENV_SANITIZER_MARKER =
  "# Hybrid-mem env sanitizer (strip service vars that can break plugin CLI discovery)";

export function hybridMemCronEnvSanitizerBashLines(): string[] {
  return [
    HYBRID_MEM_CRON_ENV_SANITIZER_MARKER,
    "openclaw() {",
    '  env -u OPENCLAW_SKIP_HYBRID_MEMORY_CLI -u OPENCLAW_CLI -u OPENCLAW_SERVICE_KIND -u OPENCLAW_SERVICE_MARKER command openclaw "$@"',
    "}",
  ];
}

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
    ...hybridMemCronEnvSanitizerBashLines(),
    'if [ -n "${OPENCLAW_HOME:-}" ]; then OW="$OPENCLAW_HOME"; else OW=~/.openclaw; fi',
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
  options: { preamble?: string; steps: HybridMemCronStep[]; requiredSteps?: string[] },
): string {
  const preamble = options.preamble?.trim();
  const bash = buildHybridMemCronBashBody(jobSlug, options.steps);

  // Build list of required steps for validation
  const requiredSteps = options.requiredSteps ?? options.steps.map((s) => s.name);
  const requiredStepsList = requiredSteps.map((s) => `"${s}"`).join(", ");

  const orchestration = [
    "EXECUTION (durable logs + per-step exits)",
    "Run the bash below in ONE foreground shell session and wait until it exits. Do not background this work and end the turn while commands are still running.",
    "- HM_LOG: full stdout/stderr for the run. HM_EXIT: one line per hm_step with UTC timestamp and exit= (first command in the pipeline).",
    "",
    "```bash",
    bash,
    "```",
    "",
    "VALIDATION & GUARD UPDATE (Issue: cron jobs report OK despite failures)",
    `After the bash script completes, validate that ALL required steps [${requiredStepsList}] appear in HM_EXIT with exit=0.`,
    "- If ANY required step is missing from HM_EXIT, has exit≠0, or the log contains 'unknown command', this job has FAILED.",
    "- If a step is replaced with a config-skip variant (e.g., 'distill-skipped' exit=0 when distill.enabled is false), that counts as present.",
    "- Only after ALL required steps are validated successful: perform the GUARD CHECK timestamp write.",
    "- If validation fails, do NOT update the guard file.",
    "",
    "REPLY FORMAT:",
    "1. State the overall result: SUCCESS, FAILED, or SKIPPED",
    "2. List HM_EXIT path and paste its full contents",
    "3. List HM_LOG path (do not paste log unless there are errors)",
    "4. If any step failed or is missing, explain which steps and why",
    "5. State whether guard file was updated (yes/no)",
  ].join("\n");
  return [preamble, orchestration].filter(Boolean).join("\n\n");
}
