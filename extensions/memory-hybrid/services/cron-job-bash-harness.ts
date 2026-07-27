/**
 * Default OpenClaw cron *messages* for hybrid-mem jobs: durable file logs, per-step exit
 * ledger, single bash session — pattern from production operator runs (issue: cron observability).
 *
 * The executing agent runs the embedded bash; logs land under ~/.openclaw/logs/cron-hybrid-mem
 * (or a /tmp fallback if that path is not writable).
 *
 * HM_EXIT format (one line per hm_step): `{ISO8601Z} {step_name} exit={code}` optionally
 * followed by `status=` and `reason=`. `openclaw hybrid-mem maintenance validate-exit` (invoked
 * automatically at shell exit; the ledger row/log section header keep the historical
 * `validate-cron-exit` label for analyzer compatibility — see hm_validate() below) treats an
 * empty ledger with no `--- steps ---` section in HM_LOG as wrapper abort
 * (`failureClass=wrapper_aborted_before_steps`).
 */

export type HybridMemCronStep = { name: string; cmd: string; optional?: boolean };

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
 * and mandatory `maintenance validate-exit` (plus a mechanical guard-file write gate — see
 * hm_validate()) on shell exit.
 * Step `name` should be short and shell-safe; any character outside `[A-Za-z0-9-]` is replaced with `_`.
 */
export function buildHybridMemCronBashBody(
  jobSlug: string,
  steps: HybridMemCronStep[],
  requiredSteps: string[] = steps.filter((s) => !s.optional).map((s) => s.name),
): string {
  const lines = steps.map((s) => {
    const safe = shellSafeStepName(s.name);
    const line = `hm_step "${safe}" ${s.cmd}`;
    return s.optional ? `${line} || true` : line;
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
    'export HM_RUN_ID="$RUN_ID"',
    "export HM_JOB",
    'DAY_DIR="${HM_LOG_BASE}/$(date -u +%Y%m%d)"',
    'mkdir -p "$DAY_DIR"',
    'HM_SUMMARY="${DAY_DIR}/${HM_JOB}-${RUN_ID}.summary.json"',
    "export HM_SUMMARY",
    'HM_VALIDATION_JSON="${DAY_DIR}/${HM_JOB}-${RUN_ID}.validation.json"',
    'HM_LOG="${HM_LOG_BASE}/${HM_JOB}-${RUN_ID}.log"',
    'HM_EXIT="${HM_LOG_BASE}/${HM_JOB}-${RUN_ID}.exit.txt"',
    `HM_REQUIRED_STEPS=(${requiredArgs})`,
    ': >"$HM_LOG"',
    ': >"$HM_EXIT"',
    // Durable bootstrap marker, written immediately after HM_LOG/HM_EXIT exist and before
    // anything else (including the hm_validate/trap definitions below) can fail or be killed
    // (#2131). Without this, a run that aborts (e.g. SIGKILL/OOM) between artifact creation and
    // the first trap left BOTH files at 0 bytes with zero diagnostics — the next day's analyzer
    // could only report a generic "empty exit ledger", with no clue whether the run ever even
    // started. This row is exit=0 (never itself a failure) and is specifically recognized by
    // maintenance-log-analyzer.ts so a run that never progresses past this point is still
    // reported with a specific bootstrap-failure class, and a normal successful run is unaffected.
    'echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) harness-bootstrap: HM_JOB=${HM_JOB} RUN_ID=${RUN_ID}" >>"$HM_LOG"',
    'echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) harness-bootstrap exit=0 status=started reason=harness_bootstrap_started" >>"$HM_EXIT"',
    // hm_validate + its EXIT/TERM/INT/HUP/QUIT traps are installed here, immediately after
    // HM_EXIT is created, rather than after the much longer hm_step definition below (#2094).
    // Every HM_* variable hm_validate references (HM_EXIT, HM_LOG, HM_SUMMARY,
    // HM_REQUIRED_STEPS, HM_JOB, HM_VALIDATION_JSON) is already set by this point, so this closes
    // almost the entire "crashed during setup, before any trap existed" gap that produced
    // orchestration-stale-empty-exit findings from a wholly-empty HM_EXIT ledger with no terminal
    // row at all. Bash resolves `hm_validate` at trap-firing time, not registration time, so the
    // trap is safe to install before the function body appears later in the script.
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
    // --output-json writes the JSON payload directly to $validate_output via fs, bypassing
    // stdout entirely (#2133). Bootstrap/plugin-loader logs the OpenClaw host prints to stdout
    // before this command's own code runs can never be suppressed by the plugin (see
    // docs/JSON-CLI-OUTPUT.md), so a stdout-only capture (the old `tee ... "$validate_output"`)
    // could still land those logs ahead of the JSON, making HM_VALIDATION_JSON unparseable.
    // Writing the file from inside the command sidesteps that entirely; `--json` is kept only so
    // the mixed stdout+stderr stream still ends up in HM_LOG for human debugging.
    //
    // Invokes the grouped `maintenance validate-exit` command, not the deprecated flat
    // `validate-cron-exit` alias (issue: cron harness still emitted the deprecated command). The
    // `--- validate-cron-exit ---` section header above and the `validate-cron-exit exit=...`
    // ledger row below intentionally keep the OLD name — maintenance-log-analyzer.ts's
    // isDerivedAnalyzerSelfFailureStep() and logHasValidateMarker() key off that exact literal
    // string in HM_LOG/HM_EXIT, so renaming the label (as opposed to the invoked command) would
    // silently break analyzer self-suppression and stale-run detection.
    '  openclaw hybrid-mem maintenance validate-exit --exit-path "$HM_EXIT" --log-path "$HM_LOG" --summary-path "$HM_SUMMARY" --required-steps "${HM_REQUIRED_STEPS[@]}" --allow-skip --json --output-json "$validate_output" 2>&1 | tee -a "$HM_LOG"',
    '  local validation_ec="${PIPESTATUS[0]}"',
    '  local maintenance_status=""',
    "  # Parse maintenanceStatus without jq to keep cron harness dependencies minimal/portable.",
    '  maintenance_status="$(grep -Eo \'"maintenanceStatus"[[:space:]]*:[[:space:]]*"(success|skipped|partial|failed)"\' "$validate_output" | tail -n1 | sed -E \'s/.*"(success|skipped|partial|failed)"/\\1/\' || true)"',
    // Mechanical guard-write gate (issue: cron harness's "guard-update contract" was prose-only —
    // the executing LLM agent was simply told to write the guard file "after successful
    // completion" with no bash-level code actually checking that). The persistent guard file (see
    // the GUARD CHECK prefix built by buildGuardPrefix in services/cron-guard.ts) is now written
    // right here, deterministically, instead of relying on the agent's own judgment. Gated on:
    // (a) the wrapped step chain itself exited 0 (`original_ec`), (b) `maintenance validate-exit`
    // itself exited 0, (c) its JSON output was actually produced and parses with
    // `guardUpdated=true` and `maintenanceStatus="success"` (still parsed without jq, matching
    // the maintenanceStatus parse above), and (d) every configured required step independently
    // shows `exit=0` (or an allowed `-skipped` variant) in the raw HM_EXIT ledger — a redundant,
    // ledger-level recheck that does not simply trust the validator's own JSON verdict.
    '  local guard_updated=""',
    '  guard_updated="$(grep -Eo \'"guardUpdated"[[:space:]]*:[[:space:]]*(true|false)\' "$validate_output" | tail -n1 | sed -E \'s/.*:[[:space:]]*(true|false)/\\1/\' || true)"',
    '  local guard_required_ok=1',
    '  local req_step',
    '  for req_step in "${HM_REQUIRED_STEPS[@]}"; do',
    '    if ! grep -Eq "^[^[:space:]]+[[:space:]]+(${req_step}|${req_step}-skipped)[[:space:]]+exit=0([[:space:]]|\\$)" "$HM_EXIT" 2>/dev/null; then',
    "      guard_required_ok=0",
    "      break",
    "    fi",
    "  done",
    '  local guard_gate_reason="ineligible"',
    "  local guard_eligible=0",
    '  if [ "$original_ec" -ne 0 ]; then',
    '    guard_gate_reason="wrapped_step_exit_nonzero"',
    '  elif [ "$validation_ec" -ne 0 ]; then',
    '    guard_gate_reason="validate_exit_nonzero"',
    '  elif [ -z "$guard_updated" ]; then',
    '    guard_gate_reason="validation_output_unparseable"',
    '  elif [ "$maintenance_status" != "success" ]; then',
    '    guard_gate_reason="maintenance_status_not_success"',
    '  elif [ "$guard_updated" != "true" ]; then',
    '    guard_gate_reason="validator_guard_not_updated"',
    '  elif [ "$guard_required_ok" -ne 1 ]; then',
    '    guard_gate_reason="missing_or_failed_required_step"',
    "  else",
    "    guard_eligible=1",
    '    guard_gate_reason="eligible"',
    "  fi",
    // $OW/HM_JOB (not a Node-computed literal) so the write always lands under whatever
    // OPENCLAW_HOME the harness itself is running with — the same base HM_LOG_BASE already uses
    // above, and what a test harness overrides via the OPENCLAW_HOME env var stays sandboxed.
    '  local hm_guard_dir="${OW}/cron/guard"',
    '  local hm_guard_file="${hm_guard_dir}/${HM_JOB}.ms"',
    '  local guard_write_result="skipped_${guard_gate_reason}"',
    '  local guard_tmp=""',
    '  if [ "$guard_eligible" -eq 1 ]; then',
    '    if mkdir -p "$hm_guard_dir" 2>/dev/null; then',
    '      guard_tmp="$(mktemp "${hm_guard_dir}/.${HM_JOB}.ms.XXXXXX" 2>/dev/null || true)"',
    "      if [ -n \"$guard_tmp\" ] && printf '%s' \"$(date +%s%3N)\" >\"$guard_tmp\" 2>/dev/null && mv -f \"$guard_tmp\" \"$hm_guard_file\" 2>/dev/null; then",
    '        guard_write_result="written"',
    "      else",
    '        [ -n "$guard_tmp" ] && rm -f "$guard_tmp" 2>/dev/null',
    '        guard_write_result="write_failed"',
    "      fi",
    "    else",
    '      guard_write_result="write_failed"',
    "    fi",
    "  fi",
    '  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) GUARD_WRITE job=${HM_JOB} eligible=${guard_eligible} result=${guard_write_result} reason=${guard_gate_reason} file=${hm_guard_file}" | tee -a "$HM_LOG"',
    '  if [ -n "${HM_VALIDATION_JSON:-}" ]; then',
    '    if [ -s "$validate_output" ]; then',
    '      cp "$validate_output" "$HM_VALIDATION_JSON" 2>/dev/null || cat "$validate_output" >"$HM_VALIDATION_JSON"',
    "    else",
    // validate-cron-exit can exit/crash before ever reaching its --output-json write (or the write
    // itself can fail), leaving $validate_output genuinely empty — HM_VALIDATION_JSON must still be
    // valid, parseable JSON in that case, not a truly empty file (#2134 QA follow-up).
    '      printf \'{"maintenanceStatus":"unknown","error":"validate-cron-exit did not produce --output-json output (validation_exit=%s)"}\' "$validation_ec" >"$HM_VALIDATION_JSON"',
    "    fi",
    "  fi",
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
    "      distill|extract-daily|extract-procedures|extract-directives|extract-reinforcement|extract-implicit|self-correction-run)",
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
    '  local step_ec="${PIPESTATUS[0]}"',
    '  local return_ec="${step_ec}"',
    '  local hm_status=""',
    '  local hm_reason=""',
    '  local reported_status=""',
    '  local strict_semantic_reason=""',
    // `(?:...)` is PCRE, not POSIX ERE — `grep -E` doesn't understand non-capturing groups (GNU
    // grep warns "? at start of expression" and matches the literal text "?:" instead, which never
    // occurs in real step output, so this alternative silently never matched and every
    // `failed_<reason>` status was truncated to the bare word "failed"). A plain capturing group
    // `(...)` is fully POSIX-ERE-supported and produces the identical match here since the
    // group's own capture isn't used — only the whole match, via grep -Eo (QA follow-up).
    '  reported_status="$(grep -Eo \'status=(success_[A-Za-z0-9_-]+|skipped_[A-Za-z0-9_-]+|failed(_[A-Za-z0-9_-]+)?)\' "$step_output" | tail -n1 | cut -d= -f2 || true)"',
    '  if [ "$step_ec" -eq 0 ] && [ "${HYBRID_MEM_STRICT_SEMANTICS:-0}" = "1" ]; then',
    '    strict_semantic_reason="$(grep -Eo \'status=(no_candidates|no_changes|degraded)\' "$step_output" | tail -n1 | cut -d= -f2 || true)"',
    '    if [ -z "$strict_semantic_reason" ] && grep -Eq \'Status:[[:space:]]+cursorAdvanced=false\' "$step_output"; then',
    '      strict_semantic_reason="cursor_not_advanced"',
    "    fi",
    '    if [ -z "$strict_semantic_reason" ] && grep -Eq \'Status:[[:space:]]+cursorBlockedReason=\' "$step_output"; then',
    '      strict_semantic_reason="cursor_blocked"',
    "    fi",
    '    if [ -n "$strict_semantic_reason" ]; then',
    "      step_ec=2",
    "      return_ec=2",
    '      reported_status="failed_semantic_${strict_semantic_reason}"',
    "    fi",
    "  fi",
    '  if [ "$step_ec" -ne 0 ]; then',
    '    hm_status="failed"',
    '    hm_reason="${reported_status:-nonzero_exit}"',
    "  else",
    '    case "$reported_status" in',
    '      skipped_*) hm_status="skipped"; hm_reason="$reported_status" ;;',
    '      success_*) hm_status="ok"; hm_reason="$reported_status" ;;',
    "    esac",
    "  fi",
    '  if [ "${HM_JOB}" = "nightly-memory-sweep" ] && [ "${label}" = "extract-daily" ] && [ "$step_ec" -eq 1 ]; then',
    "    return_ec=0",
    '    hm_status="failed"',
    '    hm_reason="tolerated_extract_daily_exit_1"',
    '    echo "WARNING: nightly-memory-sweep tolerated extract-daily exit=1; continuing downstream steps, final status delegated to validate-cron-exit" | tee -a "$HM_LOG"',
    "  fi",
    '  rm -f "$step_output"',
    '  if [ -n "$hm_status" ] && [ -n "$hm_reason" ]; then',
    '    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${label} exit=${step_ec} status=${hm_status} reason=${hm_reason}" >>"$HM_EXIT"',
    "  else",
    '    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${label} exit=${step_ec}" >>"$HM_EXIT"',
    "  fi",
    '  if [ "$had_errexit" -eq 1 ]; then',
    "    set -e",
    "  fi",
    '  return "$return_ec"',
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
  const requiredSteps = options.requiredSteps ?? options.steps.filter((s) => !s.optional).map((s) => s.name);
  const bash = buildHybridMemCronBashBody(jobSlug, options.steps, requiredSteps);

  // Build list of required steps for validation
  const requiredStepsList = requiredSteps.map((s) => `"${shellSafeStepName(s)}"`).join(", ");

  const orchestration = [
    "EXECUTION (durable logs + per-step exits)",
    "Run the bash below in ONE foreground shell session and wait until it exits. Do not background this work and end the turn while commands are still running.",
    "TOOLING: Use the exec tool with a full shell command string (e.g. bash with the script body). Do NOT use deferred tool surfaces (tool_call, tool_describe, tool_search) — they strip exec arguments in isolated cron sessions (#1961).",
    "- If no direct top-level exec/bash tool is present in your available tools for this session, do NOT fall back to tool_call/ToolSearch even once — that path is confirmed to silently drop arguments (upstream #96115/#53408) and will not run the script. Instead, reply with exactly `TOOLING_BLOCKED: <one-sentence reason>` and stop; do not attempt the bash script below.",
    "- HM_LOG: full stdout/stderr for the run. HM_EXIT: one line per hm_step with UTC timestamp and exit= (first command in the pipeline).",
    "",
    "```bash",
    bash,
    "```",
    "",
    "VALIDATION & GUARD UPDATE (Issue: cron jobs report OK despite failures)",
    `The bash harness automatically runs \`openclaw hybrid-mem maintenance validate-exit\` at shell exit and validates that ALL required steps [${requiredStepsList}] appear in HM_EXIT with exit=0.`,
    "- If ANY required step is missing from HM_EXIT, has exit≠0, or the log contains 'unknown command', maintenance validate-exit returns non-zero and the shell exits non-zero.",
    "- If a step is replaced with a config-skip variant (e.g., 'distill-skipped' exit=0 when distill.enabled is false), that counts as present.",
    "- The persistent guard file (see the GUARD CHECK prefix above, if present) is now written MECHANICALLY by the bash harness itself, in hm_validate — not by you. A deterministic bash check gates the write on: the wrapped steps exiting 0, `maintenance validate-exit` itself exiting 0, its JSON output being present/parseable with `guardUpdated: true` and `maintenanceStatus: \"success\"`, and every required step independently confirmed exit=0 (or an allowed skip variant) directly in HM_EXIT.",
    "- Do NOT write the guard file yourself, even if you believe the run succeeded — read the `GUARD_WRITE ... result=...` line the harness tees into HM_LOG for the actual outcome; a manual write could mask a genuine failure the harness detected.",
    "",
    "REPLY FORMAT:",
    "1. State the overall result: SUCCESS, FAILED, or SKIPPED",
    "2. List HM_EXIT path and paste its full contents",
    "3. List HM_LOG path (do not paste log unless there are errors)",
    "4. If any step failed or is missing, explain which steps and why",
    "5. Quote the harness's `GUARD_WRITE` log line to state whether the guard file was updated (do not decide this yourself)",
  ].join("\n");
  return [preamble, orchestration].filter(Boolean).join("\n\n");
}

/** True when a cron payload uses the bash harness that exports HM_SUMMARY (#1877, #1925). */
export function maintenanceCronExpectsSummaryArtifact(message: string): boolean {
  return message.includes("HM_SUMMARY") || message.includes("validate-cron-exit");
}
