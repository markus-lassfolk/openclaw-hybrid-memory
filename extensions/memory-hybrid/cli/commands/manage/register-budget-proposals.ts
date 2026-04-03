import { getEnv } from "../../../utils/env-manager.js";
/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mergeAgentHealthDashboard } from "../../../backends/agent-health-store.js";
import type { FactsDB } from "../../../backends/facts-db.js";
import type { VectorDB } from "../../../backends/vector-db.js";
import type { HybridMemoryConfig } from "../../../config.js";
import { getCronModelConfig, getDefaultCronModel, vectorDimsForModel } from "../../../config.js";
import { collectForgeState } from "../../../routes/dashboard-server.js";
import { runContextAudit } from "../../../services/context-audit.js";
import { migrateEmbeddings } from "../../../services/embedding-migration.js";
import type { EmbeddingProvider } from "../../../services/embeddings.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { getEffectivenessReport, runClosedLoopAnalysis } from "../../../services/feedback-effectiveness.js";
import { runMemoryDiagnostics } from "../../../services/memory-diagnostics.js";
import { filterByScope, mergeResults } from "../../../services/merge-results.js";
import type { SearchResult } from "../../../types/memory.js";
import type { ScopeFilter } from "../../../types/memory.js";
import { getLanguageKeywordsFilePath } from "../../../utils/language-keywords.js";
import { execSync } from "../../../utils/process-runner.js";
import { buildCouncilSessionKey, buildProvenanceMetadata, generateTraceId } from "../../../utils/provenance.js";
import type { ManageContext } from "../../context.js";
import { buildAppliedContent, buildUnifiedDiff } from "../../proposals.js";
import { type Chainable, relativeTime, withExit } from "../../shared.js";
import type {
  AnalyzeFeedbackPhrasesResult,
  BackfillCliResult,
  BackfillCliSink,
  ConfigCliResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
  FindDuplicatesResult,
  IngestFilesResult,
  IngestFilesSink,
  MigrateToVaultResult,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  StoreCliOpts,
  StoreCliResult,
  UninstallCliResult,
  UpgradeCliResult,
} from "../../types.js";

import type { ManageBindings } from "./bindings.js";

export function registerManageBudgetAndProposals(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    aliasDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
    getMemoryCategories,
    cfg,
    runStore,
    runBackfill,
    runIngestFiles,
    runMigrateToVault,
    runCredentialsList,
    runCredentialsGet,
    runCredentialsAudit,
    runCredentialsPrune,
    runUpgrade,
    runUninstall,
    runConfigView,
    runConfigMode,
    runConfigSet,
    runConfigSetHelp,
    runFindDuplicates,
    runConsolidate,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    runReflectIdentity,
    reflectionConfig,
    runClassify,
    autoClassifyConfig,
    runSelfCorrectionExtract,
    runSelfCorrectionRun,
    runAnalyzeFeedbackPhrases,
    runCompaction,
    runDistill,
    runExtractProcedures,
    runBuildLanguageKeywords,
    runEntityEnrichment,
    runExport,
    listCommands,
    tieringEnabled,
    resolvedSqlitePath,
    runExtractDaily,
    runExtractDirectives,
    runExtractReinforcement,
    runExtractImplicitFeedback,
    runGenerateAutoSkills,
    runGenerateProposals,
    runDreamCycle,
    runContinuousVerification,
    runCrossAgentLearning,
    runToolEffectiveness,
    runCostReport,
    pruneCostLog,
    resolvedLancePath,
    runBackup,
    runBackupVerify,
    auditStore,
    agentHealthStore,
    ctx,
    BACKFILL_DECAY_MARKER,
  } = b;

  // ---- Token-budget tiered trimming (Issue #792) ----
  const budget = mem.command("budget").description("Token budget status and tiered trimming simulation");
  budget
    .command("show")
    .description("Show current token budget status and overflow")
    .action(
      withExit(async () => {
        try {
          const status = factsDb.getTokenBudgetStatus();
          const fmt = (n: number) => n.toLocaleString();
          console.log("Token Budget Report");
          console.log(
            `  Budget:  ${fmt(status.budget)} tokens (approx ${fmt(Math.round(status.budget * 3.8))} chars @ 3.8 chars/token)`,
          );
          console.log(
            `  Used:    ${fmt(status.totalTokens)} tokens (approx ${fmt(Math.round(status.totalTokens * 3.8))} chars)`,
          );
          console.log(`  Overflow: ${fmt(status.overflow)} tokens`);
          console.log(`
By Tier:`);
          console.log(
            `  P0 (never trim):  ${fmt(status.byTier.p0)} tokens  (${status.factCount.p0} facts) — edicts, verified, preserveUntil, preserveTags`,
          );
          console.log(
            `  P1 (trim last):   ${fmt(status.byTier.p1)} tokens  (${status.factCount.p1} facts) — importance >0.8, recent <1h`,
          );
          console.log(
            `  P2 (trim middle): ${fmt(status.byTier.p2)} tokens  (${status.factCount.p2} facts) — importance 0.5-0.8`,
          );
          console.log(
            `  P3 (trim first):  ${fmt(status.byTier.p3)} tokens  (${status.factCount.p3} facts) — importance <0.5`,
          );
          if (status.overflow > 0) {
            console.log(`
⚠️  Budget exceeded by ${fmt(status.overflow)} tokens. Run 'memory budget simulate' to see what would be trimmed.`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "budget-show",
          });
          throw err;
        }
      }),
    );
  budget
    .command("simulate")
    .description("Simulate tiered trimming to stay within budget")
    .option(
      "--budget <n>",
      "Token budget override (default: 80% of 32k context)",
      String(Math.ceil((32_000 * 0.8) / 3.8)),
    )
    .action(
      withExit(async (opts?: { budget?: string }) => {
        try {
          const DEFAULT_BUDGET = Math.ceil((32_000 * 0.8) / 3.8);
          const budgetVal = Number.parseInt(opts?.budget ?? String(DEFAULT_BUDGET), 10);
          const result = factsDb.trimToBudget(budgetVal, true);
          const fmt = (n: number) => n.toLocaleString();
          console.log(`Budget Simulation (budget=${fmt(budgetVal)} tokens)`);
          console.log(`  Before: ${fmt(result.beforeTokens)} tokens`);
          console.log(`  After:  ${fmt(result.afterTokens)} tokens`);
          console.log(`  Would trim ${result.trimmed.length} fact(s):`);
          if (result.trimmed.length === 0) {
            console.log("    (nothing to trim — within budget)");
          } else {
            for (const t of result.trimmed) {
              console.log(
                `  [${t.tier}] importance=${t.importance.toFixed(2)} tokens=${fmt(t.tokenCost)} — "${t.textPreview}"`,
              );
            }
          }
          console.log(`
Preserved (P0 — never trimmed, ${result.preserved.length} fact(s)):`);
          if (result.preserved.length === 0) {
            console.log("    (none)");
          } else {
            for (const p of result.preserved.slice(0, 20)) {
              console.log(`  ${p.id} — ${p.reason}`);
            }
            if (result.preserved.length > 20) {
              console.log(`  ... and ${result.preserved.length - 20} more`);
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "budget-simulate",
          });
          throw err;
        }
      }),
    );

  mem
    .command("preserve <id>")
    .description("Force-preserve a fact from tiered trimming. Run without options to show current preserve status.")
    .option("--until <epoch>", "Preserve until epoch seconds, 'never' to clear, or shorthand like '1y' (default: 1y)")
    .option("-t, --tag <tag>", "Add a preserve tag (can be repeated)")
    .action(
      withExit(async (id: string, opts?: { until?: string; tag?: string | null }) => {
        try {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            process.exitCode = 1;
            return;
          }
          const nowSec = Math.floor(Date.now() / 1000);
          const YEAR_SEC = 365 * 24 * 3600;

          let untilSec: number | null = null;
          const untilRaw = opts?.until;
          if (untilRaw && untilRaw !== "never") {
            const shorthandMatch = untilRaw.match(/^(\d+)([yYmMdD])$/);
            if (shorthandMatch) {
              const val = Number.parseInt(shorthandMatch[1]!, 10);
              const unit = shorthandMatch[2]?.toLowerCase();
              if (unit === "y") untilSec = nowSec + val * YEAR_SEC;
              else if (unit === "d") untilSec = nowSec + val * 86400;
              else if (unit === "m") untilSec = nowSec + val * 30 * 86400;
            } else {
              const parsed = Number.parseInt(untilRaw, 10);
              if (Number.isNaN(parsed) || parsed <= nowSec) {
                console.error(
                  `error: --until must be epoch seconds in the future, 'never', or shorthand like '1y'. Got: ${untilRaw}`,
                );
                process.exitCode = 1;
                return;
              }
              untilSec = parsed;
            }
          } else if (untilRaw === "never") {
            untilSec = null;
          } else {
            untilSec = nowSec + YEAR_SEC;
          }

          const addedTags: string[] = [];
          if (opts?.tag) {
            const tagVal = opts.tag;
            if (Array.isArray(tagVal)) {
              addedTags.push(...tagVal.map(String));
            } else {
              addedTags.push(String(tagVal));
            }
          }

          factsDb.setPreserveUntil(id, untilSec);
          if (addedTags.length > 0) {
            factsDb.setPreserveTags(id, addedTags, "add");
          }
          const final = factsDb.getById(id);
          const preview = fact.text.length > 80 ? `${fact.text.slice(0, 80)}…` : fact.text;
          console.log(`Preserved: "${preview}"`);
          const untilStr = final?.preserveUntil != null ? new Date(final.preserveUntil! * 1000).toISOString() : "null";
          console.log(`  preserveUntil: ${untilStr}`);
          console.log(`  preserveTags:  ${(final?.preserveTags ?? []).join(", ") || "(none)"}`);
          const tags = (fact.tags ?? []).map(String);
          if (tags.includes("edict")) {
            console.log(`  note: fact already has 'edict' tag — already P0 (never trimmed)`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "preserve",
          });
          throw err;
        }
      }),
    );

  const proposals = mem.command("proposals").description("Manage persona-driven proposals");
  const proposalStatusValues = ["pending", "approved", "rejected", "applied"] as const;
  proposals
    .command("list")
    .description("List pending proposals")
    .option("--status <s>", `Filter by status: ${proposalStatusValues.join(", ")}`)
    .action(
      withExit(async (opts?: { status?: string }) => {
        if (!listCommands?.listProposals) {
          console.log("Proposals feature not available (personaProposals disabled or no workspace).");
          return;
        }
        const status = opts?.status;
        if (
          status != null &&
          status !== "" &&
          !proposalStatusValues.includes(status as (typeof proposalStatusValues)[number])
        ) {
          console.error(`error: --status requires one of: ${proposalStatusValues.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        const items = await listCommands.listProposals({ status: status || undefined });
        console.log(`Proposals (${items.length}):`);
        for (const p of items) {
          console.log(
            `  [${p.id}] ${p.title} (target=${p.targetFile}, status=${p.status}, confidence=${p.confidence.toFixed(2)})`,
          );
        }
      }),
    );
  proposals
    .command("approve <id>")
    .description("Approve a proposal by ID")
    .action(
      withExit(async (id: string) => {
        if (!listCommands?.proposalApprove) {
          console.log("Proposals feature not available.");
          return;
        }
        const res = await listCommands.proposalApprove(id);
        if (res.ok) {
          console.log(`Proposal ${id} approved and applied.`);
        } else {
          console.error(`Error approving proposal ${id}: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );
  proposals
    .command("reject <id>")
    .description("Reject a proposal by ID")
    .option("--reason <r>", "Rejection reason")
    .action(
      withExit(async (id: string, opts?: { reason?: string }) => {
        if (!listCommands?.proposalReject) {
          console.log("Proposals feature not available.");
          return;
        }
        const res = await listCommands.proposalReject(id, opts?.reason);
        if (res.ok) {
          console.log(`Proposal ${id} rejected.`);
        } else {
          console.error(`Error rejecting proposal ${id}: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  proposals
    .command("show <proposalId>")
    .description("Show full proposal content (observation, suggested change, optional diff)")
    .option("--json", "Machine-readable output")
    .option("--diff", "Show unified diff against current target file")
    .action(
      withExit(async (proposalId: string, opts?: { json?: boolean; diff?: boolean }) => {
        if (!listCommands?.showItem) {
          console.log("Proposals feature not available.");
          return;
        }
        const item = await listCommands.showItem(proposalId);
        if (!item || item.type !== "proposal") {
          console.error(`Proposal ${proposalId} not found`);
          process.exitCode = 1;
          return;
        }
        const proposal = item.data as {
          id: string;
          status: string;
          targetFile: string;
          confidence: number;
          observation: string;
          suggestedChange: string;
          createdAt: number;
          evidenceSessions?: string[];
        };
        const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
        const targetPath = join(workspace, proposal.targetFile);
        const includeDiff = !!opts?.diff || !!opts?.json;
        let diffText: string | null = null;
        if (includeDiff) {
          try {
            const current = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
            const proposed = buildAppliedContent(current, proposal, new Date().toISOString()).content;
            diffText = buildUnifiedDiff(current, proposed, proposal.targetFile);
          } catch {
            diffText = null;
          }
        }
        if (opts?.json) {
          console.log(JSON.stringify({ ...proposal, diff: diffText }, null, 2));
          return;
        }
        const created = new Date(proposal.createdAt * 1000).toISOString();
        const evidenceCount = Array.isArray(proposal.evidenceSessions) ? proposal.evidenceSessions.length : 0;
        console.log(`Proposal: ${proposal.id}`);
        console.log(`Status: ${proposal.status}`);
        console.log(`Target: ${proposal.targetFile}`);
        console.log(`Confidence: ${proposal.confidence.toFixed(2)}`);
        console.log(`Created: ${created}`);
        console.log(`Evidence: ${evidenceCount} sessions`);
        console.log("");
        console.log("── Observation ──");
        console.log(proposal.observation);
        console.log("");
        console.log("── Suggested Change ──");
        console.log(proposal.suggestedChange);
        if (opts?.diff && diffText) {
          console.log("");
          console.log("── Preview (diff) ──");
          console.log(diffText);
        }
      }),
    );
}
