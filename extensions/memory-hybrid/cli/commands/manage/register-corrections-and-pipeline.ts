/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { getCronModelConfig, getDefaultCronModel } from "../../../config.js";
import { getEffectivenessReport, runClosedLoopAnalysis } from "../../../services/feedback-effectiveness.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { type Chainable, withExit } from "../../shared.js";
import type {
  AnalyzeFeedbackPhrasesResult,
  FindDuplicatesResult,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
} from "../../types.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageCorrectionsAndPipeline(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    cfg,
    listCommands,
    runFindDuplicates,
    runConsolidate,
    runReflection,
    reflectionConfig,
    runReflectionRules,
    runReflectionMeta,
    runReflectIdentity,
    runClassify,
    runEntityEnrichment,
    runSelfCorrectionExtract,
    runSelfCorrectionRun,
    runDreamCycle,
    runContinuousVerification,
    runExtractImplicitFeedback,
    runCrossAgentLearning,
    runToolEffectiveness,
    pruneCostLog,
    runCostReport,
    runAnalyzeFeedbackPhrases,
    ctx,
    runStore,
    runConfigView,
    runConfigMode,
    runConfigSet,
    runConfigSetHelp,
    runBackfill,
    runIngestFiles,
    runExport,
    runBuildLanguageKeywords,
  } = b;

  const corrections = mem.command("corrections").description("Manage self-correction reports");
  corrections
    .command("list")
    .description("List pending corrections (from latest self-correction run)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        if (!listCommands?.listCorrections) {
          console.log("Corrections feature not available.");
          return;
        }
        const { reportPath, items } = await listCommands.listCorrections({ workspace: opts?.workspace });
        if (!reportPath) {
          console.log("No corrections report found.");
          return;
        }
        console.log(`Corrections report: ${reportPath}`);
        console.log(`Pending items (${items.length}):`);
        for (const item of items) {
          console.log(`  - ${item}`);
        }
      }),
    );
  corrections
    .command("approve-all")
    .description("Approve all pending corrections (auto-fix memory + TOOLS.md)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        if (!listCommands?.correctionsApproveAll) {
          console.log("Corrections feature not available.");
          return;
        }
        const { applied, error } = await listCommands.correctionsApproveAll({ workspace: opts?.workspace });
        if (error) {
          console.error(`Error applying corrections: ${error}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Applied ${applied} corrections.`);
      }),
    );

  mem
    .command("review")
    .description("Start interactive review of pending proposals + corrections")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        console.log("=== Interactive Review (proposals + corrections) ===");
        if (!listCommands) {
          console.log("Review feature not available (personaProposals disabled or no workspace).");
          return;
        }
        const proposals = listCommands.listProposals ? await listCommands.listProposals({ status: "pending" }) : [];
        const { reportPath, items: corrections } = listCommands.listCorrections
          ? await listCommands.listCorrections({ workspace: opts?.workspace })
          : { reportPath: null, items: [] };

        console.log(`Pending proposals: ${proposals.length}`);
        console.log(`Pending corrections: ${corrections.length}`);
        console.log("");
        console.log("To approve/reject proposals: hybrid-mem proposals approve <id> | reject <id>");
        console.log("To approve all corrections: hybrid-mem corrections approve-all");
        console.log("");
        console.log("Proposals:");
        for (const p of proposals) {
          console.log(`  [${p.id}] ${p.title} (target=${p.targetFile}, confidence=${p.confidence.toFixed(2)})`);
        }
        console.log("");
        if (reportPath) {
          console.log(`Corrections report: ${reportPath}`);
          for (const item of corrections) {
            console.log(`  - ${item}`);
          }
        } else {
          console.log("No corrections report found.");
        }
      }),
    );

  mem
    .command("store <text>")
    .description("Store a fact (with optional category, entity, key-value, sourceDate, tags, supersedes, scope)")
    .option("--category <cat>", "Category")
    .option("--entity <ent>", "Entity")
    .option("--key <k>", "Key")
    .option("--value <v>", "Value")
    .option("--source-date <d>", "Source date (ISO or timestamp)")
    .option("--tags <t>", "Tags (comma-separated)")
    .option("--supersedes <id>", "Fact ID this store supersedes (replaces)")
    .option("--scope <s>", "Memory scope (global, user, agent, session). Default global.")
    .option(
      "--scope-target <st>",
      "Scope target (userId, agentId, sessionId). Required when scope is user/agent/session.",
    )
    .action(
      withExit(
        async (
          text: string,
          opts?: {
            category?: string;
            entity?: string;
            key?: string;
            value?: string;
            sourceDate?: string;
            tags?: string;
            supersedes?: string;
            scope?: "global" | "user" | "agent" | "session";
            scopeTarget?: string;
          },
        ) => {
          let res;
          try {
            res = await runStore({
              text,
              category: opts?.category,
              entity: opts?.entity,
              key: opts?.key,
              value: opts?.value,
              sourceDate: opts?.sourceDate,
              tags: opts?.tags,
              supersedes: opts?.supersedes,
              scope: opts?.scope,
              scopeTarget: opts?.scopeTarget,
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "store",
            });
            throw err;
          }
          if (res.outcome === "duplicate") {
            console.log("Duplicate fact (skipped).");
          } else if (res.outcome === "credential") {
            console.log(`Credential stored: ${res.service} (${res.type}), id=${res.id}`);
          } else if (res.outcome === "credential_skipped_duplicate") {
            console.log(`Credential already in vault (skipped): ${res.service} (${res.type})`);
          } else if (res.outcome === "credential_parse_error") {
            console.log("Credential parse error (skipped).");
          } else if (res.outcome === "credential_vault_error") {
            console.log("Credential vault error — could not write to secure vault (skipped).");
          } else if (res.outcome === "credential_db_error") {
            console.log("Credential pointer error — vault entry written but pointer storage failed (skipped).");
          } else if (res.outcome === "noop") {
            console.log(`No-op: ${res.reason}`);
          } else if (res.outcome === "retracted") {
            console.log(`Retracted fact ${res.targetId}: ${res.reason}`);
          } else if (res.outcome === "updated") {
            console.log(`Updated fact ${res.id} (superseded ${res.supersededId}): ${res.reason}`);
          } else if (res.outcome === "stored") {
            console.log(
              `Stored: ${res.textPreview} (id=${res.id}${res.supersededId ? `, superseded ${res.supersededId}` : ""})`,
            );
          }
        },
      ),
    );

  mem
    .command("config")
    .description("Show current configuration and feature toggles (use config-set to change)")
    .action(
      withExit(async () => {
        try {
          runConfigView({ log: (s: string) => console.log(s), error: (s: string) => console.error(s) });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config",
          });
          throw err;
        }
      }),
    );

  mem
    .command("config-mode <mode>")
    .description("Set memory mode (local, minimal, enhanced, complete). Writes memory/.config if needed.")
    .action(
      withExit(async (mode: string) => {
        let res;
        try {
          res = await runConfigMode(mode);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config-mode",
          });
          throw err;
        }
        if (res.ok) {
          console.log(res.message);
        } else {
          console.error(`Error: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("config-set <key> <value>")
    .description(
      'Set a config key in memory/.config. Toggles: config-set <feature> enabled|disabled (e.g. nightlyCycle, extraction). Other keys: errorReporting.botName "MyBot". For help: hybrid-mem help config-set <key>',
    )
    .action(
      withExit(async (key: string, value: string) => {
        let res;
        try {
          res = await runConfigSet(key, value);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config-set",
          });
          throw err;
        }
        if (res.ok) {
          console.log(res.message);
        } else {
          console.error(`Error: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("help config-set <key>")
    .description("Show help for a config key")
    .action(
      withExit(async (key: string) => {
        let res;
        try {
          res = await runConfigSetHelp(key);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config-set-help",
          });
          throw err;
        }
        if (res.ok) {
          console.log(res.message);
        } else {
          console.error(`Error: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

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
          const model = opts?.model ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "default");
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

  mem
    .command("reflect")
    .description("Run reflection: analyze recent facts, extract patterns, store in memory")
    .option("--window <n>", "Days to look back (default from config)", reflectionConfig.defaultWindow.toString())
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each pattern as it is extracted")
    .action(
      withExit(async (opts?: { window?: string; dryRun?: boolean; model?: string; verbose?: boolean }) => {
        const window = opts?.window ? Number.parseInt(opts.window, 10) : reflectionConfig.defaultWindow;
        const dryRun = !!opts?.dryRun;
        const model = opts?.model ?? reflectionConfig.model;
        const verbose = !!opts?.verbose;
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
      }),
    );

  mem
    .command("reflect-rules")
    .description("Run reflection (rules): extract high-level rules from patterns")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each rule as it is extracted")
    .action(
      withExit(async (opts?: { dryRun?: boolean; model?: string; verbose?: boolean }) => {
        const dryRun = !!opts?.dryRun;
        const model = opts?.model ?? reflectionConfig.model;
        const verbose = !!opts?.verbose;
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
    .option("--verbose", "Log each meta-pattern as it is extracted")
    .action(
      withExit(async (opts?: { dryRun?: boolean; model?: string; verbose?: boolean }) => {
        const dryRun = !!opts?.dryRun;
        const model = opts?.model ?? reflectionConfig.model;
        const verbose = !!opts?.verbose;
        let res;
        try {
          res = await runReflectionMeta({ dryRun, model, verbose });
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
      }),
    );

  if (runReflectIdentity) {
    mem
      .command("reflect-identity")
      .description("Run identity reflection: synthesize persona-level insights from reflection outputs")
      .option("--window <n>", "Days to look back (default from config)", reflectionConfig.defaultWindow.toString())
      .option("--dry-run", "Show what would be stored without storing")
      .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
      .option("--verbose", "Log each identity insight as it is stored")
      .action(
        withExit(async (opts?: { window?: string; dryRun?: boolean; model?: string; verbose?: boolean }) => {
          const window = opts?.window ? Number.parseInt(opts.window, 10) : reflectionConfig.defaultWindow;
          const dryRun = !!opts?.dryRun;
          const model = opts?.model ?? reflectionConfig.model;
          const verbose = !!opts?.verbose;
          const res = await runReflectIdentity({ dryRun, model, verbose, window });
          console.log(
            `Identity reflection complete: extracted ${res.insightsExtracted} insights, stored ${res.insightsStored} ${dryRun ? "(dry-run)" : ""}`,
          );
        }),
      );
  }

  if (runDreamCycle) {
    mem
      .command("dream-cycle")
      .description(
        "Run nightly dream cycle: prune expired/decayed facts, consolidate old episodic events, reflect to extract patterns, optionally extract rules",
      )
      .action(
        withExit(async () => {
          let res;
          try {
            res = await runDreamCycle();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "dream-cycle",
            });
            throw err;
          }
          if (res.skipped) {
            console.log("Dream cycle skipped (nightlyCycle.enabled = false in config).");
          } else {
            console.log(`Dream cycle complete: ${res.digestSummary}`);
            console.log(`  Facts pruned: ${res.factsPruned}`);
            console.log(`  Facts decayed: ${res.factsDecayed}`);
            console.log(`  Events consolidated: ${res.eventsConsolidated} → ${res.factsCreated} facts`);
            console.log(`  Patterns found: ${res.patternsFound}`);
            console.log(`  Rules generated: ${res.rulesGenerated}`);
          }

          if (
            !res.skipped &&
            runContinuousVerification &&
            cfg.verification.enabled &&
            cfg.verification.continuousVerification
          ) {
            let verificationRes;
            try {
              verificationRes = await runContinuousVerification();
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
          }

          // Extract implicit feedback signals as part of nightly cycle
          if (!res.skipped && runExtractImplicitFeedback && cfg.implicitFeedback?.enabled !== false) {
            try {
              const implRes = await runExtractImplicitFeedback({ days: 3, dryRun: false, includeClosedLoop: false });
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
              const clReport = runClosedLoopAnalysis(factsDb, cfg.closedLoop ?? { enabled: true });
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
              const caRes = await runCrossAgentLearning();
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
              const teOutput = await runToolEffectiveness({});
              if (teOutput && !teOutput.startsWith("No tool")) {
                console.log(`Tool effectiveness: ${teOutput.split("\n")[0]}`);
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:tool-effectiveness",
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
              const pruned = pruneCostLog(cfg.costTracking?.retainDays);
              if (pruned > 0) console.log(`Cost log: pruned ${pruned} old entries.`);
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:cost-log-prune",
              });
            }
          }
        }),
      );
  }

  mem
    .command("resolve-contradictions")
    .description("Resolve unresolved contradictions (auto-resolve obvious cases, report ambiguous pairs)")
    .action(
      withExit(async () => {
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
        if (res.ambiguous.length > 0) {
          console.log("Ambiguous pairs (manual review recommended):");
          for (const a of res.ambiguous.slice(0, 10)) {
            console.log(`  - ${a.factIdNew} ↔ ${a.factIdOld} (${a.contradictionId})`);
          }
          if (res.ambiguous.length > 10) {
            console.log(`  ...and ${res.ambiguous.length - 10} more`);
          }
        }
      }),
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
    .action(
      withExit(async (opts?: { model?: string; dryRun?: boolean }) => {
        const model = opts?.model ?? ctx.autoClassifyConfig.model;
        const dryRun = !!opts?.dryRun;
        let res;
        try {
          res = await runBuildLanguageKeywords({ model, dryRun });
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
    .action(
      withExit(async (opts?: { limit?: string; model?: string; dryRun?: boolean }) => {
        const limitRaw = Number.parseInt(opts?.limit ?? "200", 10);
        if (!Number.isFinite(limitRaw) || limitRaw < 1) {
          throw new Error("--limit must be a positive integer (>= 1).");
        }
        const limit = limitRaw;
        const dryRun = !!opts?.dryRun;
        const model = opts?.model;
        let res;
        try {
          res = await runEntityEnrichment({ limit, dryRun, model });
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
        } else {
          console.log(
            `Entity enrichment: processed ${res.processed} facts, enriched ${res.factsEnriched} (batch had ${res.pending} candidates).`,
          );
        }
      }),
    );

  mem
    .command("self-correction-extract")
    .description(
      "Extract self-correction incidents from session JSONL using multi-language correction signals from .language-keywords.json",
    )
    .option("--days <n>", "Days to look back (default 7)", "7")
    .option("--output <path>", "Output path for incidents JSON (default: memory/.self-correction-incidents.json)")
    .action(
      withExit(async (opts?: { days?: string; output?: string }) => {
        const days = opts?.days ? Number.parseInt(opts.days, 10) : 7;
        const outputPath = opts?.output;
        let res;
        try {
          res = await runSelfCorrectionExtract({ days, outputPath });
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
      }),
    );

  mem
    .command("self-correction-run")
    .description("Analyze extracted incidents and auto-remediate (memory store, TOOLS.md); report to memory/reports")
    .option("--extract-path <path>", "Path to incidents JSON (default: memory/.self-correction-incidents.json)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .option("--dry-run", "Show what would be applied without applying")
    .option("--model <m>", "LLM model (default from autoClassify config)")
    .option("--approve", "Auto-approve all corrections (skip review)")
    .option("--no-apply-tools", "Skip TOOLS.md updates (memory-only)")
    .option("--full", "Force full re-scan (bypass 23-hour startup guard)")
    .action(
      withExit(
        async (opts?: {
          extractPath?: string;
          workspace?: string;
          dryRun?: boolean;
          model?: string;
          approve?: boolean;
          applyTools?: boolean;
          full?: boolean;
        }) => {
          const extractPath = opts?.extractPath;
          const workspace = opts?.workspace;
          const dryRun = !!opts?.dryRun;
          const model = opts?.model ?? ctx.autoClassifyConfig.model;
          const approve = !!opts?.approve;
          const full = !!opts?.full;
          let res;
          try {
            res = await runSelfCorrectionRun({
              extractPath,
              workspace,
              dryRun,
              model,
              approve,
              applyTools: opts?.applyTools,
              full,
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "self-correction-run",
            });
            throw err;
          }
          if (res.error) {
            console.error(`Error: ${res.error}`);
            process.exitCode = 1;
            return;
          }
          console.log(
            `Self-correction run complete: ${res.incidentsFound} incidents found, ${res.analysed} analysed, ${res.autoFixed} auto-fixed ${dryRun ? "(dry-run)" : ""}`,
          );
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
    );

  if (runExtractImplicitFeedback) {
    mem
      .command("extract-implicit")
      .description(
        "Extract implicit feedback signals from session transcripts and route to reinforcement/self-correction pipelines",
      )
      .option("--days <n>", "Days to look back (default 3)", "3")
      .option("--dry-run", "Show what would be stored without storing")
      .option("--verbose", "Show detailed signal output per session")
      .option("--no-trajectories", "Skip trajectory building")
      .option("--no-closed-loop", "Skip closed-loop analysis")
      .action(
        withExit(
          async (opts?: {
            days?: string;
            dryRun?: boolean;
            verbose?: boolean;
            trajectories?: boolean;
            closedLoop?: boolean;
          }) => {
            const days = opts?.days ? Number.parseInt(opts.days, 10) : 3;
            const dryRun = !!opts?.dryRun;
            const verbose = !!opts?.verbose;
            const includeTrajectories = opts?.trajectories !== false;
            const includeClosedLoop = opts?.closedLoop !== false;
            let res;
            try {
              res = await runExtractImplicitFeedback({ days, dryRun, verbose, includeTrajectories, includeClosedLoop });
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
            console.log(`  Positive signals: ${res.positiveCount}`);
            console.log(`  Negative signals: ${res.negativeCount}`);
            console.log(`  Trajectories built: ${res.trajectoriesBuilt}`);
            if (res.closedLoopReport) {
              console.log(`\n${res.closedLoopReport}`);
            }
          },
        ),
      );
  }

  // ----- cross-agent-learning (Issue #263 — Phase 2) -----
  mem
    .command("cross-agent-learning")
    .description("Generalise agent-scoped lessons into global patterns (Issue #263 — Phase 2)")
    .action(
      withExit(async () => {
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
          res = await runCrossAgentLearning();
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
        console.log(`  Links created: ${res.linksCreated}`);
        console.log(`  Skipped duplicates: ${res.skippedDuplicates}`);
        if (res.errors > 0) console.log(`  Errors: ${res.errors}`);
      }),
    );

  // ----- cost-report (Issue #270) -----
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

  // ----- tool-effectiveness (Issue #263 — Phase 3) -----
  mem
    .command("tool-effectiveness")
    .description("Compute and display tool effectiveness scores from workflow traces (Issue #263 — Phase 3)")
    .option("--verbose", "Show detailed per-tool breakdown")
    .action(
      withExit(async (opts?: { verbose?: boolean }) => {
        if (!runToolEffectiveness) {
          console.error("tool-effectiveness is not available in this context.");
          process.exitCode = 1;
          return;
        }
        let output: string;
        try {
          output = await runToolEffectiveness({ verbose: !!opts?.verbose });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "tool-effectiveness",
          });
          throw err;
        }
        console.log(output);
      }),
    );

  mem
    .command("analyze-feedback-phrases")
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
      withExit(async (opts?: { days?: string; model?: string; output?: string; learn?: boolean }) => {
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
          res.reinforcement.slice(0, 15).forEach((p) => console.log(`  + ${p}`));
          if (res.reinforcement.length > 15) console.log(`  ... and ${res.reinforcement.length - 15} more`);
        }
        console.log(`Correction phrases: ${res.correction.length}`);
        if (res.correction.length > 0) {
          res.correction.slice(0, 15).forEach((p) => console.log(`  - ${p}`));
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
      }),
    );
}
