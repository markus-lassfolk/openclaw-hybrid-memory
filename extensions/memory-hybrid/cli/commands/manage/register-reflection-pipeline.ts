/**
 * reflection & dream-cycle commands — split from register-corrections-and-pipeline.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getCronModelConfig, getDefaultCronModel } from "../../../config.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { cleanupImplicitFeedbackDuplicates, type ExtractImplicitFeedbackProgressSnapshot } from "../../cmd-feedback.js";
import { getEffectivenessReport, runClosedLoopAnalysis } from "../../../services/feedback-effectiveness.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { PROJECT_STATE_LWW_KEYS } from "../../../backends/facts-db/contradictions.js";
import type {
  ContradictionReviewDecision,
  ContradictionReviewItem,
} from "../../../backends/facts-db/contradictions.js";

import {
  assessContinuousVerificationResult,
  formatExtractImplicitFeedbackProgress,
  runVerboseFollowUp,
  type RunVerboseFollowUpOptions,
} from "./dream-cycle-followup.js";
import { runMaintenanceHeartbeat } from "./maintenance-heartbeat.js";

function writeContradictionReviewFile(outputPath: string, items: ContradictionReviewItem[]): void {
  const content = `${items.map((item) => JSON.stringify(item)).join("\n")}${items.length > 0 ? "\n" : ""}`;
  writeFileSync(outputPath, content, "utf-8");
}

function parseContradictionReviewFile(inputPath: string): ContradictionReviewDecision[] {
  const content = readFileSync(inputPath, "utf-8");
  const decisions: ContradictionReviewDecision[] = [];
  const errors: string[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      errors.push(`line ${index + 1}: invalid JSON`);
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      errors.push(`line ${index + 1}: expected object`);
      continue;
    }
    const candidate = parsed as Partial<ContradictionReviewDecision>;
    if (typeof candidate.contradictionId !== "string" || candidate.contradictionId.trim() === "") {
      errors.push(`line ${index + 1}: missing contradictionId`);
      continue;
    }
    if (
      candidate.decision !== "keep_new" &&
      candidate.decision !== "keep_old" &&
      candidate.decision !== "merge" &&
      candidate.decision !== "manual_review"
    ) {
      errors.push(`line ${index + 1}: unsupported decision`);
      continue;
    }
    decisions.push({
      contradictionId: candidate.contradictionId,
      decision: candidate.decision,
      reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
      confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined,
      mergedFactText: typeof candidate.mergedFactText === "string" ? candidate.mergedFactText : undefined,
    });
  }
  if (errors.length > 0) {
    throw new Error(`Invalid review file ${inputPath}: ${errors.join("; ")}`);
  }
  return decisions;
}

export function registerManageReflectionPipeline(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    cfg,
    runFindDuplicates,
    runConsolidate,
    runReflection,
    reflectionConfig,
    runReflectionRules,
    runReflectionMeta,
    runReflectIdentity,
    runClassify,
    runEntityEnrichment,
    runDreamCycle,
    runContinuousVerification,
    runExtractImplicitFeedback,
    runCrossAgentLearning,
    runToolEffectiveness,
    pruneCostLog,
    runBackfill,
    runIngestFiles,
    runExport,
    runBuildLanguageKeywords,
    ctx,
  } = b;

  mem
    .command("backfill")
    .description(
      "Backfill memory from workspace documents (Markdown, text files). Run once to seed memory with existing project docs.",
    )
    .option("--dry-run", "Show what would be stored without storing")
    .option("--workspace <w>", "Workspace path (default: cwd)")
    .option("--limit <n>", "Max facts to store (default: no limit)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; workspace?: string; limit?: string }) => {
        let res;
        try {
          res = await runBackfill(
            {
              dryRun: !!opts?.dryRun,
              workspace: opts?.workspace,
              limit: opts?.limit ? Number.parseInt(opts.limit, 10) : undefined,
            },
            { log: console.log, warn: console.warn },
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "backfill",
          });
          throw err;
        }
        console.log(
          `Backfill complete: ${res.stored} stored, ${res.skipped} skipped, ${res.candidates} candidates, ${res.files} files ${opts?.dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  mem
    .command("ingest-files")
    .description(
      "Ingest files from workspace (Markdown, text). Extract facts and store in memory. Use --paths for specific files.",
    )
    .option("--dry-run", "Show what would be stored without storing")
    .option("--workspace <w>", "Workspace path (default: cwd)")
    .option("--paths <p...>", "Specific file paths (relative to workspace)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; workspace?: string; paths?: string[] }) => {
        let res;
        try {
          res = await runIngestFiles(
            { dryRun: !!opts?.dryRun, workspace: opts?.workspace, paths: opts?.paths },
            { log: console.log, warn: console.warn },
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "ingest-files",
          });
          throw err;
        }
        console.log(
          `Ingest complete: ${res.stored} stored, ${res.skipped} skipped, ${res.extracted} extracted, ${res.files} files ${opts?.dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  mem
    ?.command("export")
    .description(
      "Export memory to MEMORY.md + memory/ directory (vanilla OpenClaw format). Use --output to specify path.",
    )
    .requiredOption("--output <path>", "Output directory path")
    .option("--exclude-credentials", "Exclude credentials from export")
    .option("--include-credentials", "Include credentials in export (default: exclude)")
    .option("--sources <s...>", "Filter by source (comma-separated)")
    .option("--mode <m>", "Export mode: replace (overwrite) or additive (merge). Default: replace.", "replace")
    .action(
      withExit(
        async (opts: {
          output: string;
          excludeCredentials?: boolean;
          includeCredentials?: boolean;
          sources?: string[];
          mode?: "replace" | "additive";
        }) => {
          let res;
          try {
            res = await runExport({
              outputPath: opts.output,
              excludeCredentials: opts.excludeCredentials,
              includeCredentials: opts.includeCredentials,
              sources: opts.sources,
              mode: opts.mode ?? "replace",
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "export",
            });
            throw err;
          }
          console.log(
            `Exported ${res.factsExported} facts, ${res.proceduresExported} procedures to ${res.outputPath} (${res.filesWritten} files written).`,
          );
        },
      ),
    );

  mem
    .command("find-duplicates")
    .description("Find duplicate or near-duplicate facts using vector similarity")
    .option("--threshold <n>", "Similarity threshold (0-1, default 0.85)", "0.85")
    .option("--include-structured", "Include structured facts (kv, credentials) in search")
    .option("--limit <n>", "Max pairs to return (default 100)", "100")
    .action(
      withExit(async (opts?: { threshold?: string; includeStructured?: boolean; limit?: string }) => {
        const threshold = Number.parseFloat(opts?.threshold ?? "0.85");
        const includeStructured = !!opts?.includeStructured;
        const limit = Number.parseInt(opts?.limit ?? "100", 10);
        let res;
        try {
          res = await runFindDuplicates({ threshold, includeStructured, limit });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "find-duplicates",
          });
          throw err;
        }
        console.log(
          `Found ${res.pairs.length} duplicate pairs (threshold=${threshold}, candidates=${res.candidatesCount}, skippedStructured=${res.skippedStructured})`,
        );
        for (const p of res.pairs) {
          console.log(`  [${p.idA}] <-> [${p.idB}] (score=${p.score.toFixed(3)})`);
          console.log(`    A: ${p.textA.substring(0, 60)}...`);
          console.log(`    B: ${p.textB.substring(0, 60)}...`);
        }
      }),
    );

  mem
    .command("consolidate")
    .description("Consolidate duplicate facts: cluster by vector similarity, merge via LLM, delete originals")
    .option("--threshold <n>", "Similarity threshold (0-1, default 0.85)", "0.85")
    .option("--include-structured", "Include structured facts (kv, credentials) in consolidation")
    .option("--dry-run", "Show what would be consolidated without consolidating")
    .option("--limit <n>", "Max clusters to process (default 10)", "10")
    .option("--model <m>", "LLM model for merging (default: default tier from config)")
    .action(
      withExit(
        async (opts?: {
          threshold?: string;
          includeStructured?: boolean;
          dryRun?: boolean;
          limit?: string;
          model?: string;
        }) => {
          const threshold = Number.parseFloat(opts?.threshold ?? "0.85");
          const includeStructured = !!opts?.includeStructured;
          const dryRun = !!opts?.dryRun;
          const limit = Number.parseInt(opts?.limit ?? "10", 10);
          const model = opts?.model ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "maintenance");
          let res;
          try {
            res = await runConsolidate({ threshold, includeStructured, dryRun, limit, model });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "consolidate",
            });
            throw err;
          }
          console.log(
            `Consolidation complete: ${res.clustersFound} clusters found, ${res.merged} merged, ${res.deleted} deleted ${dryRun ? "(dry-run)" : ""}`,
          );
        },
      ),
    );

  // Add consolidate-episodes as an alias/compatibility command
  mem
    .command("consolidate-episodes")
    .description(
      "(Deprecated) Consolidate episodic memories. Use 'dream-cycle' for nightly maintenance or 'consolidate' for duplicate facts.",
    )
    .action(
      withExit(async () => {
        console.error("Warning: 'consolidate-episodes' is deprecated (exits 0 for automation compatibility).");
        console.error("");
        console.error("For episodic memory consolidation as part of nightly maintenance:");
        console.error("  openclaw hybrid-mem dream-cycle");
        console.error("");
        console.error("For consolidating duplicate facts:");
        console.error("  openclaw hybrid-mem consolidate");
        console.error("");
        console.error("See also: https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1206");
        process.exitCode = 0;
      }),
    );

  mem
    .command("reflect")
    .description("Run reflection: analyze recent facts, extract patterns, store in memory")
    .option("--window <n>", "Days to look back (default from config)", reflectionConfig.defaultWindow.toString())
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("-v, --verbose", "Log each pattern as it is extracted")
    .action(
      withExit(
        async (
          opts?: { window?: string; dryRun?: boolean; model?: string; verbose?: boolean },
          cmd?: CommanderOptsParent,
        ) => {
          const window = opts?.window ? Number.parseInt(opts.window, 10) : reflectionConfig.defaultWindow;
          const dryRun = !!opts?.dryRun;
          const model =
            opts?.model ?? reflectionConfig.model ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "maintenance");
          const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
          let res;
          try {
            res = await runReflection({ window, dryRun, model, verbose });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "reflect",
            });
            throw err;
          }
          console.log(
            `Reflection complete: analyzed ${res.factsAnalyzed} facts, extracted ${res.patternsExtracted} patterns, stored ${res.patternsStored} ${dryRun ? "(dry-run)" : ""}`,
          );
        },
      ),
    );

  mem
    .command("reflect-rules")
    .description("Run reflection (rules): extract high-level rules from patterns")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("-v, --verbose", "Log each rule as it is extracted")
    .action(
      withExit(async (opts?: { dryRun?: boolean; model?: string; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const dryRun = !!opts?.dryRun;
        const model =
          opts?.model ?? reflectionConfig.model ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "maintenance");
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        let res;
        try {
          res = await runReflectionRules({ dryRun, model, verbose });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "reflect-rules",
          });
          throw err;
        }
        console.log(
          `Reflection (rules) complete: extracted ${res.rulesExtracted} rules, stored ${res.rulesStored} ${dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  mem
    .command("reflect-meta")
    .description("Run reflection (meta-patterns): extract meta-patterns from existing patterns")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("-v, --verbose", "Log each meta-pattern as it is extracted")
    .option("--collapse-implicit-feedback", "Collapse near-duplicate implicit-feedback trajectory signals")
    .option(
      "--include-legacy",
      "With --collapse-implicit-feedback, also collapse legacy category=pattern implicit-feedback rows",
    )
    .option("--threshold <n>", "Jaccard similarity threshold for implicit-feedback collapse", "0.8")
    .option("--limit <n>", "Maximum implicit-feedback rows to scan per page", "1000")
    .action(
      withExit(
        async (
          opts?: {
            dryRun?: boolean;
            model?: string;
            verbose?: boolean;
            collapseImplicitFeedback?: boolean;
            includeLegacy?: boolean;
            threshold?: string;
            limit?: string;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const dryRun = !!opts?.dryRun;
          const model =
            opts?.model ?? reflectionConfig.model ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "maintenance");
          const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
          if (opts?.collapseImplicitFeedback) {
            const thresholdRaw = opts?.threshold ? Number.parseFloat(opts.threshold) : 0.8;
            const threshold =
              Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1 ? thresholdRaw : 0.8;
            const limitRaw = opts?.limit ? Number.parseInt(opts.limit, 10) : 1000;
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(10000, Math.floor(limitRaw)) : 1000;
            let afterRowid = 0;
            let scanned = 0;
            let collapsed = 0;
            let carryCanonical: ReadonlyArray<{ id: string; text: string }> | undefined;
            let batches = 0;
            await runMaintenanceHeartbeat(
              "reflect-meta-collapse",
              verbose,
              async (heartbeat) => {
                for (;;) {
                  batches++;
                  const res = cleanupImplicitFeedbackDuplicates(factsDb, {
                    threshold,
                    limit,
                    afterRowid,
                    dryRun,
                    seedCanonical: carryCanonical,
                    includeLegacy: opts?.includeLegacy === true,
                    reportEvery: 250,
                    onProgress: () => heartbeat.heartbeat(),
                  });
                  scanned += res.scanned;
                  collapsed += res.collapsed;
                  carryCanonical = res.carryCanonical;
                  heartbeat.heartbeat();
                  if (res.scanned < limit || res.resumeAfterRowid == null) break;
                  afterRowid = res.resumeAfterRowid;
                  await new Promise((resolve) => setImmediate(resolve));
                }
              },
              {
                forceHeartbeat: true,
                progressSupplier: () =>
                  `stage=scan; batches=${batches}; scanned=${scanned}; collapsed=${collapsed}; includeLegacy=${opts?.includeLegacy === true ? "yes" : "no"}`,
              },
            );
            console.log(
              `Implicit-feedback collapse complete: scanned ${scanned}, collapsed ${collapsed} ${dryRun ? "(dry-run)" : ""}`,
            );
            return;
          }
          let res;
          try {
            res = await runMaintenanceHeartbeat(
              "reflect-meta",
              verbose,
              () => runReflectionMeta({ dryRun, model, verbose }),
              {
                progressSupplier: () => `stage=extract-meta-patterns; dryRun=${dryRun ? "yes" : "no"}`,
              },
            );
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "reflect-meta",
            });
            throw err;
          }
          console.log(
            `Reflection (meta) complete: extracted ${res.metaExtracted} meta-patterns, stored ${res.metaStored} ${dryRun ? "(dry-run)" : ""}`,
          );
        },
      ),
    );

  if (runReflectIdentity) {
    mem
      .command("reflect-identity")
      .description("Run identity reflection: synthesize persona-level insights from reflection outputs")
      .option("--window <n>", "Days to look back (default from config)", reflectionConfig.defaultWindow.toString())
      .option("--dry-run", "Show what would be stored without storing")
      .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
      .option("-v, --verbose", "Log each identity insight as it is stored")
      .action(
        withExit(
          async (
            opts?: { window?: string; dryRun?: boolean; model?: string; verbose?: boolean },
            cmd?: CommanderOptsParent,
          ) => {
            const window = opts?.window ? Number.parseInt(opts.window, 10) : reflectionConfig.defaultWindow;
            const dryRun = !!opts?.dryRun;
            const model =
              opts?.model ?? reflectionConfig.model ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "maintenance");
            const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
            const res = await runReflectIdentity({ dryRun, model, verbose, window });
            console.log(
              `Identity reflection complete: extracted ${res.insightsExtracted} insights, stored ${res.insightsStored} ${dryRun ? "(dry-run)" : ""}`,
            );
          },
        ),
      );
  }

  if (runDreamCycle) {
    mem
      .command("dream-cycle")
      .description(
        "Run nightly dream cycle: prune expired/decayed facts, consolidate old episodic events, reflect to extract patterns, optionally extract rules",
      )
      .option("-v, --verbose", "Detailed progress (reflection, memory index, WAL flush, nightly follow-up steps)")
      .action(
        withExit(async (opts?: { verbose?: boolean }, cmd?: CommanderOptsParent) => {
          const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
          const pipelineStartedAt = Date.now();
          const coreStartedAt = Date.now();
          let res;
          const followUpFailures: Array<{ phase: string; error: string }> = [];
          try {
            res = await runDreamCycle(verbose ? { verbose: true } : undefined);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "dream-cycle",
            });
            throw err;
          }
          const coreElapsedSec = Math.floor((Date.now() - coreStartedAt) / 1000);
          if (res.skipped) {
            console.log("Dream cycle skipped (nightlyCycle.enabled = false in config).");
          } else {
            console.log(`Dream cycle complete: ${res.digestSummary}`);
            console.log(`  Core cycle elapsed: ${coreElapsedSec}s`);
            console.log(`  Facts pruned: ${res.factsPruned}`);
            console.log(`  Facts decayed: ${res.factsDecayed}`);
            console.log(`  Events consolidated: ${res.eventsConsolidated} → ${res.factsCreated} facts`);
            console.log(`  Patterns found: ${res.patternsFound}`);
            console.log(`  Rules generated: ${res.rulesGenerated}`);
          }

          const followUpPlan: string[] = [];
          if (
            !res.skipped &&
            runContinuousVerification &&
            cfg.verification.enabled &&
            cfg.verification.continuousVerification
          ) {
            followUpPlan.push("continuous verification");
          }
          if (!res.skipped && runExtractImplicitFeedback && cfg.implicitFeedback?.enabled !== false) {
            followUpPlan.push("extract implicit feedback");
          }
          if (!res.skipped && cfg.closedLoop?.enabled !== false && cfg.closedLoop?.runInNightlyCycle !== false) {
            followUpPlan.push("closed-loop effectiveness");
          }
          if (
            !res.skipped &&
            runCrossAgentLearning &&
            cfg.crossAgentLearning?.enabled &&
            cfg.crossAgentLearning?.runInNightlyCycle !== false
          ) {
            followUpPlan.push("cross-agent learning");
          }
          if (
            !res.skipped &&
            runToolEffectiveness &&
            cfg.toolEffectiveness?.enabled !== false &&
            cfg.toolEffectiveness?.runInNightlyCycle !== false
          ) {
            followUpPlan.push("tool effectiveness");
          }
          if (
            !res.skipped &&
            pruneCostLog &&
            cfg.costTracking?.enabled !== false &&
            cfg.costTracking?.pruneInNightlyCycle !== false
          ) {
            followUpPlan.push("cost log prune");
          }

          let followUpCompleted = 0;
          const runFollowUpStage = async <T>(
            phaseLabel: string,
            fn: () => Promise<T> | T,
            options?: RunVerboseFollowUpOptions,
          ): Promise<T> => {
            const stageIndex = followUpCompleted + 1;
            try {
              return await runVerboseFollowUp(phaseLabel, verbose, fn, {
                ...options,
                stageIndex: followUpPlan.length > 0 ? stageIndex : undefined,
                stageTotal: followUpPlan.length > 0 ? followUpPlan.length : undefined,
              });
            } finally {
              followUpCompleted++;
            }
          };

          if (!res.skipped && verbose) {
            const labels = followUpPlan.length > 0 ? followUpPlan.join(", ") : "none";
            console.log(`[dream-cycle] follow-up plan: ${followUpPlan.length} stage(s) — ${labels}`);
          }

          if (
            !res.skipped &&
            runContinuousVerification &&
            cfg.verification.enabled &&
            cfg.verification.continuousVerification
          ) {
            let verificationRes;
            try {
              verificationRes = await runFollowUpStage("continuous verification", () =>
                runContinuousVerification(verbose ? { verbose: true } : undefined),
              );
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "continuous-verification",
              });
              throw err;
            }
            console.log("Continuous verification complete:");
            console.log(`  Checked: ${verificationRes.checked}`);
            console.log(`  Confirmed: ${verificationRes.confirmed}`);
            console.log(`  Stale: ${verificationRes.stale}`);
            console.log(`  Uncertain: ${verificationRes.uncertain}`);
            console.log(`  Errors: ${verificationRes.errors}`);
            if (verificationRes.errorSummaries.length > 0) {
              console.log("  Error summary:");
              for (const summary of verificationRes.errorSummaries) {
                console.log(`    - ${summary}`);
              }
            }
            const verificationAssessment = assessContinuousVerificationResult(verificationRes);
            if (verificationAssessment.status !== "healthy") {
              console.log(`  Status: ${verificationAssessment.status.toUpperCase()}`);
              if (verificationAssessment.summary) {
                console.log(`  Warning: ${verificationAssessment.summary}`);
              }
              if (verificationAssessment.shouldFailPipeline) {
                followUpFailures.push({
                  phase: "continuous verification",
                  error: verificationAssessment.summary ?? "verification follow-up degraded",
                });
                // Keep running the remaining follow-up stages for observability, but make the
                // standalone CLI exit non-zero once the pipeline completes.
                process.exitCode = 2;
              }
            }
          }

          // Extract implicit feedback signals as part of nightly cycle
          if (!res.skipped && runExtractImplicitFeedback && cfg.implicitFeedback?.enabled !== false) {
            try {
              let latestProgress: ExtractImplicitFeedbackProgressSnapshot | undefined;
              const implRes = await runFollowUpStage(
                "extract implicit feedback",
                () =>
                  runExtractImplicitFeedback({
                    days: 3,
                    dryRun: false,
                    includeClosedLoop: false,
                    verbose,
                    onProgress: (snapshot) => {
                      latestProgress = snapshot;
                    },
                  }),
                {
                  progressSupplier: () => formatExtractImplicitFeedbackProgress(latestProgress),
                },
              );
              console.log(
                `Extract-implicit: ${implRes.signalsExtracted} signals (${implRes.positiveCount}+/${implRes.negativeCount}-) from ${implRes.sessionsScanned} sessions.`,
              );
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:extract-implicit",
              });
            }
          }

          // Closed-loop effectiveness analysis
          if (!res.skipped && cfg.closedLoop?.enabled !== false && cfg.closedLoop?.runInNightlyCycle !== false) {
            try {
              const clReport = await runFollowUpStage("closed-loop effectiveness", () =>
                runClosedLoopAnalysis(factsDb, cfg.closedLoop ?? { enabled: true }, {
                  verbose,
                  logger: (msg) => console.log(msg),
                }),
              );
              console.log(
                `Closed-loop analysis: ${clReport.rulesAnalyzed} rules measured, ${clReport.deprecated} deprecated, ${clReport.boosted} boosted.`,
              );
              if (clReport.rulesAnalyzed > 0) {
                const report = getEffectivenessReport(factsDb);
                if (report && report.length > 0) console.log(report);
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:closed-loop",
              });
            }
          }

          // Cross-agent learning (Issue #263 — Phase 2)
          if (
            !res.skipped &&
            runCrossAgentLearning &&
            cfg.crossAgentLearning?.enabled &&
            cfg.crossAgentLearning?.runInNightlyCycle !== false
          ) {
            try {
              const caRes = await runFollowUpStage("cross-agent learning", () =>
                runCrossAgentLearning(verbose ? { verbose: true } : undefined),
              );
              console.log(
                `Cross-agent learning: ${caRes.generalisedStored} generalised patterns stored from ${caRes.agentsScanned} agents.`,
              );
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:cross-agent-learning",
              });
            }
          }

          // Tool effectiveness scoring (Issue #263 — Phase 3)
          if (
            !res.skipped &&
            runToolEffectiveness &&
            cfg.toolEffectiveness?.enabled !== false &&
            cfg.toolEffectiveness?.runInNightlyCycle !== false
          ) {
            try {
              const teOutput = await runFollowUpStage("tool effectiveness", () => runToolEffectiveness({ verbose }));
              if (teOutput && !teOutput.startsWith("No tool")) {
                console.log(`Tool effectiveness: ${teOutput.split("\n")[0]}`);
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:tool-effectiveness",
              });
              followUpFailures.push({
                phase: "tool effectiveness",
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // Cost log pruning (Issue #270)
          if (
            !res.skipped &&
            pruneCostLog &&
            cfg.costTracking?.enabled !== false &&
            cfg.costTracking?.pruneInNightlyCycle !== false
          ) {
            try {
              const pruned = await runFollowUpStage("cost log prune", () => pruneCostLog(cfg.costTracking?.retainDays));
              if (pruned > 0) console.log(`Cost log: pruned ${pruned} old entries.`);
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:cost-log-prune",
              });
            }
          }

          if (!res.skipped && followUpFailures.length > 0) {
            console.log(`Dream cycle follow-ups: ${followUpFailures.length} failure(s)`);
            for (const f of followUpFailures) {
              console.log(`  - ${f.phase}: ${f.error}`);
            }
          }

          if (!res.skipped) {
            const totalElapsedSec = Math.floor((Date.now() - pipelineStartedAt) / 1000);
            const followUpElapsedSec = Math.max(0, totalElapsedSec - coreElapsedSec);
            console.log(
              `[dream-cycle] pipeline complete in ${totalElapsedSec}s (core=${coreElapsedSec}s, follow-ups=${followUpCompleted}/${followUpPlan.length}, follow-up-elapsed=${followUpElapsedSec}s, follow-up-failures=${followUpFailures.length})`,
            );
          }
        }),
      );
  }

  mem
    .command("resolve-contradictions")
    .description("Resolve unresolved contradictions (auto-resolve obvious cases, report ambiguous pairs)")
    .option("-v, --verbose", "List every auto-resolved pair and all ambiguous pairs")
    .option(
      "--details",
      "For ambiguous pairs, print entity/key/value summaries (not only UUIDs); implies listing all ambiguous rows",
    )
    .option(
      "--project-state-lww",
      "Apply project-state latest-wins (LWW) policy: safely resolve stale project/task contradictions for known mutable keys",
    )
    .option("--auto", "Run the autonomous contradiction-resolution pipeline")
    .option("--dry-run", "Project-state LWW contract mode: preview contradiction-resolution candidates")
    .option("--apply", "Project-state LWW contract mode: apply contradiction-resolution candidates")
    .option("--target-rate <n>", "Autonomous mode target auto-resolution rate (default 0.80)")
    .option("--export-review <path>", "Write remaining manual-review items as stable JSONL")
    .option("--apply-review <path>", "Apply reviewed contradiction decisions from JSONL")
    .option("--llm", "Enable opt-in LLM adjudication for non-deterministic contradictions")
    .option("--model <m>", "LLM model for contradiction adjudication")
    .action(
      withExit(
        async (
          opts?: {
            verbose?: boolean;
            details?: boolean;
            projectStateLww?: boolean;
            auto?: boolean;
            dryRun?: boolean;
            apply?: boolean;
            targetRate?: string;
            exportReview?: string;
            applyReview?: string;
            llm?: boolean;
            model?: string;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
          const details = !!opts?.details;
          const projectStateLww = !!opts?.projectStateLww;
          const auto = !!opts?.auto || !!opts?.exportReview || !!opts?.llm;
          const dryRun = !!opts?.dryRun;
          const apply = !!opts?.apply;
          const exportReview = opts?.exportReview;
          const applyReview = opts?.applyReview;
          const llm = !!opts?.llm;
          const model = opts?.model;
          const targetRate = Number.parseFloat(opts?.targetRate ?? "0.80");

          if (dryRun && apply) {
            throw new Error("--dry-run and --apply are mutually exclusive");
          }
          if (Number.isNaN(targetRate) || targetRate <= 0 || targetRate > 1) {
            throw new Error("--target-rate must be a number between 0 and 1");
          }
          if (applyReview && (auto || projectStateLww || dryRun || apply || exportReview || llm || model)) {
            throw new Error(
              "--apply-review cannot be combined with --auto, --project-state-lww, --dry-run, --apply, --export-review, --llm, or --model",
            );
          }

          if (applyReview) {
            const decisions = parseContradictionReviewFile(applyReview);
            const res = await ctx.runApplyContradictionReviewDecisions(decisions);
            console.log(
              `contradiction-review apply summary applied=${res.applied} kept_new=${res.keptNew} kept_old=${res.keptOld} manual_review=${res.manualReview} rejected=${res.rejected}`,
            );
            if (res.errors.length > 0) {
              for (const error of res.errors) {
                console.log(`  - ${error}`);
              }
            }
            return;
          }

          // Operator contract mode for Issue #1636:
          //   resolve-contradictions --dry-run
          //   resolve-contradictions --apply
          // Legacy compatibility: --project-state-lww keeps working as explicit LWW mode.
          const projectStateLwwContractMode = !auto && (projectStateLww || apply || dryRun);
          if (projectStateLwwContractMode) {
            const lwwDryRun = dryRun;
            // Project-state LWW mode: grouped, human-readable output.
            let lwwRes;
            try {
              lwwRes = await ctx.runResolveContradictionsProjectStateLww({ dryRun: lwwDryRun });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "resolve-contradictions-project-state-lww",
              });
              throw err;
            }

            const modeLabel = lwwDryRun ? "(dry-run)" : "(applied)";
            if (lwwDryRun) {
              console.log(
                `project-state-lww candidates ${modeLabel}: ${lwwRes.totalCandidates} total — would supersede: ${lwwRes.wouldSupersede}, manual review: ${lwwRes.wouldManualReview}`,
              );
            } else {
              console.log(
                `project-state-lww ${modeLabel}: ${lwwRes.applied} superseded, ${lwwRes.wouldManualReview} manual-review remaining.`,
              );
            }
            const autoResolved = lwwDryRun ? lwwRes.wouldSupersede : lwwRes.applied;
            console.log(
              `project-state-lww summary auto-resolved=${autoResolved} dry-run=${lwwDryRun ? 1 : 0} remaining=${lwwRes.wouldManualReview} total-candidates=${lwwRes.totalCandidates}`,
            );

            if (lwwRes.groups.length > 0) {
              const formatEpochTimestamp = (t: number) =>
                new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19);
              for (const group of lwwRes.groups) {
                const scopeLabel =
                  group.scope && group.scope !== "global"
                    ? ` [scope=${group.scope}${group.scopeTarget ? `/${group.scopeTarget}` : ""}]`
                    : "";
                console.log(`\n  ${group.entity} / ${group.key}${scopeLabel}`);
                for (const cand of group.candidates) {
                  const overloadNote = cand.possibleOverloadedEntity ? " [!] possible-entity-reuse" : "";
                  const actionLabel =
                    cand.action === "supersede" ? "auto-safe: project-state-lww" : "manual: non-qualifying";
                  const keepLabel = cand.action === "supersede" ? "keep" : "newer";
                  const supersedeLabel = cand.action === "supersede" ? "supersede" : "older";
                  console.log(`    [${actionLabel}]${overloadNote}`);
                  console.log(
                    `      ${keepLabel.padEnd(10)}: ${formatEpochTimestamp(cand.newFactDate)} src=${cand.newSource} conf=${cand.newConf.toFixed(2)} "${cand.newValueExcerpt}"`,
                  );
                  console.log(
                    `      ${supersedeLabel.padEnd(10)}: ${formatEpochTimestamp(cand.oldFactDate)} src=${cand.oldSource} conf=${cand.oldConf.toFixed(2)} "${cand.oldValueExcerpt}"`,
                  );
                  console.log(`      contradiction: ${cand.contradictionId}`);
                }
              }
              console.log("");
            }

            if (lwwDryRun && lwwRes.wouldSupersede > 0) {
              console.log(`Run with --apply to resolve ${lwwRes.wouldSupersede} project-state-lww contradiction(s).`);
            }
            if (lwwRes.wouldManualReview > 0) {
              console.log(
                `${lwwRes.wouldManualReview} project-state pair(s) require manual review (non-qualifying for LWW).`,
              );
              console.log("  Inspect with: openclaw hybrid-mem resolve-contradictions --details");
            }
            return;
          }

          if (auto) {
            let res;
            try {
              res = await ctx.runResolveContradictionsAuto({
                dryRun: !apply,
                targetRate,
                llm,
                model,
              });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "resolve-contradictions-auto",
              });
              throw err;
            }

            console.log(
              `contradiction-auto summary total=${res.total} deterministic=${res.deterministic} llm=${res.llm} merged=${res.merged} manual_review=${res.manualReview} applied=${res.applied} target=${res.targetRate.toFixed(2)} achieved=${res.achievedRate.toFixed(3)}`,
            );
            if (!res.targetMet) {
              console.log(
                `contradiction-auto target-missed achieved=${res.achievedRate.toFixed(3)} target=${res.targetRate.toFixed(2)}`,
              );
            }
            if (exportReview) {
              writeContradictionReviewFile(exportReview, res.reviewItems);
              console.log(`manual-review exported: ${res.reviewItems.length} item(s) -> ${exportReview}`);
            } else if (res.reviewItems.length > 0) {
              console.log(
                `Manual review remaining: ${res.reviewItems.length}. Export with --export-review <path> for stable JSONL.`,
              );
            }
            if (details && res.reviewItems.length > 0) {
              console.log("Manual-review items:");
              for (const item of res.reviewItems) {
                const scopeLabel =
                  item.scope && item.scope !== "global"
                    ? ` [scope=${item.scope}${item.scopeTarget ? `/${item.scopeTarget}` : ""}]`
                    : "";
                console.log(`  · [${item.entity}] ${item.key}${scopeLabel}`);
                console.log(
                  `      newer ${item.factIdNew}: value=${item.newValueExcerpt} | text=${item.newTextExcerpt} | conf=${item.newConf.toFixed(2)} | src=${item.newSource}`,
                );
                console.log(
                  `      older ${item.factIdOld}: value=${item.oldValueExcerpt} | text=${item.oldTextExcerpt} | conf=${item.oldConf.toFixed(2)} | src=${item.oldSource}`,
                );
                console.log(
                  `      suggested=${item.suggestedDecision} via ${item.suggestedStrategy} (${item.suggestedConfidence.toFixed(2)}) — ${item.suggestedReason}`,
                );
                console.log(`      contradiction row ${item.contradictionId}`);
              }
            } else if (verbose && res.reviewItems.length > 0) {
              console.log("Manual-review contradiction ids:");
              for (const item of res.reviewItems) {
                console.log(`  - ${item.contradictionId} (${item.factIdNew} ↔ ${item.factIdOld})`);
              }
            }
            return;
          }

          if (dryRun) {
            let res;
            try {
              res = await ctx.runResolveContradictionsDryRun();
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "resolve-contradictions-dry-run",
              });
              throw err;
            }
            console.log(
              `Contradictions dry-run: would auto-resolve ${res.autoResolvable.length}, ${res.ambiguous.length} ambiguous.`,
            );
            if (res.autoResolvable.length > 0) {
              console.log("Would auto-resolve:");
              for (const a of res.autoResolvable) {
                console.log(`  - ${a.factIdNew} ↔ ${a.factIdOld} (${a.contradictionId})`);
              }
              console.log("Run without --dry-run to apply these conservative auto-resolutions.");
            }
            if (res.ambiguous.length > 0) {
              console.log(
                "Ambiguous pairs require manual review. Re-run with --details for entity/key/value summaries, or use --project-state-lww --dry-run for project-state candidates.",
              );
            }
            return;
          }

          // Default (conservative) mode: unchanged behavior.
          let res;
          try {
            res = await ctx.runResolveContradictions();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "resolve-contradictions",
            });
            throw err;
          }
          console.log(
            `Contradictions resolved: ${res.autoResolved.length} auto-resolved, ${res.ambiguous.length} ambiguous.`,
          );
          if (verbose && res.autoResolved.length > 0) {
            console.log("Auto-resolved (--verbose):");
            for (const a of res.autoResolved) {
              console.log(`  - ${a.factIdNew} ↔ ${a.factIdOld} (${a.contradictionId})`);
            }
          }
          if (res.ambiguous.length > 0) {
            const trunc = (s: string | null | undefined, n: number): string => {
              if (s == null || s === "") return "(empty)";
              const t = s.replace(/\s+/g, " ").trim();
              return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
            };
            const ambiguousList = verbose || details ? res.ambiguous : res.ambiguous.slice(0, 10);
            if (details) {
              console.log("Ambiguous pairs (same entity + key, different value — pick which fact stays current):");
              for (const a of ambiguousList) {
                const newF = factsDb.getById(a.factIdNew);
                const oldF = factsDb.getById(a.factIdOld);
                const entity = newF?.entity ?? oldF?.entity ?? "?";
                const key = newF?.key ?? oldF?.key ?? "?";
                const newBits = newF
                  ? `value=${trunc(newF.value, 48)} | text=${trunc(newF.text, 72)} | conf=${(newF.confidence ?? 0).toFixed(2)} | src=${newF.source}`
                  : "(newer fact row missing)";
                const oldBits = oldF
                  ? `value=${trunc(oldF.value, 48)} | text=${trunc(oldF.text, 72)} | conf=${(oldF.confidence ?? 0).toFixed(2)} | src=${oldF.source}`
                  : "(older fact row missing)";
                console.log(`  · [${entity}] ${key}`);
                console.log(`      newer fact ${a.factIdNew}: ${newBits}`);
                console.log(`      older fact ${a.factIdOld}: ${oldBits}`);
                console.log(`      contradiction row ${a.contradictionId}`);
              }
            } else {
              console.log("Ambiguous pairs (manual review recommended):");
              for (const a of ambiguousList) {
                console.log(`  - ${a.factIdNew} ↔ ${a.factIdOld} (${a.contradictionId})`);
              }
            }
            if (!verbose && !details && res.ambiguous.length > 10) {
              console.log(`  ...and ${res.ambiguous.length - 10} more`);
            }
            console.log("");
            console.log(
              "What this means: each line is two stored facts with the same entity and key but different values. " +
                "Auto-resolution only runs when the newer fact is clearly stronger (newer, higher confidence, and from conversation or CLI).",
            );
            console.log("What to do:");
            console.log(
              "  1. Inspect: openclaw hybrid-mem show <fact-id>   (left/newer id first, then older id in each pair)",
            );
            console.log(
              "  2. Fix memory: if the newer statement is right, add or correct with store --supersedes <older-fact-id>; " +
                "if the older one is right, supersede or remove the newer fact (e.g. prune), then re-run this command.",
            );
            if (!details) {
              console.log("  3. Easier scan: openclaw hybrid-mem resolve-contradictions --details");
            }
            const hasProjectStatePairs = res.ambiguous.some((a) => {
              const newF = factsDb.getById(a.factIdNew);
              const oldF = factsDb.getById(a.factIdOld);
              if (!newF || !oldF) return false;
              if (newF.category !== "project" || oldF.category !== "project") return false;
              const keyLower = (newF.key ?? oldF.key ?? "").toLowerCase();
              return PROJECT_STATE_LWW_KEYS.has(keyLower);
            });
            if (hasProjectStatePairs) {
              console.log(
                "  4. Auto-resolve project-state: openclaw hybrid-mem resolve-contradictions --project-state-lww --dry-run",
              );
            }
          }
        },
      ),
    );

  mem
    .command("classify")
    .description("Reclassify uncategorized facts using LLM (auto-classify)")
    .option("--dry-run", "Show what would be reclassified without reclassifying")
    .option("--limit <n>", "Max facts to classify (default 100)", "100")
    .option("--model <m>", "LLM model (default from config)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; limit?: string; model?: string }) => {
        const dryRun = !!opts?.dryRun;
        const limit = Number.parseInt(opts?.limit ?? "100", 10);
        const model = opts?.model;
        let res;
        try {
          res = await runClassify({ dryRun, limit, model });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "classify",
          });
          throw err;
        }
        console.log(
          `Classify complete: reclassified ${res.reclassified}/${res.total} facts ${dryRun ? "(dry-run)" : ""}`,
        );
        if (res.breakdown) {
          console.log("Breakdown by category:");
          for (const [cat, count] of Object.entries(res.breakdown)) {
            console.log(`  ${cat}: ${count}`);
          }
        }
      }),
    );

  mem
    .command("build-languages")
    .description(
      "Detect top 3 languages from memory text; LLM produces intent-based natural equivalents (triggers, extraction patterns) and writes .language-keywords.json",
    )
    .option("--model <m>", "LLM model (default from autoClassify config)")
    .option("--dry-run", "Show what would be generated without writing")
    .option("-v, --verbose", "Emit periodic progress heartbeat for long runs")
    .action(
      withExit(async (opts?: { model?: string; dryRun?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const model = opts?.model ?? ctx.autoClassifyConfig.model;
        const dryRun = !!opts?.dryRun;
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        let res;
        try {
          res = await runMaintenanceHeartbeat(
            "build-languages",
            verbose,
            () => runBuildLanguageKeywords({ model, dryRun }),
            {
              progressSupplier: () => `stage=detect+generate; dryRun=${dryRun ? "yes" : "no"}`,
            },
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "build-languages",
          });
          throw err;
        }
        if (res.ok) {
          console.log(
            `Built language keywords: top languages=[${res.topLanguages.join(", ")}], added=${res.languagesAdded}, path=${res.path} ${dryRun ? "(dry-run)" : ""}`,
          );
        } else {
          console.error(`Error building language keywords: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("enrich-entities")
    .description(
      "Backfill PERSON/ORG extraction for facts missing entity mentions (franc language hint + LLM; same pipeline as store-time graph enrichment)",
    )
    .option("--limit <n>", "Max facts to process (default 200)", "200")
    .option("--model <m>", "LLM model (default: cron nano tier)")
    .option("--dry-run", "Only report how many facts need enrichment")
    .option("-v, --verbose", "List candidate fact ids (dry-run) or enriched fact ids and mentions (after run)")
    .action(
      withExit(
        async (
          opts?: { limit?: string; model?: string; dryRun?: boolean; verbose?: boolean },
          cmd?: CommanderOptsParent,
        ) => {
          const limitRaw = Number.parseInt(opts?.limit ?? "200", 10);
          if (!Number.isFinite(limitRaw) || limitRaw < 1) {
            throw new Error("--limit must be a positive integer (>= 1).");
          }
          const limit = limitRaw;
          const dryRun = !!opts?.dryRun;
          const model = opts?.model;
          const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
          let enrichProgress = { processed: 0, total: 0, factsEnriched: 0 };
          let res;
          try {
            res = await runMaintenanceHeartbeat(
              "enrich-entities",
              verbose,
              (heartbeat) =>
                runEntityEnrichment({
                  limit,
                  dryRun,
                  model,
                  verbose,
                  onProgress: (next) => {
                    enrichProgress = next;
                    heartbeat.heartbeat();
                  },
                }),
              {
                progressSupplier: () =>
                  `stage=entity-enrichment; processed=${enrichProgress.processed}/${enrichProgress.total}; enriched=${enrichProgress.factsEnriched}; dryRun=${dryRun ? "yes" : "no"}`,
              },
            );
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "enrich-entities",
            });
            throw err;
          }
          if (res.skipped) {
            console.log(
              `Entity enrichment skipped: graph.enabled is false (${res.pending} fact${res.pending === 1 ? "" : "s"} would be pending if graph were enabled).`,
            );
            return;
          }
          if (dryRun) {
            console.log(`Entity enrichment (dry-run): ${res.pending} facts pending (no API calls).`);
            if (verbose && res.pendingFactIds && res.pendingFactIds.length > 0) {
              console.log("Candidate fact ids (--verbose):");
              for (const id of res.pendingFactIds) console.log(`  ${id}`);
            }
          } else {
            console.log(
              `Entity enrichment: processed ${res.processed} facts, enriched ${res.factsEnriched} (batch had ${res.pending} candidates).`,
            );
            if (verbose && res.enrichedFacts && res.enrichedFacts.length > 0) {
              console.log("Enriched facts (--verbose):");
              for (const ef of res.enrichedFacts) {
                const parts = ef.mentions.map((m) => `${m.label}:${JSON.stringify(m.surfaceText)}`).join(", ");
                console.log(`  ${ef.factId}  ${parts}`);
              }
            }
          }
        },
      ),
    );
}
