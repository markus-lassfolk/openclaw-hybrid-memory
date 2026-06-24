import { capturePluginError } from "../../../services/error-reporter.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import {
  type LearnCommandNames,
  FLAT_LEARN_COMMAND_NAMES,
  GROUPED_LEARN_COMMAND_NAMES,
  createCommandGroup,
  deprecatedAction,
} from "../../commands/cli-group-utils.js";
import { registerScanMaintenanceOverrideOptions, scanMaintenanceOverridePayload } from "../../maintenance-overrides.js";
import { type Chainable, SCAN_MIN_INTERVAL_MS, withExit } from "../../shared.js";
import type { SelfCorrectionRunResult } from "../../types.js";
import type { ManageBindings } from "./bindings.js";

function isSelfCorrectionDegradedStatus(status: SelfCorrectionRunResult["status"]): boolean {
  return status === "failed_partial" || status === "failed_suspect_zero_parsed";
}

function selfCorrectionBatchProgressSuffix(res: SelfCorrectionRunResult): string {
  if (res.status === "failed_partial" || res.status === "failed" || res.status === "failed_parse") {
    return ` batches_completed=${res.batchesCompleted ?? 0}/${res.totalBatches ?? "?"}`;
  }
  return "";
}

export type LearnRegistrationOptions = {
  names?: LearnCommandNames;
  flatDeprecatedOn?: Chainable;
  /** When true, nest extract/run under a `self-correction` subcommand. */
  grouped?: boolean;
};

export function registerManageSelfCorrectionFeedback(
  mem: Chainable,
  b: ManageBindings,
  opts?: LearnRegistrationOptions,
): void {
  if (opts?.flatDeprecatedOn) {
    registerManageSelfCorrectionFeedbackOnParent(opts.flatDeprecatedOn, b, FLAT_LEARN_COMMAND_NAMES, deprecatedAction);
    return;
  }
  const names = opts?.names ?? FLAT_LEARN_COMMAND_NAMES;
  registerManageSelfCorrectionFeedbackOnParent(mem, b, names, undefined, opts?.grouped === true);
}

function registerManageSelfCorrectionFeedbackOnParent(
  mem: Chainable,
  b: ManageBindings,
  names: LearnCommandNames,
  wrapAction?: (
    oldPath: string,
    newPath: string,
    fn: (...args: any[]) => void | Promise<void>,
  ) => (...args: any[]) => void | Promise<void>,
  grouped = false,
): void {
  const groupedPath = (sub: string) => `learn ${sub}`;
  const maybeWrap = (
    flatPath: string,
    sub: string,
    fn: (...args: any[]) => void | Promise<void>,
  ): ((...args: any[]) => void | Promise<void>) => (wrapAction ? wrapAction(flatPath, groupedPath(sub), fn) : fn);

  const selfCorrectionParent = grouped
    ? mem.command("self-correction").description("Extract and run self-correction from session logs")
    : mem;
  const extractName = grouped ? names.selfCorrectionExtract : names.selfCorrectionExtract;
  const runName = grouped ? names.selfCorrectionRun : names.selfCorrectionRun;
  const {
    cfg,
    ctx,
    runSelfCorrectionExtract,
    runSelfCorrectionRun,
    runExtractImplicitFeedback,
    runCrossAgentLearning,
    runToolEffectiveness,
    pruneCostLog,
    runCostReport,
    runAnalyzeFeedbackPhrases,
  } = b;

  selfCorrectionParent
    .command(extractName)
    .description(
      "Extract self-correction incidents from session JSONL using multi-language correction signals from .language-keywords.json",
    )
    .option("--days <n>", "Days to look back (default 7)", "7")
    .option("--output <path>", "Output path for incidents JSON (default: memory/.self-correction-incidents.json)")
    .option("-v, --verbose", "Log session files scanned (plugin logger) and incident previews on stdout")
    .action(
      withExit(
        maybeWrap(
          "self-correction-extract",
          grouped ? "self-correction extract" : names.selfCorrectionExtract,
          async (opts?: { days?: string; output?: string; verbose?: boolean }, cmd?: CommanderOptsParent) => {
            const days = opts?.days ? Number.parseInt(opts.days, 10) : 7;
            const outputPath = opts?.output;
            const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
            let res;
            try {
              res = await runSelfCorrectionExtract({ days, outputPath, verbose });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "self-correction-extract",
              });
              throw err;
            }
            console.log(
              `Self-correction extract complete: ${res.incidents.length} incidents found, ${res.sessionsScanned} sessions scanned.`,
            );
            if (verbose && res.incidents.length > 0) {
              console.log("Incidents (--verbose):");
              for (const inc of res.incidents) {
                const preview = inc.userMessage.replace(/\s+/g, " ").slice(0, 120);
                const tail = inc.userMessage.length > 120 ? "…" : "";
                console.log(`  ${inc.sessionFile}: ${preview}${tail}`);
              }
            }
          },
        ),
      ),
    );

  registerScanMaintenanceOverrideOptions(
    selfCorrectionParent
      .command(runName)
      .description("Analyze extracted incidents and auto-remediate (memory store, TOOLS.md); report to memory/reports")
      .option("--extract-path <path>", "Path to incidents JSON (default: memory/.self-correction-incidents.json)")
      .option("--workspace <w>", "Workspace path (for TOOLS.md)")
      .option("--dry-run", "Show what would be applied without applying")
      .option("--days <n>", "Days to look back when extracting incidents (default 3)", "3")
      .option("--model <m>", "LLM model override (default from self-correction heavy tier)")
      .option("--approve", "Auto-approve all corrections (skip review)")
      .option("--no-apply-tools", "Skip TOOLS.md updates (memory-only)")
      .option("-v, --verbose", "Log progress before LLM analysis (plugin logger); respects hybrid-mem -v"),
  ).action(
    withExit(
      maybeWrap(
        "self-correction-run",
        grouped ? "self-correction run" : names.selfCorrectionRun,
        async (
          opts?: {
            extractPath?: string;
            workspace?: string;
            dryRun?: boolean;
            days?: string;
            model?: string;
            approve?: boolean;
            applyTools?: boolean;
            full?: boolean;
            force?: boolean;
            verbose?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const extractPath = opts?.extractPath;
          const workspace = opts?.workspace;
          const dryRun = !!opts?.dryRun;
          const days = opts?.days ? Number.parseInt(opts.days, 10) : 3;
          const model = opts?.model?.trim() || undefined;
          const approve = !!opts?.approve;
          const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
          let res;
          try {
            res = await runSelfCorrectionRun({
              extractPath,
              workspace,
              dryRun,
              days,
              model,
              approve,
              applyTools: opts?.applyTools,
              ...scanMaintenanceOverridePayload(opts),
              verbose,
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "self-correction-run",
            });
            throw err;
          }
          if (res.error) {
            console.error(`Error: ${res.error}${res.status ? ` status=${res.status}` : ""}`);
            process.exitCode = isSelfCorrectionDegradedStatus(res.status) ? 2 : 1;
            return;
          }
          if (isSelfCorrectionDegradedStatus(res.status)) {
            process.exitCode = 2;
          }
          if (res.skipped) {
            const thresholdH = Math.round(SCAN_MIN_INTERVAL_MS / 3_600_000);
            if (res.status === "skipped_concurrency") {
              console.log(`Skipping self-correction-run: scan already in progress. status=skipped_concurrency`);
            } else {
              console.log(
                `Skipping self-correction-run: cooldown active (last run < ${thresholdH}h ago). Use --force (or --full) to override. status=skipped_cooldown`,
              );
            }
            return;
          }
          console.log(
            `Self-correction run complete: ${res.incidentsFound} incidents found, ${res.analysed} analysed, ${res.autoFixed} auto-fixed ${dryRun ? "(dry-run)" : ""}${res.status ? ` status=${res.status}` : ""}`,
          );
          if (res.batchesStarted != null || res.retryCount != null || res.batchesCompleted != null) {
            console.log(
              `Batches started: ${res.batchesStarted ?? 0} | Batches completed: ${res.batchesCompleted ?? 0}/${res.totalBatches ?? "?"} | Parsed item lines: ${res.analysed ?? 0} | Retry lines: ${res.retryCount ?? 0} | Fallback lines: ${res.fallbackCount ?? 0} | Errors/unparseable/failure lines: ${(res.parseFailures ?? 0) + (res.unparseableFailures ?? 0)}`,
            );
            const parseSuccess = res.status === "success_analyzed" || res.status === "success_no_incidents";
            console.log(
              `parse_success=${parseSuccess} parsed_candidates=${res.analysed ?? 0} retry_count=${res.retryCount ?? 0} fallback_count=${res.fallbackCount ?? 0} parse_failures=${res.parseFailures ?? 0} unparseable_failures=${res.unparseableFailures ?? 0}${selfCorrectionBatchProgressSuffix(res)}`,
            );
          }
          if (res.proposals.length > 0) {
            console.log(`Proposals (${res.proposals.length}):`);
            for (const p of res.proposals) {
              console.log(`  - ${p}`);
            }
          }
          if (res.reportPath) {
            console.log(`Report: ${res.reportPath}`);
          }
          if (res.toolsSuggestions && res.toolsSuggestions.length > 0) {
            console.log(`TOOLS.md suggestions (${res.toolsSuggestions.length}):`);
            for (const s of res.toolsSuggestions) {
              console.log(`  - ${s}`);
            }
          }
          if (res.toolsApplied != null && res.toolsApplied > 0) {
            console.log(`TOOLS.md updates applied: ${res.toolsApplied}`);
          }
        },
      ),
    ),
  );

  if (runExtractImplicitFeedback) {
    registerScanMaintenanceOverrideOptions(
      mem
        .command(names.implicit)
        .description(
          "Extract implicit feedback signals from session transcripts and route to reinforcement/self-correction pipelines",
        )
        .option("--days <n>", "Days to look back (default 3)", "3")
        .option("--dry-run", "Show what would be stored without storing")
        .option("-v, --verbose", "Show detailed signal output per session")
        .option("--no-trajectories", "Skip trajectory building")
        .option("--no-closed-loop", "Skip closed-loop analysis"),
    ).action(
      withExit(
        maybeWrap(
          "extract-implicit",
          "implicit",
          async (
            opts?: {
              days?: string;
              dryRun?: boolean;
              full?: boolean;
              force?: boolean;
              verbose?: boolean;
              trajectories?: boolean;
              closedLoop?: boolean;
            },
            cmd?: CommanderOptsParent,
          ) => {
            const days = opts?.days ? Number.parseInt(opts.days, 10) : 3;
            const dryRun = !!opts?.dryRun;
            const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
            const includeTrajectories = opts?.trajectories !== false;
            const includeClosedLoop = opts?.closedLoop !== false;
            let res;
            try {
              res = await runExtractImplicitFeedback({
                days,
                dryRun,
                ...scanMaintenanceOverridePayload(opts),
                verbose,
                includeTrajectories,
                includeClosedLoop,
              });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "extract-implicit",
              });
              throw err;
            }
            console.log(
              `Extract-implicit complete: ${res.signalsExtracted} signals from ${res.sessionsScanned} sessions ${dryRun ? "(dry-run)" : ""}`,
            );
            console.log(`  Sessions visited: ${res.sessionsVisited}`);
            console.log(`  Sessions processed: ${res.sessionsProcessed}`);
            console.log(`  Sessions skipped: ${res.sessionsSkipped}`);
            if (res.sessionsDeferred > 0) {
              console.log(`  Sessions deferred: ${res.sessionsDeferred}`);
              console.log(
                `  Backlog estimate: ${res.backlogSignalsEstimate} signals, ${res.backlogTrajectoriesEstimate} trajectories`,
              );
            }
            console.log(`  Positive signals: ${res.positiveCount}`);
            console.log(`  Negative signals: ${res.negativeCount}`);
            console.log(`  Trajectories built: ${res.trajectoriesBuilt}`);
            if (res.partial) {
              console.log(`  Partial run: yes (${res.partialReason ?? "capped"})`);
              process.exitCode = 2;
            }
            if (res.closedLoopReport) {
              console.log(`\n${res.closedLoopReport}`);
            }
          },
        ),
      ),
    );
  }

  // ----- cross-agent-learning (Issue #263 — Phase 2) -----
  mem
    .command(names.crossAgent)
    .description("Generalise agent-scoped lessons into global patterns (Issue #263 — Phase 2)")
    .option("-v, --verbose", "Log each LLM batch and use hybrid-mem -v for full plugin output")
    .action(
      withExit(
        maybeWrap(
          "cross-agent-learning",
          "cross-agent",
          async (opts?: { verbose?: boolean }, cmd?: CommanderOptsParent) => {
            const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
            if (!runCrossAgentLearning) {
              console.error("cross-agent-learning is not available in this context.");
              process.exitCode = 1;
              return;
            }
            if (!cfg.crossAgentLearning?.enabled) {
              console.log("Cross-agent learning is disabled (crossAgentLearning.enabled = false).");
              return;
            }
            let res;
            try {
              res = await runCrossAgentLearning(verbose ? { verbose: true } : undefined);
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "cross-agent-learning",
              });
              throw err;
            }
            console.log("Cross-agent learning complete:");
            console.log(`  Agents scanned: ${res.agentsScanned}`);
            console.log(`  Lessons considered: ${res.lessonsConsidered}`);
            console.log(`  Generalised stored: ${res.generalisedStored}`);
            console.log(`  Provenance sources recorded: ${res.provenanceRecorded}`);
            console.log(`  Skipped duplicates: ${res.skippedDuplicates}`);
            const summary = `agents=${res.agentsScanned} generalised=${res.generalisedStored} errors=${res.errors} semantic=${res.errors > 0 ? "partial" : "success"}`;
            console.log(`cross-agent-learning: ${summary}`);
            if (res.errors > 0) process.exitCode = 2;
          },
        ),
      ),
    );

  // ----- cost-report (Issue #270) — top-level only, not under `learn` group -----
  if (!grouped) {
    mem
      .command("cost-report")
      .description("Show LLM token usage and estimated cost breakdown by feature (Issue #270)")
      .option("--days <n>", "Days of history to include (default: 7)", "7")
      .option("--model", "Show breakdown by model instead of feature")
      .option("--feature <name>", "Filter to a specific feature (e.g. auto-classify)")
      .option("--csv", "Output as CSV")
      .option("--format <format>", "Output format: pretty (default, emoji+%) or compact (terse)", "pretty")
      .option("--modes", "Show estimated $/month cost ranges for each config mode (local/minimal/enhanced/complete)")
      .action(
        withExit(
          async (opts?: {
            days?: string;
            model?: boolean;
            feature?: string;
            csv?: boolean;
            format?: string;
            modes?: boolean;
          }) => {
            if (!runCostReport) {
              console.error("cost-report is not available in this context.");
              process.exitCode = 1;
              return;
            }
            const days = opts?.days ? Number.parseInt(opts.days, 10) : 7;
            const format = opts?.format === "compact" ? ("compact" as const) : ("pretty" as const);
            runCostReport(
              { days, model: !!opts?.model, feature: opts?.feature, csv: !!opts?.csv, format, modes: !!opts?.modes },
              { log: (msg) => console.log(msg) },
            );
          },
        ),
      );
  }

  // ----- tool-effectiveness (Issue #263 — Phase 3) -----
  mem
    .command(names.tools)
    .description("Compute and display tool effectiveness scores from workflow traces (Issue #263 — Phase 3)")
    .option("-v, --verbose", "Show detailed per-tool breakdown")
    .action(
      withExit(
        maybeWrap("tool-effectiveness", "tools", async (opts?: { verbose?: boolean }, cmd?: CommanderOptsParent) => {
          if (!runToolEffectiveness) {
            console.error("tool-effectiveness is not available in this context.");
            process.exitCode = 1;
            return;
          }
          let output: string;
          try {
            output = await runToolEffectiveness({
              verbose: !!opts?.verbose || readHybridMemVerbose(cmd),
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "tool-effectiveness",
            });
            throw err;
          }
          console.log(output);
        }),
      ),
    );

  mem
    .command(names.feedback)
    .description(
      "Analyze session logs with an LLM (e.g. Gemini) to discover your praise/frustration phrases; optional --learn to save to .user-feedback-phrases.json",
    )
    .option("--days <n>", "Days of sessions to analyze (omit for auto: 30 on first run, 3 thereafter)")
    .option("--model <m>", "LLM model (e.g. gemini-2.0-flash for 1M context)", "")
    .option("--output <path>", "Write suggested phrases JSON to file", "")
    .option(
      "--learn",
      "Merge discovered phrases into .user-feedback-phrases.json (reinforcement/correction detection will use them)",
    )
    .action(
      withExit(
        maybeWrap(
          "analyze-feedback-phrases",
          "feedback",
          async (opts?: { days?: string; model?: string; output?: string; learn?: boolean }) => {
            if (!runAnalyzeFeedbackPhrases) {
              console.error("analyze-feedback-phrases is not available in this context.");
              process.exitCode = 1;
              return;
            }
            const days = opts?.days ? Number.parseInt(opts.days, 10) : undefined;
            const outputPath = opts?.output;
            const learn = !!opts?.learn;
            const model = opts?.model?.trim() || undefined;
            let res;
            try {
              res = await runAnalyzeFeedbackPhrases({ days, model, outputPath, learn });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "analyze-feedback-phrases",
              });
              throw err;
            }
            if (res.error) {
              console.error(res.error);
              process.exitCode = 1;
              return;
            }
            console.log(`Sessions scanned: ${res.sessionsScanned}`);
            console.log(`Reinforcement phrases: ${res.reinforcement.length}`);
            if (res.reinforcement.length > 0) {
              res.reinforcement.slice(0, 15).forEach((p) => {
                console.log(`  + ${p}`);
              });
              if (res.reinforcement.length > 15) console.log(`  ... and ${res.reinforcement.length - 15} more`);
            }
            console.log(`Correction phrases: ${res.correction.length}`);
            if (res.correction.length > 0) {
              res.correction.slice(0, 15).forEach((p) => {
                console.log(`  - ${p}`);
              });
              if (res.correction.length > 15) console.log(`  ... and ${res.correction.length - 15} more`);
            }
            if (res.learned) {
              console.log(
                "Phrases saved to .user-feedback-phrases.json (reinforcement/correction detection will use them).",
              );
            }
            if (outputPath) {
              console.log(`Output written to ${outputPath}`);
            }
          },
        ),
      ),
    );
}

/** Register grouped `learn` commands plus deprecated flat aliases. */
export function registerLearnGroup(mem: Chainable, b: ManageBindings): void {
  const group = createCommandGroup(mem, "learn", "Self-correction and feedback learning");
  registerManageSelfCorrectionFeedback(group, b, { names: GROUPED_LEARN_COMMAND_NAMES, grouped: true });
  registerManageSelfCorrectionFeedback(mem, b, { flatDeprecatedOn: mem });
}
