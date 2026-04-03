/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mergeAgentHealthDashboard } from "../../../backends/agent-health-store.js";
import { collectForgeState } from "../../../routes/dashboard-server.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { getLanguageKeywordsFilePath } from "../../../utils/language-keywords.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageAgentsAuditRunall(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
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

  mem
    .command("audit")
    .description("Cross-agent audit trail (Issue #790): query logged memory operations")
    .option("--hours <n>", "Look back window in hours", "24")
    .option("--agent <id>", "Filter by agent id")
    .option("--outcome <o>", "Filter: success, partial, or failed")
    .option("--target <t>", "Substring match on target field")
    .option("--format <f>", "Output: lines, summary, or timeline", "lines")
    .action(
      withExit(
        async (opts?: {
          hours?: string;
          agent?: string;
          outcome?: string;
          target?: string;
          format?: string;
        }) => {
          if (!auditStore) {
            console.error("Audit store is not available (e.g. in-memory tests or missing DB path).");
            process.exitCode = 1;
            return;
          }
          const hours = Math.max(1, Math.min(720, Number.parseInt(String(opts?.hours ?? "24"), 10) || 24));
          const sinceMs = Date.now() - hours * 3600 * 1000;
          const outcome =
            opts?.outcome === "success" || opts?.outcome === "partial" || opts?.outcome === "failed"
              ? opts.outcome
              : undefined;
          const fmt = (opts?.format ?? "lines").toLowerCase();
          const rows = auditStore.query({
            sinceMs,
            agentId: opts?.agent?.trim() || undefined,
            outcome,
            targetContains: opts?.target?.trim() || undefined,
            limit: fmt === "summary" ? 5000 : 500,
          });
          if (fmt === "summary") {
            let total = 0;
            const byOutcome: Record<string, number> = { success: 0, partial: 0, failed: 0 };
            const byAgent: Record<string, number> = {};
            for (const r of rows) {
              total++;
              byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
              byAgent[r.agentId] = (byAgent[r.agentId] ?? 0) + 1;
            }
            console.log(`Audit (last ${hours}h, filtered): total=${total}`);
            console.log(`  success=${byOutcome.success} partial=${byOutcome.partial} failed=${byOutcome.failed}`);
            for (const [a, c] of Object.entries(byAgent).sort((x, y) => y[1] - x[1])) {
              console.log(`  ${a}: ${c}`);
            }
            return;
          }
          if (fmt === "timeline") {
            const byHour = new Map<string, number>();
            for (const r of rows) {
              const d = new Date(r.timestamp);
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
              byHour.set(key, (byHour.get(key) ?? 0) + 1);
            }
            const keys = [...byHour.keys()].sort();
            for (const k of keys) {
              console.log(`${k}  ${"█".repeat(Math.min(40, byHour.get(k) ?? 0))} (${byHour.get(k)})`);
            }
            return;
          }
          for (const r of rows) {
            const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
            const dur = r.durationMs != null ? ` [${r.durationMs}ms]` : "";
            const tgt = r.target ? ` ${r.target}` : "";
            const err = r.error ? ` err=${r.error.slice(0, 80)}` : "";
            console.log(`${ts} ${r.agentId} ${r.action} ${r.outcome}${tgt}${dur}${err}`);
          }
          if (rows.length === 0) {
            console.log("(no events in window)");
          }
        },
      ),
    );

  mem
    .command("run-all")
    .description(
      "Run all maintenance tasks in optimal order (prune, compact, distill, extract-*, reflection, generate-proposals, self-correction, build-languages). Use --dry-run to list steps only.",
    )
    .option("--dry-run", "List steps that would run without executing")
    .option("--verbose", "Show detailed output for each step")
    .action(
      withExit(async (opts?: { dryRun?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const dryRun = !!opts?.dryRun;
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        const log = (s: string) => console.log(s);
        const sink = { log, warn: (s: string) => console.warn(s) };
        const memoryDir = resolvedSqlitePath ? dirname(resolvedSqlitePath) : null;
        const backfillDonePath = memoryDir ? join(memoryDir, BACKFILL_DECAY_MARKER) : null;

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
              const n = factsDb.prune();
              log(`Pruned ${n} expired facts.`);
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
                    const r = await runDistill({ dryRun: false, days: 3, verbose }, sink);
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
                    const r = await runExtractDaily({ days: 7, dryRun: false, verbose }, sink);
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
                    const r = await runExtractDirectives({ days: 7, verbose, dryRun: false });
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
                    const r = await runExtractReinforcement({ days: 7, verbose, dryRun: false });
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
                    const r = await runExtractImplicitFeedback({ days: 3, verbose, dryRun: false });
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
                    await runExtractProcedures({ days: 7, dryRun: false });
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
              log(`Reflect: ${r.patternsStored} patterns stored.`);
            },
          },
          {
            name: "reflect-rules",
            run: async () => {
              const r = await runReflectionRules({ dryRun: false, model: reflectionConfig.model, verbose });
              log(`Reflect-rules: ${r.rulesStored} rules stored.`);
            },
          },
          {
            name: "reflect-meta",
            run: async () => {
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
              await runSelfCorrectionRun({ dryRun: false });
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
          steps.forEach((s, i) => log(`  ${i + 1}. ${s.name}`));
          return;
        }
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
      }),
    );
}
