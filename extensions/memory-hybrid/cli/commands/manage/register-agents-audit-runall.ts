/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mergeAgentHealthDashboard } from "../../../backends/agent-health-store.js";
import { collectForgeState } from "../../../routes/dashboard-server.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { countActivePatternFactsForMaintenance } from "../../../services/reflection.js";
import { deleteVectorsForFactIds } from "../../../services/vector-maintenance.js";
import { getLanguageKeywordsFilePath } from "../../../utils/language-keywords.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { registerScanMaintenanceOverrideOptions, scanMaintenanceOverridePayload } from "../../maintenance-overrides.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageAgentsAuditRunall(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    auditStore,
    agentHealthStore,
    resolvedSqlitePath,
    BACKFILL_DECAY_MARKER,
    runCompaction,
    runDistill,
    runExtractDaily,
    runExtractDirectives,
    runExtractReinforcement,
    runExtractImplicitFeedback,
    runExtractProcedures,
    runGenerateAutoSkills,
    runReflection,
    reflectionConfig,
    runReflectionRules,
    runReflectionMeta,
    runReflectIdentity,
    runGenerateProposals,
    runSelfCorrectionRun,
    runBuildLanguageKeywords,
    requireWalFlushBeforeMutation,
  } = b;

  const agentsCmd = mem.command("agents").description("Multi-agent health (Issue #789)");
  agentsCmd
    .command("health")
    .description("Show per-agent health (SQLite + Forge live state)")
    .option("--agent <id>", "Filter to a single agent id")
    .action(
      withExit(async (opts?: { agent?: string }) => {
        if (!agentHealthStore) {
          console.error("Agent health store is not available.");
          process.exitCode = 1;
          return;
        }
        const forge = await collectForgeState();
        const views = mergeAgentHealthDashboard(forge, agentHealthStore.listAll());
        const filter = opts?.agent?.trim().toLowerCase();
        let any = false;
        for (const v of views) {
          if (filter && v.agentId !== filter) continue;
          any = true;
          console.log(
            `${v.agentId}\t${v.status}\tscore=${v.score.toFixed(1)}\tlast=${new Date(v.lastSeen).toISOString()}\t${v.lastTask.slice(0, 120)}`,
          );
        }
        if (!any) {
          console.log("(no rows)");
        }
      }),
    );
  agentsCmd
    .command("activity")
    .description("Recent audit events for an agent (requires audit log)")
    .requiredOption("--agent <id>", "Agent id")
    .option("--hours <n>", "Lookback hours", "24")
    .action(
      withExit(async (opts?: { agent?: string; hours?: string }) => {
        if (!auditStore) {
          console.error("Audit store is not available.");
          process.exitCode = 1;
          return;
        }
        const agent = opts?.agent?.trim();
        if (!agent) {
          console.error("--agent is required.");
          process.exitCode = 1;
          return;
        }
        const hours = Math.max(1, Math.min(720, Number.parseInt(String(opts?.hours ?? "24"), 10) || 24));
        const sinceMs = Date.now() - hours * 3600 * 1000;
        const rows = auditStore.query({ sinceMs, agentId: agent, limit: 200 });
        for (const r of rows) {
          const ts = new Date(r.timestamp).toISOString();
          console.log(`${ts}\t${r.action}\t${r.outcome}\t${r.target ?? ""}`);
        }
        if (rows.length === 0) {
          console.log("(no events)");
        }
      }),
    );

  registerScanMaintenanceOverrideOptions(
    mem
      .command("run-all")
      .description(
        "Run all maintenance tasks in optimal order (prune, compact, distill, extract-*, reflection, generate-proposals, self-correction, build-languages). Use --dry-run to list steps only.",
      )
      .option("--dry-run", "List steps that would run without executing")
      .option("-v, --verbose", "Show detailed output for each step"),
  ).action(
    withExit(
      async (
        opts?: { dryRun?: boolean; verbose?: boolean; force?: boolean; full?: boolean },
        cmd?: CommanderOptsParent,
      ) => {
        const dryRun = !!opts?.dryRun;
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        const scanOverrides = scanMaintenanceOverridePayload(opts);
        const log = (s: string) => console.log(s);
        const sink = { log, warn: (s: string) => console.warn(s) };
        const memoryDir = resolvedSqlitePath ? dirname(resolvedSqlitePath) : null;
        const backfillDonePath = memoryDir ? join(memoryDir, BACKFILL_DECAY_MARKER) : null;

        let patternsStoredThisRun = 0;

        const steps: { name: string; run: () => Promise<void> }[] = [
          {
            name: "backfill-decay",
            run: async () => {
              if (backfillDonePath && existsSync(backfillDonePath)) {
                if (verbose) log("Backfill-decay already done; skipping.");
                return;
              }
              const n = factsDb.backfillDecay();
              const total = Object.values(n).reduce((a, b) => a + b, 0);
              log(`Backfilled decay for ${total} facts.`);
              if (backfillDonePath) {
                try {
                  writeFileSync(backfillDonePath, `${new Date().toISOString()}\n`);
                } catch (err) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    subsystem: "cli",
                    operation: "run-all:backfill-decay-marker",
                  });
                }
              }
            },
          },
          {
            name: "prune",
            run: async () => {
              const pendingVectorDeletes = factsDb.listExpiredFactIdsPendingPrune();
              const n = factsDb.prune();
              const vectorCleanup = await deleteVectorsForFactIds(vectorDb, pendingVectorDeletes, {
                operation: "run-all-prune-expired",
              });
              log(
                `Pruned ${n} expired facts (vector cleanup: ${vectorCleanup.deleted}/${vectorCleanup.attempted}${vectorCleanup.failed > 0 ? `, failed=${vectorCleanup.failed}` : ""}).`,
              );
            },
          },
          {
            name: "compact",
            run: async () => {
              const c = await runCompaction();
              log(`Compaction: hot=${c.hot} warm=${c.warm} cold=${c.cold}`);
            },
          },
          ...(runDistill
            ? [
                {
                  name: "distill (3 days)",
                  run: async () => {
                    const r = await runDistill({ dryRun: false, days: 3, verbose, ...scanOverrides }, sink);
                    log(`Distill: ${r.stored} stored from ${r.sessionsScanned} sessions.`);
                  },
                },
              ]
            : []),
          ...(runExtractDaily
            ? [
                {
                  name: "extract-daily (7 days)",
                  run: async () => {
                    const r = await runExtractDaily({ days: 7, dryRun: false, verbose, ...scanOverrides }, sink);
                    const stored = r.totalStored ?? r.stored ?? 0;
                    log(`Extract-daily: ${stored} stored.`);
                  },
                },
              ]
            : []),
          ...(runExtractDirectives
            ? [
                {
                  name: "extract-directives (7 days)",
                  run: async () => {
                    const r = await runExtractDirectives({ days: 7, verbose, dryRun: false, ...scanOverrides });
                    log(`Extract-directives: ${r.sessionsScanned} sessions scanned.`);
                  },
                },
              ]
            : []),
          ...(runExtractReinforcement
            ? [
                {
                  name: "extract-reinforcement (7 days)",
                  run: async () => {
                    const r = await runExtractReinforcement({ days: 7, verbose, dryRun: false, ...scanOverrides });
                    log(`Extract-reinforcement: ${r.sessionsScanned} sessions scanned.`);
                  },
                },
              ]
            : []),
          ...(runExtractImplicitFeedback
            ? [
                {
                  name: "extract-implicit (3 days)",
                  run: async () => {
                    const r = await runExtractImplicitFeedback({ days: 3, verbose, dryRun: false, ...scanOverrides });
                    log(
                      `Extract-implicit: ${r.signalsExtracted} signals (${r.positiveCount}+/${r.negativeCount}-) from ${r.sessionsScanned} sessions.`,
                    );
                  },
                },
              ]
            : []),
          ...(runExtractProcedures
            ? [
                {
                  name: "extract-procedures (7 days)",
                  run: async () => {
                    await runExtractProcedures({ days: 7, dryRun: false, verbose, ...scanOverrides });
                    log("Extract procedures done.");
                  },
                },
              ]
            : []),
          ...(runGenerateAutoSkills
            ? [
                {
                  name: "generate-auto-skills",
                  run: async () => {
                    const r = await runGenerateAutoSkills({ dryRun: false, verbose });
                    log(`Generate-auto-skills: ${r.generated} generated.`);
                  },
                },
              ]
            : []),
          {
            name: "reflect",
            run: async () => {
              const r = await runReflection({
                window: reflectionConfig.defaultWindow,
                dryRun: false,
                model: reflectionConfig.model,
                verbose,
              });
              patternsStoredThisRun = r.patternsStored;
              log(`Reflect: ${r.patternsStored} patterns stored.`);
            },
          },
          {
            name: "reflect-rules",
            run: async () => {
              const livePatterns = countActivePatternFactsForMaintenance(factsDb);
              const patternGate = Math.max(patternsStoredThisRun, livePatterns);
              if (patternGate < 3) {
                log(
                  `Reflect-rules: skipped (${patternsStoredThisRun} stored this run, ${livePatterns} live patterns; need ≥3).`,
                );
                return;
              }
              const r = await runReflectionRules({ dryRun: false, model: reflectionConfig.model, verbose });
              const zeroReason = r.diagnostics?.zeroRulesReason
                ? `, zero_rules_reason=${r.diagnostics.zeroRulesReason}`
                : "";
              const diagnosticsSummary =
                `model_response_chars=${r.diagnostics?.modelResponseChars ?? 0}, ` +
                `parse_success=${r.diagnostics?.parseSuccess ?? false}, ` +
                `parsed_candidates=${r.diagnostics?.parsedCandidates ?? 0}, ` +
                `rejected_duplicates=${r.diagnostics?.rejectedDuplicates ?? 0}, ` +
                `rejected_low_confidence=${r.diagnostics?.rejectedLowConfidence ?? 0}, ` +
                `stored=${r.rulesStored}, ` +
                `status=${r.diagnostics?.status ?? "ok"}`;
              log(`Reflect-rules: ${r.rulesStored} rules stored (${diagnosticsSummary}${zeroReason}).`);
            },
          },
          {
            name: "reflect-meta",
            run: async () => {
              const livePatterns = countActivePatternFactsForMaintenance(factsDb);
              const patternGate = Math.max(patternsStoredThisRun, livePatterns);
              if (patternGate < 3) {
                log(
                  `Reflect-meta: skipped (${patternsStoredThisRun} stored this run, ${livePatterns} live patterns; need ≥3).`,
                );
                return;
              }
              const r = await runReflectionMeta({ dryRun: false, model: reflectionConfig.model, verbose });
              log(`Reflect-meta: ${r.metaStored} meta-patterns stored.`);
            },
          },
          ...(runReflectIdentity
            ? [
                {
                  name: "reflect-identity",
                  run: async () => {
                    const r = await runReflectIdentity({
                      dryRun: false,
                      model: reflectionConfig.model,
                      verbose,
                      window: reflectionConfig.defaultWindow,
                    });
                    log(`Reflect-identity: ${r.insightsStored} insights stored.`);
                  },
                },
              ]
            : []),
          ...(runGenerateProposals
            ? [
                {
                  name: "generate-proposals",
                  run: async () => {
                    const r = await runGenerateProposals({ dryRun: false, verbose });
                    log(`Generate-proposals: ${r.created} created.`);
                  },
                },
              ]
            : []),
          {
            name: "self-correction-run",
            run: async () => {
              await runSelfCorrectionRun({ dryRun: false, verbose, ...scanOverrides });
              log("Self-correction run done.");
            },
          },
          {
            name: "build-languages",
            run: async () => {
              const langPath = getLanguageKeywordsFilePath();
              if (langPath && existsSync(langPath)) {
                try {
                  const ageMs = Date.now() - statSync(langPath).mtimeMs;
                  const ageDays = ageMs / (24 * 60 * 60 * 1000);
                  if (ageDays < 7) {
                    if (verbose) log(`Build-languages: skipped (updated ${ageDays.toFixed(1)} days ago).`);
                    return;
                  }
                } catch (err) {
                  if (verbose) log(`Build-languages: could not read mtime (${err}); running anyway.`);
                }
              }
              const r = await runBuildLanguageKeywords({ dryRun: false });
              if (r.ok) log(`Build-languages: ${r.languagesAdded} languages added.`);
              else if (verbose) log(`Build-languages: ${r.error}`);
            },
          },
        ];
        if (dryRun) {
          log("run-all (dry-run). Would run:");
          steps.forEach((s, i) => {
            log(`  ${i + 1}. ${s.name}`);
          });
          return;
        }
        await requireWalFlushBeforeMutation("run_all_maintenance");
        for (let i = 0; i < steps.length; i++) {
          log(`[${i + 1}/${steps.length}] ${steps[i].name}`);
          try {
            await steps[i].run();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: `run-all:${steps[i].name}`,
            });
            throw err;
          }
        }
        log("run-all complete.");
      },
    ),
  );
}
