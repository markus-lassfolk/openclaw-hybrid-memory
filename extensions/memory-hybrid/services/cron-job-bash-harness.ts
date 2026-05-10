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

/**
 * Bash wrapper function that sanitizes environment variables before invoking openclaw.
 *
 * Issue #1209: OpenClaw CLI skips loading plugin CLIs when OPENCLAW_SERVICE_KIND or
 * OPENCLAW_SERVICE_MARKER are present, treating the invocation as a service context
 * where CLI commands shouldn't be available. We must unset these markers BEFORE
 * invoking openclaw to ensure hybrid-mem CLI commands are discovered.
 *
 * Also unsets OPENCLAW_CLI (can interfere with arg parsing) and
 * OPENCLAW_SKIP_HYBRID_MEMORY_CLI (if somehow set).
 */
export function hybridMemCronEnvSanitizerBashLines(): string[] {
  return [
    HYBRID_MEM_CRON_ENV_SANITIZER_MARKER,
    "openclaw() {",
    "  local openclaw_bin",
    '  openclaw_bin="$(type -P openclaw)" || return 127',
    '  env -u OPENCLAW_SKIP_HYBRID_MEMORY_CLI -u OPENCLAW_CLI -u OPENCLAW_SERVICE_KIND -u OPENCLAW_SERVICE_MARKER "$openclaw_bin" "$@"',
    "}",
  ];
}

function shellSafeStepName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, "_");
}

/**
 * Bash script body: `set -euo pipefail`, HM_LOG / HM_EXIT, `hm_step`, labeled steps,
 * and mandatory `validate-cron-exit` on shell exit.
 * Step `name` should be short and shell-safe; any character outside `[A-Za-z0-9-]` is replaced with `_`.
 */
export function buildHybridMemCronBashBody(
  jobSlug: string,
  steps: HybridMemCronStep[],
  requiredSteps: string[] = steps.map((s) => s.name),
): string {
  const lines = steps.map((s) => {
    const safe = shellSafeStepName(s.name);
    return `hm_step "${safe}" ${s.cmd}`;
  });
  const requiredArgs = requiredSteps.map((s) => `"${shellSafeStepName(s)}"`).join(" ");
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
    `HM_REQUIRED_STEPS=(${requiredArgs})`,
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
    "HM_VALIDATED=0",
    "hm_validate() {",
    '  local original_ec="${1:-0}"',
    '  if [ "${HM_VALIDATED}" = "1" ]; then',
    '    return "$original_ec"',
    "  fi",
    "  HM_VALIDATED=1",
    "  set +e",
    '  echo "--- validate-cron-exit ---" | tee -a "$HM_LOG"',
    '  openclaw hybrid-mem validate-cron-exit --exit-path "$HM_EXIT" --log-path "$HM_LOG" --required-steps "${HM_REQUIRED_STEPS[@]}" --allow-skip --json 2>&1 | tee -a "$HM_LOG"',
    '  local validation_ec="${PIPESTATUS[0]}"',
    "  set -e",
    '  if [ "$original_ec" -ne 0 ]; then',
    '    return "$original_ec"',
    "  fi",
    '  return "$validation_ec"',
    "}",
    "trap 'ec=$?; trap - EXIT; hm_validate \"$ec\"; exit $?' EXIT",
    "trap 'trap - TERM INT; hm_validate 143; exit $?' TERM INT",
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
  const requiredSteps = options.requiredSteps ?? options.steps.map((s) => s.name);
  const bash = buildHybridMemCronBashBody(jobSlug, options.steps, requiredSteps);

  // Build list of required steps for validation
  const requiredStepsList = requiredSteps.map((s) => `"${shellSafeStepName(s)}"`).join(", ");

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
    `The bash harness automatically runs \`openclaw hybrid-mem validate-cron-exit\` at shell exit and validates that ALL required steps [${requiredStepsList}] appear in HM_EXIT with exit=0.`,
    "- If ANY required step is missing from HM_EXIT, has exit≠0, or the log contains 'unknown command', validate-cron-exit returns non-zero and the shell exits non-zero.",
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
