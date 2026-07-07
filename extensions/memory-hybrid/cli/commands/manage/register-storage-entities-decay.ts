/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { vectorDimsForModel } from "../../../config.js";
import { runContextAudit } from "../../../services/context-audit.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { runMemoryDiagnostics } from "../../../services/memory-diagnostics.js";
import { filterByScope } from "../../../services/merge-results.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { runMaintenanceHeartbeat } from "./maintenance-heartbeat.js";
import { registerEntityLifecycleCommands } from "./register-lifecycle.js";
import { buildHybridSearchScopeFilter, entryMatchesHybridSearchFilters } from "./storage-stats-helpers.js";

export function registerManageStorageEntitiesDecay(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    aliasDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
    getMemoryCategories,
    cfg,
    runCompaction,
    tieringEnabled,
    ctx,
    listCommands,
    auditStore,
    runExport,
  } = b;

  const entitiesCommand = mem.command("entities").description("Inspect and clean entity labels");

  registerEntityLifecycleCommands(entitiesCommand, b);

  entitiesCommand
    .command("clean")
    .description("Null common-noun stopword entities on existing facts (dry-run by default)")
    .option("--stopwords", "Use default and configured entity stopword list")
    .option("--apply", "Apply changes; default is dry-run")
    .option("--examples <n>", "Number of example rows to show", "10")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { stopwords?: boolean; apply?: boolean; examples?: string; json?: boolean }) => {
        const exampleLimit = Number.parseInt(opts?.examples ?? "10", 10);
        if (!Number.isFinite(exampleLimit) || exampleLimit < 0) {
          console.error("error: --examples must be a non-negative integer");
          process.exitCode = 1;
          return;
        }
        const stopWords = opts?.stopwords === false ? [] : ctx.cfg.entityExtraction.stopWords;
        const report = factsDb.cleanEntityStopwords({
          apply: opts?.apply === true,
          stopWords,
          exampleLimit,
        });
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(
          `Entity stopword cleanup ${report.apply ? "applied" : "dry-run"}: matched ${report.matched}, active ${report.activeMatched}, changed ${report.changed}`,
        );
        console.log(`Stop words: ${report.stopWords.join(", ") || "(defaults only)"}`);
        if (report.examples.length > 0) {
          console.log("Examples:");
          for (const ex of report.examples) console.log(`  ${ex.id}  ${ex.entity}`);
        }
        if (!report.apply) console.log("Dry-run only. Re-run with --apply to null matched entity fields.");
      }),
    );

  mem
    .command("backfill-decay")
    .description("Backfill legacy stable decay classes (compat alias for decay reclassify --stable-only --apply)")
    .option("--json", "Emit JSON")
    .option("-v, --verbose", "Emit periodic progress heartbeat for long runs")
    .action(
      withExit(async (opts?: { json?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        const before = factsDb.statsBreakdownByDecayClass();
        let progress = { scanned: 0, total: 0, updated: 0 };
        const updated = await runMaintenanceHeartbeat(
          "backfill-decay",
          verbose,
          (heartbeat) =>
            factsDb.backfillDecay({
              reportEvery: 250,
              onProgress: (next) => {
                progress = next;
                heartbeat.heartbeat();
              },
            }),
          {
            progressSupplier: () =>
              `stage=reclassify-stable-facts; scanned=${progress.scanned}/${progress.total}; updated=${progress.updated}`,
            jsonMode: opts?.json === true,
          },
        );
        const after = factsDb.statsBreakdownByDecayClass();
        const total = Object.values(updated).reduce((a, b) => a + b, 0);
        const totalBefore = Object.values(before).reduce((sum, count) => sum + count, 0);
        const totalAfter = Object.values(after).reduce((sum, count) => sum + count, 0);
        const stablePermanentBefore = (before.stable ?? 0) + (before.permanent ?? 0);
        const stablePermanentAfter = (after.stable ?? 0) + (after.permanent ?? 0);
        const report = {
          changed: total,
          transitionsByTargetDecayClass: updated,
          before,
          after,
          stablePermanentBefore,
          stablePermanentAfter,
          stablePermanentRatioBefore: totalBefore > 0 ? stablePermanentBefore / totalBefore : 0,
          stablePermanentRatioAfter: totalAfter > 0 ? stablePermanentAfter / totalAfter : 0,
        };
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`Backfilled decay classes and expires_at for ${total} facts.`);
        console.log(
          `Stable+permanent before: ${stablePermanentBefore} (${(report.stablePermanentRatioBefore * 100).toFixed(1)}%)`,
        );
        console.log(
          `Stable+permanent after: ${stablePermanentAfter} (${(report.stablePermanentRatioAfter * 100).toFixed(1)}%)`,
        );
        if (Object.keys(updated).length > 0) {
          console.log("Reclassifications:");
          for (const [decayClass, count] of Object.entries(updated)) {
            console.log(`  stable->${decayClass}: ${count}`);
          }
        }
      }),
    );

  const decayCommand = mem.command("decay").description("Inspect and repair decay-class TTL hygiene");

  decayCommand
    .command("reclassify")
    .description(
      "Reclassify decay classes using source/category/importance and recall/access signals (dry-run by default)",
    )
    .option("--apply", "Apply changes; default is dry-run")
    .option("--stable-only", "Only scan active facts currently marked stable")
    .option("--limit <n>", "Maximum facts to scan")
    .option("--inactive-days <n>", "Demote unrecalled/unaccessed facts older than N days to short", "90")
    .option("--promote-recall-count <n>", "Promote TTL-bearing facts recalled/accessed at least N times", "3")
    .option("--json", "Emit JSON")
    .action(
      withExit(
        async (opts?: {
          apply?: boolean;
          stableOnly?: boolean;
          limit?: string;
          inactiveDays?: string;
          promoteRecallCount?: string;
          json?: boolean;
        }) => {
          const limit = opts?.limit != null ? Number.parseInt(opts.limit, 10) : undefined;
          const inactiveDays = Number.parseInt(opts?.inactiveDays ?? "90", 10);
          const promoteRecallCount = Number.parseInt(opts?.promoteRecallCount ?? "3", 10);
          if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
            console.error("error: --limit must be a positive integer");
            process.exitCode = 1;
            return;
          }
          if (!Number.isFinite(inactiveDays) || inactiveDays < 1) {
            console.error("error: --inactive-days must be a positive integer");
            process.exitCode = 1;
            return;
          }
          if (!Number.isFinite(promoteRecallCount) || promoteRecallCount < 1) {
            console.error("error: --promote-recall-count must be a positive integer");
            process.exitCode = 1;
            return;
          }
          const report = factsDb.reclassifyDecayClasses({
            apply: opts?.apply === true,
            stableOnly: opts?.stableOnly === true,
            limit,
            inactiveDays,
            promoteRecallCount,
          });
          if (opts?.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
          console.log(
            `Decay reclassify ${report.apply ? "applied" : "dry-run"}: scanned ${report.scanned}, changed ${report.changed}`,
          );
          console.log(
            `Stable+permanent before: ${report.stablePermanentBefore} (${pct(report.stablePermanentRatioBefore)})`,
          );
          console.log(
            `Stable+permanent after: ${report.stablePermanentAfter} (${pct(report.stablePermanentRatioAfter)})`,
          );
          if (Object.keys(report.changes).length > 0) {
            console.log("Transitions:");
            for (const [transition, count] of Object.entries(report.changes)) console.log(`  ${transition}: ${count}`);
          }
          if (!report.apply) console.log("Dry-run only. Re-run with --apply to update decay_class/expires_at.");
        },
      ),
    );

  mem
    .command("test")
    .description("Run memory diagnostics (structured + semantic + hybrid + auto-recall)")
    .action(
      withExit(async () => {
        const result = await runMemoryDiagnostics({
          factsDb,
          vectorDb,
          embeddings,
          aliasDb,
          minScore: cfg.autoRecall?.minScore ?? 0.3,
          autoRecallLimit: cfg.autoRecall?.limit ?? 10,
        });

        const icon = (ok: boolean) => (ok ? "✅" : "❌");
        console.log("=== Memory Diagnostics ===");
        console.log(`Marker: ${result.markerId}`);
        console.log(`Structured search: ${icon(result.structured.ok)} (${result.structured.count} result(s))`);
        console.log(`Semantic search: ${icon(result.semantic.ok)} (${result.semantic.count} result(s))`);
        console.log(`Hybrid search: ${icon(result.hybrid.ok)} (${result.hybrid.count} result(s))`);
        console.log(`Auto-recall: ${icon(result.autoRecall.ok)} (${result.autoRecall.count} candidate(s))`);
      }),
    );

  mem
    .command("model-info [model]")
    .description(
      "Show vector dimensions for a built-in embedding model name, or print current embedding config when [model] is omitted",
    )
    .action(
      withExit(async (modelArg?: string) => {
        const name = typeof modelArg === "string" ? modelArg.trim() : "";
        if (!name) {
          const emb = cfg.embedding;
          console.log("=== Current embedding config ===");
          console.log(`Provider: ${emb.provider}`);
          console.log(`Model: ${emb.model}`);
          if (emb.models && emb.models.length > 0) {
            console.log(`Models (multi): ${emb.models.join(", ")}`);
          }
          console.log(`Dimensions (resolved in config): ${emb.dimensions}`);
          try {
            const catalog = vectorDimsForModel(emb.model);
            if (catalog === emb.dimensions) {
              console.log(`Catalog dimensions for '${emb.model}': ${catalog} (matches config)`);
            } else {
              console.log(
                `Catalog dimensions for '${emb.model}': ${catalog} (config uses ${emb.dimensions} — may be intentional)`,
              );
            }
          } catch {
            console.log(
              `Model '${emb.model}' is not in the built-in catalog; dimensions are taken from config (${emb.dimensions}).`,
            );
            console.log(
              "For custom Ollama/ONNX models, set embedding.dimensions to the vector size your model outputs.",
            );
          }
          return;
        }
        try {
          const dims = vectorDimsForModel(name);
          console.log(`Model: ${name}`);
          console.log(`Vector dimensions: ${dims}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`error: ${msg}`);
          console.error(
            "For models not in the catalog, set embedding.dimensions in plugin config to the vector size your provider returns.",
          );
          process.exitCode = 1;
          return;
        }
      }),
    );

  mem
    .command("context-audit")
    .description("Report token usage per injected context source and recommendations")
    .action(
      withExit(async () => {
        const audit = await runContextAudit({ cfg, factsDb });

        console.log("=== Context Budget Audit ===");
        console.log(
          `Auto-recall: ${audit.autoRecall.enabled ? `${audit.autoRecall.budgetTokens} token budget` : "disabled"} (format: ${audit.autoRecall.injectionFormat}, hot: ${audit.autoRecall.hotTokens})`,
        );
        if (audit.autoRecall.enabled) {
          console.log(
            `  fixed caps: hot=${audit.autoRecall.fixedBlocks.caps.hotMaxTokens}, narrative=${audit.autoRecall.fixedBlocks.caps.narrativeMaxTokens}, procedures=${audit.autoRecall.fixedBlocks.caps.procedureMaxTokens}, active-task=${audit.autoRecall.fixedBlocks.caps.activeTaskMaxTokens}, stale-warning=${audit.autoRecall.fixedBlocks.caps.staleWarningMaxTokens}`,
          );
          console.log(
            `  fixed estimate: ${audit.autoRecall.fixedBlocks.estimatedTokens.total} tokens, recall headroom: ${audit.autoRecall.fixedBlocks.estimatedTokens.remainingForRecall}${audit.autoRecall.fixedBlocks.estimatedTokens.wouldExhaustRecall ? " (exhausted)" : ""}`,
          );
        }
        console.log(
          `Procedures: ${audit.procedures.enabled ? `${audit.procedures.tokens} tokens` : "disabled"} (lines: ${audit.procedures.lines})`,
        );
        if (audit.activeTasks.enabled) {
          console.log(
            `Active tasks: ${audit.activeTasks.tokens} tokens injected (budget: ${audit.activeTasks.injectionBudget})`,
          );
          console.log(
            `  ledger active: ${audit.activeTasks.ledgerActiveCount}, after projection/filter: ${audit.activeTasks.filteredActiveCount}, in <active-tasks>: ${audit.activeTasks.injectedTaskCount}, stale in ledger: ${audit.activeTasks.stale}`,
          );
        } else {
          console.log("Active tasks: disabled");
        }
        console.log(`Workspace files: ${audit.workspaceFiles.totalTokens} tokens`);
        if (audit.workspaceFiles.files.length > 0) {
          for (const file of audit.workspaceFiles.files) {
            console.log(`  - ${file.file}: ${file.tokens} tokens`);
          }
        }
        console.log(`Total injected (est.): ${audit.totalTokens} tokens`);

        if (audit.recommendations.length > 0) {
          console.log("Recommendations:");
          for (const rec of audit.recommendations) {
            console.log(`  - ${rec}`);
          }
        } else {
          console.log("Recommendations: none — context budget is healthy.");
        }
      }),
    );

  mem
    .command("search <query>")
    .description(
      "Hybrid search (vector + SQL). Returns up to 20 results. Optional filters apply to the merged result set.",
    )
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .option("--scope <s>", "Filter by scope (global/user/agent/session)")
    .option("--scope-target <st>", "Scope target (userId/agentId/sessionId)")
    .action(
      withExit(
        async (
          query: string,
          opts?: {
            category?: string;
            entity?: string;
            key?: string;
            source?: string;
            tier?: string;
            scope?: string;
            scopeTarget?: string;
          },
        ) => {
          try {
            const scopeFilter = buildHybridSearchScopeFilter(opts?.scope, opts?.scopeTarget);

            const embedding = await embeddings.embed(query);
            const vectorResults = await vectorDb.search(embedding, 50);
            const sqlResults = factsDb.search(query, 50, {
              scopeFilter,
              tierFilter: opts?.tier === "cold" ? "all" : "warm",
              reinforcementBoost: cfg.distill?.reinforcementBoost ?? 0.1,
              diversityWeight: cfg.reinforcement?.diversityWeight ?? 1.0,
            });

            // Filter vector results by scope
            let filteredVectorResults = vectorResults;
            if (scopeFilter) {
              filteredVectorResults = filterByScope(
                vectorResults,
                (id, opts) => factsDb.getById(id, opts),
                scopeFilter,
              );
            }

            let combined = merge(filteredVectorResults, sqlResults, 20, factsDb);

            if (opts?.category || opts?.entity || opts?.key || opts?.source || opts?.tier) {
              combined = combined.filter((r) => entryMatchesHybridSearchFilters(r.entry, opts));
            }

            if (tieringEnabled && opts?.tier == null) {
              combined = combined.filter((r) => r.entry.tier !== "cold");
            }

            console.log(`Search results for "${query}": ${combined.length}`);
            for (const r of combined) {
              console.log(
                `  [${r.entry.id}] ${r.entry.text} (score=${r.score.toFixed(3)}, tier=${r.entry.tier}, category=${r.entry.category ?? "none"})`,
              );
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "search",
            });
            throw err;
          }
        },
      ),
    );

  mem
    .command("lookup <id>")
    .description("Lookup a fact by ID")
    .action(
      withExit(async (id: string) => {
        try {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            return;
          }
          console.log(JSON.stringify(fact, null, 2));
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "lookup",
          });
          throw err;
        }
      }),
    );

  mem
    .command("forget <id>")
    .description("Remove a memory by ID (from SQLite and LanceDB). ID can be full UUID or a short hex prefix.")
    .option("--yes", "Skip confirmation")
    .action(
      withExit(async (id: string, opts?: { yes?: boolean }) => {
        try {
          let resolvedId = id;
          if (id.length < 36 && !id.includes("-")) {
            const prefixResult = factsDb.findByIdPrefix(id);
            if (prefixResult && "ambiguous" in prefixResult) {
              const countText = prefixResult.count >= 3 ? `${prefixResult.count}+` : `${prefixResult.count}`;
              console.error(
                `Prefix "${id}" is ambiguous (matches ${countText} facts). Use the full UUID from search or lookup.`,
              );
              process.exitCode = 1;
              return;
            }
            if (prefixResult && "id" in prefixResult) {
              resolvedId = prefixResult.id;
            }
          }
          const fact = factsDb.get(resolvedId);
          if (!opts?.yes) {
            if (fact) {
              console.log(`About to remove: ${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}`);
            } else {
              console.log(`Memory not found in SQLite (may still exist in LanceDB): ${resolvedId}`);
            }
            console.log("Run with --yes to confirm, or cancel (Ctrl+C).");
            return;
          }
          const sqlDeleted = factsDb.delete(resolvedId);
          let lanceDeleted = false;
          try {
            lanceDeleted = await vectorDb.delete(resolvedId);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "forget",
            });
            console.error(`LanceDB delete failed: ${err}`);
          }
          aliasDb?.deleteByFactId(resolvedId);
          if (!sqlDeleted && !lanceDeleted) {
            console.error(`Memory not found: ${id}`);
            process.exitCode = 1;
            return;
          }
          const note = resolvedId !== id ? ` (resolved from prefix "${id}")` : "";
          console.log(`Forgotten${note}. SQLite: ${sqlDeleted}, LanceDB: ${lanceDeleted}`);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "forget",
          });
          throw err;
        }
      }),
    );
}
