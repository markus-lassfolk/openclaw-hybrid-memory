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
    "  local force_mode=0",
    '  if [ "${HYBRID_MEM_CLI_JOB_GUARD_WINDOW_MS:-}" = "0" ] || [ "${QA_FORCE:-}" = "1" ] || [ "${HYBRID_MEM_QA_FORCE:-}" = "1" ]; then',
    "    force_mode=1",
    "  fi",
    '  local timeout_raw="${STEP_TIMEOUT_SECONDS:-0}"',
    "  local timeout_secs=0",
    '  if [[ "$timeout_raw" =~ ^[0-9]+$ ]]; then',
    "    timeout_secs=$((10#$timeout_raw))",
    "  fi",
    '  local -a cmd=("$@")',
    '  if [ "$force_mode" -eq 1 ] && [ "${cmd[0]:-}" = "openclaw" ] && [ "${cmd[1]:-}" = "hybrid-mem" ]; then',
    '    case "${cmd[2]:-}" in',
    "      distill|extract-procedures|extract-directives|extract-reinforcement|extract-implicit|self-correction-run)",
    "        cmd+=(--force)",
    "        ;;",
    "    esac",
    "  fi",
    "  local step_output",
    "  local had_errexit=0",
    '  case "$-" in',
    "    *e*) had_errexit=1 ;;",
    "  esac",
    '  step_output="$(mktemp "${TMPDIR:-/tmp}/hm-step-${label}-XXXXXX")"',
    "  set +e",
    '  if [ "$timeout_secs" -gt 0 ]; then',
    '    env -u OPENCLAW_SKIP_HYBRID_MEMORY_CLI -u OPENCLAW_CLI -u OPENCLAW_SERVICE_KIND -u OPENCLAW_SERVICE_MARKER timeout "$timeout_secs" "${cmd[@]}" 2>&1 | tee -a "$HM_LOG" "$step_output"',
    "  else",
    '    "${cmd[@]}" 2>&1 | tee -a "$HM_LOG" "$step_output"',
    "  fi",
    '  local ec="${PIPESTATUS[0]}"',
    '  local hm_status=""',
    '  local hm_reason=""',
    '  local reported_status=""',
    '  local strict_semantic_reason=""',
  '  reported_status="$(grep -Eo \'status=(success_[A-Za-z0-9_-]+|skipped_[A-Za-z0-9_-]+|failed_[A-Za-z0-9_-]+)\' "$step_output" | tail -n1 | cut -d= -f2 || true)"',
  '  if [ "$ec" -eq 0 ] && [ "${HYBRID_MEM_STRICT_SEMANTICS:-0}" = "1" ]; then',
  '    strict_semantic_reason="$(grep -Eo \'status=(no_candidates|no_changes|degraded)\' "$step_output" | tail -n1 | cut -d= -f2 || true)"',
    '    if [ -z "$strict_semantic_reason" ] && grep -Eq \'Status:[[:space:]]+cursorAdvanced=false\' "$step_output"; then',
    '      strict_semantic_reason="cursor_not_advanced"',
    "    fi",
    '    if [ -z "$strict_semantic_reason" ] && grep -Eq \'Status:[[:space:]]+cursorBlockedReason=\' "$step_output"; then',
    '      strict_semantic_reason="cursor_blocked"',
    "    fi",
    '    if [ -n "$strict_semantic_reason" ]; then',
    '      ec=2',
    '      reported_status="failed_semantic_${strict_semantic_reason}"',
    "    fi",
    "  fi",
    '  if [ "$ec" -ne 0 ]; then',
    '    hm_status="failed"',
    '    hm_reason="${reported_status:-nonzero_exit}"',
    "  else",
    '    case "$reported_status" in',
    '      skipped_*) hm_status="skipped"; hm_reason="$reported_status" ;;',
    '      success_*) hm_status="ok"; hm_reason="$reported_status" ;;',
    "    esac",
    "  fi",
    '  rm -f "$step_output"',
    '  if [ -n "$hm_status" ] && [ -n "$hm_reason" ]; then',
    '    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${label} exit=${ec} status=${hm_status} reason=${hm_reason}" >>"$HM_EXIT"',
    "  else",
    '    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${label} exit=${ec}" >>"$HM_EXIT"',
    "  fi",
    '  if [ "$had_errexit" -eq 1 ]; then',
    "    set -e",
    "  fi",
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
    '  local signal_during_validate=""',
    "  trap 'signal_during_validate=143' TERM INT",
    "  trap 'signal_during_validate=129' HUP",
    "  trap 'signal_during_validate=131' QUIT",
    "  set +e",
    '  echo "--- validate-cron-exit ---" | tee -a "$HM_LOG"',
    "  local validate_output",
    '  validate_output="$(mktemp "${TMPDIR:-/tmp}/hm-validate-XXXXXX")"',
    '  openclaw hybrid-mem validate-cron-exit --exit-path "$HM_EXIT" --log-path "$HM_LOG" --required-steps "${HM_REQUIRED_STEPS[@]}" --allow-skip --json 2>&1 | tee -a "$HM_LOG" "$validate_output"',
    '  local validation_ec="${PIPESTATUS[0]}"',
    '  local maintenance_status=""',
    "  # Parse maintenanceStatus without jq to keep cron harness dependencies minimal/portable.",
    '  maintenance_status="$(grep -Eo \'"maintenanceStatus"[[:space:]]*:[[:space:]]*"(success|skipped|partial|failed)"\' "$validate_output" | tail -n1 | sed -E \'s/.*"(success|skipped|partial|failed)"/\\1/\' || true)"',
    '  rm -f "$validate_output"',
    '  local final_ec="$validation_ec"',
    "  # Preserve original non-zero (step/signal) failure code; validation is supplemental diagnostics.",
    '  if [ "$original_ec" -ne 0 ]; then',
    '    if [ "$validation_ec" -ne 0 ] && [ "$validation_ec" -ne "$original_ec" ]; then',
    '      echo "WARNING: validate-cron-exit failed with different exit code than original failure: validation_exit=${validation_ec} original_exit=${original_ec}" | tee -a "$HM_LOG"',
    "    fi",
    '    final_ec="$original_ec"',
    "  fi",
    '  if [ "$original_ec" -eq 0 ] && [ -n "$signal_during_validate" ]; then',
    '    final_ec="$signal_during_validate"',
    "  fi",
    '  local final_label="FAILED"',
    '  if [ -n "$maintenance_status" ]; then',
    '    case "$maintenance_status" in',
    '      success) final_label="SUCCESS" ;;',
    '      skipped) final_label="SKIPPED" ;;',
    '      partial) final_label="PARTIAL" ;;',
    "    esac",
    '  elif [ "$final_ec" -eq 0 ]; then',
    '    final_label="SUCCESS"',
    "  fi",
    '  local ledger_status=""',
    '  if [ -n "$maintenance_status" ]; then',
    '    case "$maintenance_status" in',
    '      success) ledger_status="ok" ;;',
    '      failed) ledger_status="failed" ;;',
    '      skipped) ledger_status="skipped" ;;',
    '      partial) ledger_status="failed" ;;',
    "    esac",
    "  fi",
    '  local status_suffix=""',
    '  if [ -n "$ledger_status" ]; then',
    '    status_suffix=" status=${ledger_status} reason=maintenance_${maintenance_status}"',
    "  fi",
    "  # HM_VALIDATED guard ensures this final validation row is written at most once per run.",
    '  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) validate-cron-exit exit=${validation_ec}${status_suffix}" >>"$HM_EXIT"',
    '  echo "${final_label}: ${HM_JOB}" | tee -a "$HM_LOG"',
    '  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${HM_JOB} exit=${final_ec}" | tee -a "$HM_LOG"',
    "  set -e",
    '  return "$final_ec"',
    "}",
    "trap 'ec=$?; trap - EXIT; hm_validate \"$ec\"; exit $?' EXIT",
    "trap 'trap - TERM INT HUP QUIT; hm_validate 143; exit $?' TERM INT",
    "trap 'trap - TERM INT HUP QUIT; hm_validate 129; exit $?' HUP",
    "trap 'trap - TERM INT HUP QUIT; hm_validate 131; exit $?' QUIT",
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
