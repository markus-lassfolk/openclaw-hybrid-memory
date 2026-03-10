/**
 * CLI Handler Functions
 *
 * This module contains all the run*ForCli functions that were previously inline
 * in index.ts. These functions implement the CLI command logic and are called
 * by the CLI registration system in cli/register.ts.
 *
 * Each handler accepts a HandlerContext containing the shared dependencies
 * (databases, embeddings, config, etc.) rather than closing over module-level
 * variables.
 */

import OpenAI from "openai";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import type { MemoryCategory, HybridMemoryConfig, CredentialType, ConfigMode } from "../config.js";
import { hybridConfigSchema, getDefaultCronModel, getCronModelConfig, getLLMModelPreference, getProvidersWithKeys, type CronModelConfig } from "../config.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type {
  BackfillCliResult,
  BackfillCliSink,
  ConfigCliResult,
  DistillCliResult,
  DistillCliSink,
  DistillWindowResult,
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  GenerateAutoSkillsResult,
  IngestFilesResult,
  IngestFilesSink,
  InstallCliResult,
  MigrateToVaultResult,
  RecordDistillResult,
  StoreCliOpts,
  StoreCliResult,
  UninstallCliResult,
  UpgradeCliResult,
  VerifyCliSink,
} from "./register.js";
import type { SelfCorrectionRunResult, CredentialsAuditResult, CredentialsPruneResult } from "./types.js";
import { chatComplete, distillBatchTokenLimit, distillMaxOutputTokens, chatCompleteWithRetry } from "../services/chat.js";
import { extractProceduresFromSessions } from "../services/procedure-extractor.js";
import { generateAutoSkills } from "../services/procedure-skill-generator.js";
import { runMemoryToSkills, type SkillsSuggestResult } from "../services/memory-to-skills.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { estimateTokens, chunkSessionText, chunkTextByChars } from "../utils/text.js";
import { parseSourceDate } from "../utils/dates.js";
import { extractTags } from "../utils/tags.js";
import { getExtractionTemplates, getCorrectionSignalRegex, getDirectiveSignalRegex, getReinforcementSignalRegex, loadUserFeedbackPhrases, saveUserFeedbackPhrases } from "../utils/language-keywords.js";
import { runSelfCorrectionExtract, type CorrectionIncident, type SelfCorrectionExtractResult } from "../services/self-correction-extract.js";
import { capturePluginError } from "../services/error-reporter.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { tryExtractionFromTemplates } from "../utils/extraction-from-template.js";
import { runDirectiveExtract, type DirectiveExtractResult } from "../services/directive-extract.js";
import { runReinforcementExtract, type ReinforcementExtractResult } from "../services/reinforcement-extract.js";
import type { ReinforcementContext } from "../backends/facts-db.js";
import { extractImplicitSignals, parseSessionTurns } from "../services/implicit-feedback-extract.js";
import { buildTrajectories, serializeTrajectory, analyzeTrajectoriesWithLLM } from "../services/trajectory-tracker.js";
import { runClosedLoopAnalysis, getEffectivenessReport } from "../services/feedback-effectiveness.js";
import { classifyMemoryOperation } from "../services/classification.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { isCredentialLike, tryParseCredentialForVault, VAULT_POINTER_PREFIX } from "../services/auto-capture.js";
import { auditCredentialValue, auditServiceName, normalizeServiceForDedup } from "../services/credential-validation.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "../services/credential-migration.js";
import { gatherIngestFiles } from "../services/ingest-utils.js";
import { isValidCategory } from "../config.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { capProposalConfidence } from "./proposals.js";
import { relativeTime } from "./shared.js";
import {
  CLI_STORE_IMPORTANCE,
  BATCH_STORE_IMPORTANCE,
  PLUGIN_ID,
  getRestartPendingPath,
} from "../utils/constants.js";
import { runCrossAgentLearning } from "../services/cross-agent-learning.js";
import { computeToolEffectiveness, formatToolEffectivenessReport, ToolEffectivenessStore, generateMonthlyReport } from "../services/tool-effectiveness.js";
import type { CostTracker } from "../backends/cost-tracker.js";
import { getModeCostEstimates } from "../services/model-pricing.js";

// Shared cron job definitions used by install and verify --fix.
// Canonical schedule per #86 (7 jobs, non-overlapping). Model is resolved dynamically from user config via getLLMModelPreference.
// modelTier: "default" = standard LLM, "heavy" = larger context; resolved via getDefaultCronModel at install/verify time.
// Order: daily 02:00 → daily 02:30 → Sun 03:00 → Sun 04:00 → Sat 04:00 → Sun 10:00 → 1st 05:00.
const PLUGIN_JOB_ID_PREFIX = "hybrid-mem:";

/**
 * Minimum run interval guard (in milliseconds) for each job frequency tier.
 * When the cron runner triggers a job (e.g. on gateway restart), the agent-level
 * guard in the message prefix causes it to skip if it already ran within this interval.
 * This prevents expensive re-runs caused by gateway restarts (issue #304).
 */
const MIN_INTERVAL_MS: Record<string, number> = {
  daily: 20 * 60 * 60 * 1000,    // 20 hours (daily jobs)
  weekly: 5 * 24 * 60 * 60 * 1000, // 5 days (weekly jobs)
  monthly: 25 * 24 * 60 * 60 * 1000, // 25 days (monthly jobs)
};

/**
 * Build a guard prefix for cron job messages that checks a state file to prevent
 * re-runs within a minimum interval. The agent reads the timestamp file, compares
 * against the current time, and skips if the job ran too recently.
 */
function buildGuardPrefix(jobName: string, minIntervalMs: number): string {
  const hours = Math.round(minIntervalMs / (60 * 60 * 1000));
  const stateFile = `/tmp/hybrid-mem-guard-${jobName}.txt`;
  return `GUARD CHECK (issue #304): Before running, execute: cat ${stateFile} 2>/dev/null. ` +
    `If the file contains a Unix timestamp and (current time - that timestamp) < ${hours} hours (${minIntervalMs}ms), ` +
    `reply "Skipped: ${jobName} already ran within ${hours}h guard window" and do NOT run the commands below. ` +
    `Otherwise, proceed and AFTER successful completion write the current Unix timestamp: date +%s > ${stateFile}\n\n`;
}

const MAINTENANCE_CRON_JOBS: Array<Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number }> = [
  // Daily 02:00 | nightly-memory-sweep | prune → distill --days 3 → extract-daily
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "nightly-distill", name: "nightly-memory-sweep", schedule: { kind: "cron", expr: "0 2 * * *" }, channel: "system", message: "Nightly memory maintenance. Run in order:\n1. openclaw hybrid-mem prune\n2. openclaw hybrid-mem distill --days 3\n3. openclaw hybrid-mem extract-daily\n4. openclaw hybrid-mem resolve-contradictions\nCheck if distill is enabled (config distill.enabled !== false) before steps 2 and 3. If disabled, skip steps 2 and 3 and exit 0. Report counts.", isolated: true, modelTier: "default", enabled: true, minIntervalMs: MIN_INTERVAL_MS.daily },
  // Daily 02:30 | self-correction-analysis | self-correction-run
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "self-correction-analysis", name: "self-correction-analysis", schedule: { kind: "cron", expr: "30 2 * * *" }, channel: "system", message: "Run self-correction analysis: openclaw hybrid-mem self-correction-run. Check if self-correction is enabled (config selfCorrection is truthy). Exit 0 if disabled.", isolated: true, modelTier: "heavy", enabled: true, minIntervalMs: MIN_INTERVAL_MS.daily },
  // Sunday 03:00 | weekly-reflection | reflect --verbose → reflect-rules → reflect-meta
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "weekly-reflection", name: "weekly-reflection", schedule: { kind: "cron", expr: "0 3 * * 0" }, channel: "system", message: "Run weekly reflection pipeline:\n1. openclaw hybrid-mem reflect --verbose\n2. openclaw hybrid-mem reflect-rules --verbose\n3. openclaw hybrid-mem reflect-meta --verbose\nCheck reflection.enabled. Exit 0 if disabled.", isolated: true, modelTier: "default", enabled: true, minIntervalMs: MIN_INTERVAL_MS.weekly },
  // Sunday 04:00 | weekly-extract-procedures (nano = background model, avoids locking main AI)
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "weekly-extract-procedures", name: "weekly-extract-procedures", schedule: { kind: "cron", expr: "0 4 * * 0" }, channel: "system", message: "Run weekly extraction pipeline:\n1. openclaw hybrid-mem extract-procedures --days 7\n2. openclaw hybrid-mem extract-directives --days 7\n3. openclaw hybrid-mem extract-reinforcement --days 7\n4. openclaw hybrid-mem generate-auto-skills\nCheck feature configs. Exit 0 if all disabled.", isolated: true, modelTier: "nano", enabled: true, minIntervalMs: MIN_INTERVAL_MS.weekly },
  // Daily 02:15 | nightly-memory-to-skills | skills-suggest (issue #114)
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills", name: "nightly-memory-to-skills", schedule: { kind: "cron", expr: "15 2 * * *" }, channel: "system", message: "Run: openclaw hybrid-mem skills-suggest. This clusters procedural memories and drafts new skills under skills/auto-generated/. If new skill drafts were generated, notify the user in this system channel with a concise summary and paths. Exit 0 if memoryToSkills.enabled is false.", isolated: true, modelTier: "default", enabled: true, minIntervalMs: MIN_INTERVAL_MS.daily },
  // Saturday 04:00 | weekly-deep-maintenance | compact → vectordb-optimize → scope promote
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "weekly-deep-maintenance", name: "weekly-deep-maintenance", schedule: { kind: "cron", expr: "0 4 * * 6" }, channel: "system", message: "Run weekly deep maintenance:\n1. openclaw hybrid-mem compact\n2. openclaw hybrid-mem vectordb-optimize\n3. openclaw hybrid-mem scope promote\nReport counts for each step.", isolated: true, modelTier: "heavy", enabled: true, minIntervalMs: MIN_INTERVAL_MS.weekly },
  // Sunday 10:00 | weekly-persona-proposals | generate-proposals → notify if pending
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "weekly-persona-proposals", name: "weekly-persona-proposals", schedule: { kind: "cron", expr: "0 10 * * 0" }, channel: "system", message: "Run: openclaw hybrid-mem generate-proposals. This creates persona proposals from recent reflection insights. If there are pending proposals, notify the user in this system channel with a concise summary of the proposals. Exit 0 if personaProposals disabled.", isolated: true, modelTier: "heavy", enabled: true, minIntervalMs: MIN_INTERVAL_MS.weekly },
  // 1st of month 05:00 | monthly-consolidation | consolidate → build-languages → backfill-decay
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "monthly-consolidation", name: "monthly-consolidation", schedule: { kind: "cron", expr: "0 5 1 * *" }, channel: "system", message: "Run monthly consolidation:\n1. openclaw hybrid-mem consolidate --threshold 0.92\n2. openclaw hybrid-mem build-languages\n3. openclaw hybrid-mem backfill-decay\nReport what was merged, languages detected. Check feature configs. Exit 0 if all disabled.", isolated: true, modelTier: "heavy", enabled: true, minIntervalMs: MIN_INTERVAL_MS.monthly },
  // Daily 02:45 | nightly-dream-cycle | dream-cycle (prune → consolidate → reflect)
  // Default schedule; overridden by cfg.nightlyCycle.schedule during install/verify/upgrade.
  { pluginJobId: PLUGIN_JOB_ID_PREFIX + "nightly-dream-cycle", name: "nightly-dream-cycle", schedule: { kind: "cron", expr: "45 2 * * *" }, channel: "system", message: "Run nightly dream cycle: openclaw hybrid-mem dream-cycle\nThis runs in order: (1) prune expired/decayed facts, (2) consolidate old episodic events into facts, (3) reflect on recent facts to extract patterns, (4) extract rules if enough patterns accumulated.\nCheck if nightlyCycle.enabled is true in config before running. Exit 0 if disabled. Report counts: facts pruned, events consolidated, patterns found, rules generated.", isolated: true, modelTier: "default", enabled: true, minIntervalMs: MIN_INTERVAL_MS.daily },
];

/** Resolve model for a cron job def and return a job record suitable for the store (has model, no modelTier).
 * Strips the top-level `channel` field (maintenance jobs don't need user delivery) and sets delivery.mode = "none"
 * so the job runner never tries to send a WhatsApp/channel notification for plugin-internal jobs.
 * If the def has minIntervalMs, prepends a guard prefix to the message to prevent re-runs on gateway restart (#304). */
function resolveCronJob(def: Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number }, pluginConfig: CronModelConfig | undefined): Record<string, unknown> {
  const { modelTier, channel: _channel, minIntervalMs, ...rest } = def;
  const tier = modelTier ?? "default";
  const model = getDefaultCronModel(pluginConfig, tier);
  // Prepend guard prefix to message if minIntervalMs is set (issue #304)
  if (minIntervalMs && typeof rest.message === "string") {
    const jobName = (typeof rest.name === "string" ? rest.name : "unknown").replace(/\s+/g, "-");
    rest.message = buildGuardPrefix(jobName, minIntervalMs) + rest.message;
  }
  return { ...rest, model, delivery: { mode: "none" as const } };
}

const LEGACY_JOB_MATCHERS: Record<string, (j: Record<string, unknown>) => boolean> = {
  [PLUGIN_JOB_ID_PREFIX + "nightly-distill"]: (j) => String(j.name ?? "").toLowerCase().includes("nightly-memory-sweep"),
  [PLUGIN_JOB_ID_PREFIX + "weekly-reflection"]: (j) => /weekly-reflection|memory reflection|pattern synthesis/i.test(String(j.name ?? "")),
  [PLUGIN_JOB_ID_PREFIX + "weekly-extract-procedures"]: (j) => /extract-procedures|weekly-extract-procedures|procedural memory/i.test(String(j.name ?? "")),
  [PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills"]: (j) => /nightly-memory-to-skills|memory-to-skills|skills-suggest/i.test(String(j.name ?? "")),
  [PLUGIN_JOB_ID_PREFIX + "self-correction-analysis"]: (j) => /self-correction-analysis|self-correction\b/i.test(String(j.name ?? "")),
  [PLUGIN_JOB_ID_PREFIX + "weekly-deep-maintenance"]: (j) => /weekly-deep-maintenance|deep maintenance/i.test(String(j.name ?? "")),
  [PLUGIN_JOB_ID_PREFIX + "weekly-persona-proposals"]: (j) => /weekly-persona-proposals|persona proposals/i.test(String(j.name ?? "")),
  [PLUGIN_JOB_ID_PREFIX + "monthly-consolidation"]: (j) => /monthly-consolidation/i.test(String(j.name ?? "")),
  [PLUGIN_JOB_ID_PREFIX + "nightly-dream-cycle"]: (j) => /nightly-dream-cycle|dream.cycle/i.test(String(j.name ?? "")),
};

/**
 * Build the nightly-memory-to-skills cron job message based on memoryToSkills.notify config.
 * When notify is false, omit the user-notification instruction from the job message.
 */
function buildMemoryToSkillsMessage(notify: boolean): string {
  const base = "Run: openclaw hybrid-mem skills-suggest. This clusters procedural memories and drafts new skills under skills/auto-generated/.";
  const notifyClause = " If new skill drafts were generated, notify the user in this system channel with a concise summary and paths.";
  const exitClause = " Exit 0 if memoryToSkills.enabled is false.";
  return notify ? `${base}${notifyClause}${exitClause}` : `${base}${exitClause}`;
}

/**
 * Ensure maintenance cron jobs exist in ~/.openclaw/cron/jobs.json. Add any missing jobs; optionally normalize existing (schedule, pluginJobId).
 * Never re-enables jobs the user has disabled unless reEnableDisabled is true (callers should pass false to honor disabled jobs).
 * scheduleOverrides: optional map pluginJobId -> cron expr (e.g. memoryToSkills.schedule for nightly-memory-to-skills).
 * messageOverrides: optional map pluginJobId -> cron job message string (e.g. memoryToSkills.notify for nightly-memory-to-skills).
 */
function ensureMaintenanceCronJobs(
  openclawDir: string,
  pluginConfig: CronModelConfig | undefined,
  options: { normalizeExisting?: boolean; reEnableDisabled?: boolean; scheduleOverrides?: Record<string, string>; messageOverrides?: Record<string, string> } = {},
): { added: string[]; normalized: string[] } {
  const { normalizeExisting = false, reEnableDisabled = false, scheduleOverrides, messageOverrides } = options;
  const added: string[] = [];
  const normalized: string[] = [];
  const cronDir = join(openclawDir, "cron");
  const cronStorePath = join(cronDir, "jobs.json");
  mkdirSync(cronDir, { recursive: true });
  const store: { jobs?: unknown[] } = existsSync(cronStorePath) ? (JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] }) : {};
  if (!Array.isArray(store.jobs)) store.jobs = [];
  const jobsArr = store.jobs as Array<Record<string, unknown>>;
  let jobsChanged = false;
  for (const def of MAINTENANCE_CRON_JOBS) {
    const id = def.pluginJobId as string;
    const name = def.name as string;
    const scheduleExpr = scheduleOverrides?.[id];
    const existing = jobsArr.find((j) => j && (j.pluginJobId === id || LEGACY_JOB_MATCHERS[id]?.(j)));
    if (!existing) {
      const job = resolveCronJob(def, pluginConfig) as Record<string, unknown>;
      if (scheduleExpr) job.schedule = { kind: "cron", expr: scheduleExpr };
      if (messageOverrides?.[id]) job.message = messageOverrides[id];
      jobsArr.push(job);
      jobsChanged = true;
      added.push(name);
    } else {
      if (normalizeExisting) {
        if (typeof existing.schedule === "string") {
          existing.schedule = { kind: "cron", expr: scheduleExpr ?? existing.schedule };
          jobsChanged = true;
          normalized.push(name);
        } else if (scheduleExpr) {
          const currentExpr = (existing.schedule as { expr?: string })?.expr;
          if (currentExpr !== scheduleExpr) {
            existing.schedule = { kind: "cron", expr: scheduleExpr };
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        }
        if (messageOverrides?.[id] && existing.message !== messageOverrides[id]) {
          existing.message = messageOverrides[id];
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        if (!existing.pluginJobId) {
          existing.pluginJobId = id;
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        // Fix delivery: "announce" + channel "system" or "last" requires WhatsApp target (E.164); maintenance jobs don't need delivery.
        const d = existing.delivery as { mode?: string; channel?: string } | undefined;
        if (d && d.mode === "announce" && (d.channel === "system" || d.channel === "last")) {
          existing.delivery = { mode: "none" };
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        // Issue #304: Add guard prefix to existing job messages to prevent re-runs on gateway restart.
        // Only update if the message doesn't already have the guard prefix.
        // The on-disk format uses payload.message (agentTurn jobs), but older entries may use top-level message.
        if (def.minIntervalMs) {
          const jobSlug = name.replace(/\s+/g, "-");
          const guard = buildGuardPrefix(jobSlug, def.minIntervalMs as number);
          const payload = existing.payload as { message?: string; kind?: string } | undefined;
          if (payload && typeof payload.message === "string" && !payload.message.includes("GUARD CHECK")) {
            payload.message = guard + payload.message;
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          } else if (typeof existing.message === "string" && !existing.message.includes("GUARD CHECK")) {
            existing.message = guard + existing.message;
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        }
      }
      if (reEnableDisabled && existing.enabled === false) {
        existing.enabled = true;
        jobsChanged = true;
      }
    }
  }
  if (jobsChanged) writeFileSync(cronStorePath, JSON.stringify(store, null, 2), "utf-8");
  return { added, normalized };
}

// Helper function for progress reporting
function createProgressReporter(
  sink: { log: (msg: string) => void },
  total: number,
  label: string,
): { update: (current: number) => void; done: () => void } {
  let lastPercent = -1;
  return {
    update: (current: number) => {
      const percent = Math.floor((current / total) * 100);
      if (percent !== lastPercent && percent % 10 === 0) {
        sink.log(`${label}: ${percent}% (${current}/${total})`);
        lastPercent = percent;
      }
    },
    done: () => {
      sink.log(`${label}: Done (${total}/${total})`);
    },
  };
}

// relativeTime is exported from ./shared.ts and imported at the top of this file.

/**
 * Handler Context
 *
 * Contains all the shared dependencies that handlers need.
 * Passed as the first parameter to each handler function.
 */
export interface HandlerContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  credentialsDb: CredentialsDB | null;
  aliasDb: import("../services/retrieval-aliases.js").AliasDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  pluginId: string;
  logger: { info?: (m: string) => void; warn?: (m: string) => void };
  /** Category detection for extract-daily and similar; uses language keywords when set */
  detectCategory: (text: string) => MemoryCategory;
  /** OpenClaw plugin API — used for verify to read gateway config (e.g. models.providers for MiniMax etc.) */
  api?: import("openclaw/plugin-sdk").ClawdbotPluginApi;
  /** LLM cost tracker — records per-call token usage (Issue #270). */
  costTracker?: CostTracker | null;
}

// Constants
const FULL_DISTILL_MAX_DAYS = 90;
const INCREMENTAL_MIN_DAYS = 3;
const SELF_CORRECTION_CAP = 5;
const DEFAULT_INGEST_PATHS = ["skills/**/*.md", "TOOLS.md", "AGENTS.md"];
const DISTILL_DEDUP_THRESHOLD = 0.85;
const MAX_DESC_LEN = 280;

const DEFAULT_SELF_CORRECTION = {
  semanticDedup: true,
  semanticDedupThreshold: 0.92,
  toolsSection: "Self-correction rules",
  applyToolsByDefault: true,
  autoRewriteTools: false,
  analyzeViaSpawn: false,
  spawnThreshold: 15,
  spawnModel: "",
} as const;

/**
 * Infer which identity file a rule or suggestion should target (#260).
 */
export function inferTargetFile(content: string): string {
  const lower = content.toLowerCase();
  if (/\b(identity|creature|persona)\b/.test(lower)) return "IDENTITY.md";
  if (/\b(my (name|role)|agent (name|role|identity)|who (i am|you are))\b/.test(lower)) return "IDENTITY.md";
  if (/\b(preference|style|workflow|working|setup|tooling)\b/.test(lower)) return "USER.md";
  return "SOUL.md";
}

/**
 * Store a memory via CLI
 */
export async function runStoreForCli(
  ctx: HandlerContext,
  opts: StoreCliOpts,
  log: { warn: (m: string) => void },
): Promise<StoreCliResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, aliasDb } = ctx;
  const text = opts.text;
  if (factsDb.hasDuplicate(text)) return { outcome: "duplicate" };
  const sourceDate = opts.sourceDate ? parseSourceDate(opts.sourceDate) : null;
  const extracted = extractStructuredFields(text, (opts.category ?? "other") as MemoryCategory);
  const entity = opts.entity ?? extracted.entity ?? null;
  const key = opts.key ?? extracted.key ?? null;
  const value = opts.value ?? extracted.value ?? null;

  if (cfg.credentials.enabled && credentialsDb && isCredentialLike(text, entity, key, value)) {
    const parsed = tryParseCredentialForVault(text, entity, key, value, {
      requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
    });
    if (parsed) {
      // Step 1: Write to vault (use storeIfNew to avoid overwriting user-managed credentials)
      try {
        const stored = credentialsDb.storeIfNew({
          service: parsed.service,
          type: parsed.type as any,
          value: parsed.secretValue,
          url: parsed.url,
          notes: parsed.notes,
        });
        if (!stored) {
          return { outcome: "credential_skipped_duplicate", service: parsed.service, type: parsed.type };
        }
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:credential-vault-store" });
        return { outcome: "credential_vault_error" };
      }

      // Step 2: Write pointer to factsDb
      let pointerEntry: any;
      try {
        const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
        const pointerValue = `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`;
        pointerEntry = factsDb.store({
          text: pointerText,
          category: "technical" as MemoryCategory,
          importance: CLI_STORE_IMPORTANCE,
          entity: "Credentials",
          key: parsed.service,
          value: pointerValue,
          source: "cli",
          sourceDate,
          tags: ["auth", ...extractTags(pointerText, "Credentials")],
        });
        try {
          const vector = await embeddings.embed(pointerText);
          factsDb.setEmbeddingModel(pointerEntry.id, embeddings.modelName);
          if (!(await vectorDb.hasDuplicate(vector))) {
            await vectorDb.store({ text: pointerText, vector, importance: CLI_STORE_IMPORTANCE, category: "technical", id: pointerEntry.id });
          }
        } catch (err) {
          log.warn(`memory-hybrid: vector store failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:vector-store" });
        }
      } catch (err) {
        // Compensating delete: vault write succeeded but pointer write failed
        try {
          credentialsDb.delete(parsed.service, parsed.type as any);
        } catch (cleanupErr) {
          log.warn(`memory-hybrid: Failed to clean up orphaned credential for ${parsed.service}: ${cleanupErr}`);
          capturePluginError(cleanupErr as Error, { subsystem: "cli", operation: "runStoreForCli:credential-compensating-delete" });
        }
        capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:credential-db-store" });
        return { outcome: "credential_db_error" };
      }
      return { outcome: "credential", id: pointerEntry.id, service: parsed.service, type: parsed.type };
    }
    return { outcome: "credential_parse_error" };
  }

  const tags = opts.tags
    ? opts.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : undefined;
  const category = (opts.category ?? "other") as MemoryCategory;

  // FR-006: Compute scope early so it's available for classify-before-write UPDATE path
  const scope = opts.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (opts.scopeTarget?.trim() ?? null);

  if (cfg.store.classifyBeforeWrite) {
    let vector: number[] | undefined;
    try {
      vector = await embeddings.embed(text);
    } catch (err) {
      log.warn(`memory-hybrid: CLI store embedding failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:embed" });
    }
    if (vector) {
      let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
      if (similarFacts.length === 0) {
        similarFacts = factsDb.findSimilarForClassification(text, entity, key, 5);
      }
      if (similarFacts.length > 0) {
        try {
          const classification = await classifyMemoryOperation(
            text, entity, key, similarFacts, openai, cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano"), log,
          );
          if (classification.action === "NOOP") return { outcome: "noop", reason: classification.reason ?? "" };
          if (classification.action === "DELETE" && classification.targetId) {
            factsDb.supersede(classification.targetId, null);
            aliasDb?.deleteByFactId(classification.targetId);
            return { outcome: "retracted", targetId: classification.targetId, reason: classification.reason ?? "" };
          }
          if (classification.action === "UPDATE" && classification.targetId) {
            const oldFact = factsDb.getById(classification.targetId);
            if (oldFact) {
              const nowSec = Math.floor(Date.now() / 1000);
              const newEntry = factsDb.store({
                text,
                category,
                importance: CLI_STORE_IMPORTANCE,
                entity: entity ?? oldFact.entity,
                key: opts.key ?? extracted.key ?? oldFact.key ?? null,
                value: opts.value ?? extracted.value ?? oldFact.value ?? null,
                source: "cli",
                sourceDate,
                tags: tags ?? extractTags(text, entity),
                validFrom: sourceDate ?? nowSec,
                supersedesId: classification.targetId,
                scope,
                scopeTarget,
              });
              factsDb.supersede(classification.targetId, newEntry.id);
              aliasDb?.deleteByFactId(classification.targetId);
              try {
                factsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
                if (!(await vectorDb.hasDuplicate(vector))) {
                  await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category, id: newEntry.id });
                }
              } catch (err) {
                log.warn(`memory-hybrid: vector store failed: ${err}`);
                capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:vector-store-update" });
              }
              return { outcome: "updated", id: newEntry.id, supersededId: classification.targetId, reason: classification.reason ?? "" };
            }
          }
        } catch (err) {
          log.warn(`memory-hybrid: CLI store classification failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:classify" });
        }
      }
    }
  }

  // FR-006: scope already computed above
  const supersedesId = opts.supersedes?.trim();
  const nowSec = supersedesId ? Math.floor(Date.now() / 1000) : undefined;
  try {
    const entry = factsDb.store({
      text,
      category,
      importance: CLI_STORE_IMPORTANCE,
      entity,
      key: opts.key ?? extracted.key ?? null,
      value: opts.value ?? extracted.value ?? null,
      source: "cli",
      sourceDate,
      tags: tags ?? extractTags(text, entity),
      scope,
      scopeTarget,
      ...(supersedesId ? { validFrom: nowSec, supersedesId } : {}),
    });
    if (supersedesId) {
      factsDb.supersede(supersedesId, entry.id);
      aliasDb?.deleteByFactId(supersedesId);
    }
    try {
      const vector = await embeddings.embed(text);
      factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      if (!(await vectorDb.hasDuplicate(vector))) {
        await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category: opts.category ?? "other", id: entry.id });
      }
    } catch (err) {
      log.warn(`memory-hybrid: vector store failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:vector-store-final" });
    }
    return { outcome: "stored", id: entry.id, textPreview: text.slice(0, 80) + (text.length > 80 ? "..." : ""), ...(supersedesId ? { supersededId: supersedesId } : {}) };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:store" });
    throw err;
  }
}

/**
 * Deep merge utility that safely merges source into target, skipping prototype-related keys.
 * Exported for testing purposes.
 * 
 * @param target - The target object to merge into
 * @param source - The source object to merge from
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    // Guard against prototype pollution by skipping special keys.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const srcVal = source[key];
    const tgtVal = target[key];
    if (srcVal !== null && typeof srcVal === "object" && !Array.isArray(srcVal) && tgtVal !== null && typeof tgtVal === "object" && !Array.isArray(tgtVal)) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else if (tgtVal === undefined) {
      (target as Record<string, unknown>)[key] = srcVal;
    }
  }
}

/**
 * Install plugin configuration and cron jobs
 */
export function runInstallForCli(opts: { dryRun: boolean }): InstallCliResult {
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");

  const fullDefaults = {
    memory: { backend: "builtin" as const, citations: "auto" as const },
    plugins: {
      slots: { memory: PLUGIN_ID },
      entries: {
        "memory-core": { enabled: true },
        [PLUGIN_ID]: {
          enabled: true,
          config: {
            mode: "full",
            embedding: { apiKey: "YOUR_OPENAI_API_KEY", model: "text-embedding-3-small" },
            distill: { defaultModel: "gemini-3.1-pro-preview" },
            autoCapture: true,
            autoRecall: true,
            captureMaxChars: 5000,
            store: { fuzzyDedupe: false },
            autoClassify: { enabled: true, batchSize: 20 },
            verification: {
              enabled: false,
              backupPath: "~/.openclaw/verified-facts.json",
              reverificationDays: 30,
              autoClassify: true,
            },
            categories: [] as string[],
            credentials: { enabled: false, store: "sqlite" as const, encryptionKey: "", autoDetect: false, expiryWarningDays: 7 },
            languageKeywords: { autoBuild: true, weeklyIntervalDays: 7 },
            reflection: { enabled: true, defaultWindow: 14, minObservations: 2 },
            selfCorrection: {
              semanticDedup: true,
              semanticDedupThreshold: 0.92,
              toolsSection: "Self-correction rules",
              applyToolsByDefault: true,
              autoRewriteTools: false,
            },
          },
        },
      },
    },
    agents: {
      defaults: {
        bootstrapMaxChars: 15000,
        bootstrapTotalMaxChars: 50000,
        memorySearch: {
          enabled: true,
          sources: ["memory"],
          provider: "openai",
          model: "text-embedding-3-small",
          sync: { onSessionStart: true, onSearch: true, watch: true },
          chunking: { tokens: 500, overlap: 50 },
          query: { maxResults: 8, minScore: 0.3, hybrid: { enabled: true } },
        },
        compaction: {
          mode: "default",
          memoryFlush: {
            enabled: true,
            softThresholdTokens: 4000,
            flushEveryCompaction: true,
            systemPrompt: "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
            prompt: "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving.",
          },
        },
        // NOTE: agents.defaults.pruning is intentionally NOT included here.
        // OpenClaw core does not recognize this key; it has no effect and only causes confusion.
        // Memory pruning is handled internally by the plugin (every 60 min) via the memory_prune tool.
      },
    },
  };

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runInstallForCli:read-config" });
      return { ok: false, error: `Could not read ${configPath}: ${e}` };
    }
  }
  const existingApiKey = (config?.plugins as Record<string, unknown>)?.["entries"] && ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)?.[PLUGIN_ID] && (((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>)?.config && ((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>)?.embedding && (((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>).embedding as Record<string, unknown>)?.apiKey;
  const isRealKey = typeof existingApiKey === "string" && existingApiKey.length >= 10 && existingApiKey !== "YOUR_OPENAI_API_KEY" && existingApiKey !== "<OPENAI_API_KEY>";

  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  if (!(config.agents && typeof config.agents === "object")) config.agents = { defaults: {} };
  deepMerge(config, fullDefaults as unknown as Record<string, unknown>);
  if (isRealKey) {
    const entries = (config.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const mh = entries[PLUGIN_ID] as Record<string, unknown>;
    const cfg = mh?.config as Record<string, unknown>;
    const emb = cfg?.embedding as Record<string, unknown>;
    if (emb) emb.apiKey = existingApiKey;
  }
  const after = JSON.stringify(config, null, 2);

  if (opts.dryRun) {
    return { ok: true, configPath, dryRun: true, written: false, configJson: after, pluginId: PLUGIN_ID };
  }

  try {
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(join(openclawDir, "memory"), { recursive: true });
    writeFileSync(configPath, after, "utf-8");
    try {
      const pluginCfg = getPluginEntryConfig(config);
      const pluginConfig = pluginCfg as CronModelConfig | undefined;
      const memToSkills = pluginCfg?.memoryToSkills as Record<string, unknown> | undefined;
      const schedule = typeof memToSkills?.schedule === "string" && (memToSkills.schedule as string).trim().length > 0 ? (memToSkills.schedule as string).trim() : undefined;
      const notify = memToSkills?.notify !== false;
      const dreamCycleRaw = pluginCfg?.nightlyCycle as Record<string, unknown> | undefined;
      const dreamCycleSchedule = typeof dreamCycleRaw?.schedule === "string" && (dreamCycleRaw.schedule as string).trim().length > 0 ? (dreamCycleRaw.schedule as string).trim() : undefined;
      const installScheduleOverrides: Record<string, string> = {};
      if (schedule) installScheduleOverrides[PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills"] = schedule;
      if (dreamCycleSchedule) installScheduleOverrides[PLUGIN_JOB_ID_PREFIX + "nightly-dream-cycle"] = dreamCycleSchedule;
      ensureMaintenanceCronJobs(openclawDir, pluginConfig, {
        normalizeExisting: false,
        reEnableDisabled: false,
        scheduleOverrides: Object.keys(installScheduleOverrides).length > 0 ? installScheduleOverrides : undefined,
        messageOverrides: { [PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills"]: buildMemoryToSkillsMessage(notify) },
      });
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runInstallForCli:cron-setup" });
      // non-fatal: cron jobs optional on install
    }
    return { ok: true, configPath, dryRun: false, written: true, pluginId: PLUGIN_ID };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runInstallForCli:write-config" });
    return { ok: false, error: `Could not write config: ${err}` };
  }
}

/**
 * Verify plugin installation and configuration
 */
export async function runVerifyForCli(
  ctx: HandlerContext,
  opts: { fix: boolean; logFile?: string; testLlm?: boolean },
  sink: VerifyCliSink,
): Promise<void> {
  const { factsDb, vectorDb, embeddings, cfg, credentialsDb, resolvedSqlitePath, resolvedLancePath, openai } = ctx;
  const verbosity = cfg.verbosity ?? "normal";
  // In quiet mode: suppress ✅ / [OK] lines and section headers (─────); only pass through failures and summaries.
  const rawLog = sink.log;
  const log: typeof rawLog = verbosity === "quiet"
    ? (msg: string) => {
        // Suppress lines that are purely informational OK messages, section headers, and indented feature status lines
        const trimmed = msg.trimStart();
        const isOkLine = /^✅|^\[OK\]/.test(trimmed);
        const isHeader = /^─{3,}/.test(trimmed);
        // Suppress indented status lines (feature flags, config display) unless they contain failure indicators
        const isIndentedStatus = /^\s{2,}/.test(msg) && !/❌|\[FAIL\]|FAIL —|Error|error/.test(msg);
        if (!isOkLine && !isHeader && !isIndentedStatus) rawLog(msg);
      }
    : rawLog;
  const err = sink.error ?? rawLog;
  const noEmoji = process.env.HYBRID_MEM_NO_EMOJI === "1";
  const OK = noEmoji ? "[OK]" : "✅";
  const FAIL = noEmoji ? "[FAIL]" : "❌";
  const PAUSE = noEmoji ? "[paused]" : "⏸️ ";
  const ON = noEmoji ? "[on]" : "✅ on";
  const OFF = noEmoji ? "[off]" : "❌ off";
  const issues: string[] = [];
  const fixes: string[] = [];
  let configOk = true;
  let sqliteOk = false;
  let lanceOk = false;
  let embeddingOk = false;
  const loadBlocking: string[] = [];

  log("\n───── Infrastructure ─────");

  if (cfg.embedding.provider === "openai" && (!cfg.embedding.apiKey || cfg.embedding.apiKey === "YOUR_OPENAI_API_KEY" || cfg.embedding.apiKey.length < 10)) {
    issues.push("embedding.apiKey is missing, placeholder, or too short");
    loadBlocking.push("embedding.apiKey is missing, placeholder, or too short");
    fixes.push(`LOAD-BLOCKING: Set plugins.entries["${PLUGIN_ID}"].config.embedding.apiKey to a valid OpenAI key (and embedding.model to "text-embedding-3-small"). Edit ~/.openclaw/openclaw.json or set OPENAI_API_KEY and use env:OPENAI_API_KEY in config.`);
    configOk = false;
  }
  if (!cfg.embedding.model) {
    issues.push("embedding.model is missing");
    loadBlocking.push("embedding.model is missing");
    fixes.push('Set "embedding.model" to "text-embedding-3-small" or "text-embedding-3-large" in plugin config');
    configOk = false;
  }
  const openclawDir = join(homedir(), ".openclaw");
  const defaultConfigPath = join(openclawDir, "openclaw.json");
  if (configOk) {
    const msg = cfg.embedding.provider === "openai"
      ? "Config: embedding.apiKey and model present"
      : "Config: embedding.model present";
    log(`${OK} ${msg}`);
  } else {
    log(`${FAIL} Config: issues found`);
  }

  // Check for unsupported agents.defaults.pruning config (#105)
  try {
    if (existsSync(defaultConfigPath)) {
      const rawConfig = JSON.parse(readFileSync(defaultConfigPath, "utf-8")) as Record<string, unknown>;
      const agentsDefaults = (rawConfig.agents as Record<string, unknown>)?.defaults as Record<string, unknown> | undefined;
      if (agentsDefaults != null && 'pruning' in agentsDefaults) {
        const WARN = noEmoji ? "[WARN]" : "⚠️";
        log(`${WARN} Config: agents.defaults.pruning is set but not supported by OpenClaw core — it has no effect`);
        log(`  Fix: Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).`);
        issues.push("agents.defaults.pruning is set but unsupported (has no effect)");
        fixes.push('Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).');
        if (opts.fix) {
          delete agentsDefaults.pruning;
          writeFileSync(defaultConfigPath, JSON.stringify(rawConfig, null, 2), "utf-8");
          log(`  → Removed agents.defaults.pruning from ${defaultConfigPath}`);
          fixes.pop();
          issues.pop();
        }
      }
    }
  } catch {
    // non-fatal: skip pruning config check if config can't be read
  }

  const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const isBindingsError = (msg: string) =>
    /bindings|better_sqlite3\.node|compiled against|ABI|NODE_MODULE_VERSION|@lancedb\/lancedb|Cannot find module/.test(msg);
  let sqliteBindingsFailed = false;
  let lanceBindingsFailed = false;

  try {
    const n = factsDb.count();
    sqliteOk = true;
    log(`${OK} SQLite: OK (${resolvedSqlitePath}, ${n} facts)`);
  } catch (e) {
    const msg = String(e);
    issues.push(`SQLite: ${msg}`);
    if (isBindingsError(msg)) {
      sqliteBindingsFailed = true;
      fixes.push(`Native module (better-sqlite3) needs rebuild. Run: cd ${extDir} && npm rebuild better-sqlite3`);
    } else {
      fixes.push(`SQLite: Ensure path is writable and not corrupted. Path: ${resolvedSqlitePath}. If corrupted, back up and remove the file to recreate, or run from a process with write access.`);
    }
    log(`${FAIL} SQLite: FAIL — ${msg}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:sqlite-check" });
  }

  try {
    const n = await vectorDb.count();
    lanceOk = true;
    log(`${OK} LanceDB: OK (${resolvedLancePath}, ${n} vectors)`);
  } catch (e) {
    const msg = String(e);
    issues.push(`LanceDB: ${msg}`);
    if (isBindingsError(msg)) {
      lanceBindingsFailed = true;
      fixes.push(`Native module (@lancedb/lancedb) needs rebuild. Run: cd ${extDir} && npm rebuild @lancedb/lancedb`);
    } else {
      fixes.push(`LanceDB: Ensure path is writable. Path: ${resolvedLancePath}. If corrupted, back up and remove the directory to recreate. Restart gateway after fix.`);
    }
    log(`${FAIL} LanceDB: FAIL — ${msg}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:lancedb-check" });
  }

  try {
    await embeddings.embed("verify test");
    embeddingOk = true;
    log(`${OK} Embedding API: OK`);
  } catch (e) {
    issues.push(`Embedding API: ${String(e)}`);
    if (cfg.embedding.provider === "openai") {
      fixes.push(`Embedding API: Check key at platform.openai.com; ensure it has access to the embedding model (${cfg.embedding.model}). Set plugins.entries[\"openclaw-hybrid-memory\"].config.embedding.apiKey and restart. 401/403 = invalid or revoked key.`);
    } else if (cfg.embedding.provider === "ollama") {
      fixes.push(`Embedding API: Ensure Ollama is running at ${cfg.embedding.endpoint ?? "http://localhost:11434"} and the model "${cfg.embedding.model}" is available. Run 'ollama pull ${cfg.embedding.model}' if needed.`);
    } else if (cfg.embedding.provider === "google") {
      fixes.push(`Embedding API: Set distill.apiKey or llm.providers.google.apiKey in plugin config (Gemini API key). Restart gateway after updating.`);
    } else {
      fixes.push(`Embedding API: Check your ${cfg.embedding.provider} provider configuration and ensure the model "${cfg.embedding.model}" is accessible.`);
    }
    log(`${FAIL} Embedding API: FAIL — ${String(e)}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:embedding-check" });
  }

  const bool = (b: boolean) => b ? ON : OFF;
  const restartPending = existsSync(getRestartPendingPath());
  const modeLabel = cfg.mode
    ? cfg.mode === "custom"
      ? "Mode: Custom"
      : `Mode: ${cfg.mode.charAt(0).toUpperCase() + cfg.mode.slice(1)} (preset)`
    : "Mode: Custom";
  log(`\n───── Memory Mode ─────`);
  log(`${modeLabel}${restartPending ? " — restart pending" : ""}`);
  log(`  verbosity: ${cfg.verbosity ?? "normal"}`);

  log("\n───── Core Features ─────");
  log(`  autoCapture: ${bool(cfg.autoCapture)}`);
  log(`  autoRecall: ${bool(cfg.autoRecall.enabled)}`);
  log(`  autoClassify: ${cfg.autoClassify.enabled ? (cfg.autoClassify.model ? cfg.autoClassify.model : `${getDefaultCronModel(getCronModelConfig(cfg), "nano")} (from llm.${cfg.llm?.nano ? "nano" : "default"})`) : "false"}`);
  log(`  autoClassify.suggestCategories: ${bool(cfg.autoClassify.suggestCategories !== false)}`);
  log(`  credentials: ${bool(cfg.credentials.enabled)}`);

  if (cfg.credentials.enabled) {
    log(`  credentials.autoDetect: ${bool(cfg.credentials.autoDetect === true)}`);
    log(`  credentials.autoCapture.toolCalls (tool I/O): ${bool(cfg.credentials.autoCapture?.toolCalls === true)}`);
    const vaultEncrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
    log(`  → Credentials vault: ${vaultEncrypted ? "encrypted" : "plaintext (secure by other means)"}`);
  } else if (cfg.mode === "expert" || cfg.mode === "full") {
    log(`  → Credentials (vault): off — set credentials.enabled to use vault (optionally set credentials.encryptionKey for encryption).`);
  }

  log(`  store.fuzzyDedupe: ${bool(cfg.store.fuzzyDedupe)}`);
  log(`  store.classifyBeforeWrite: ${bool(cfg.store.classifyBeforeWrite === true)}`);
  log(`  graph: ${bool(cfg.graph.enabled)}`);

  if (cfg.graph.enabled) {
    log(`  graph.autoLink: ${bool(cfg.graph.autoLink)}`);
    log(`  graph.useInRecall: ${bool(cfg.graph.useInRecall)}`);
  }

  log(`  procedures: ${bool(cfg.procedures.enabled)}`);
  log(`  procedures.requireApprovalForPromote: ${bool(cfg.procedures.requireApprovalForPromote)}`);
  log(`  memoryToSkills: ${bool(cfg.memoryToSkills.enabled)}`);
  const reflectionModelDisplay = cfg.reflection.enabled
    ? ` (model: ${cfg.reflection.model ?? `${getDefaultCronModel(getCronModelConfig(cfg), "default")} (from llm.default)`})`  // reflection uses default, not nano
    : "";
  log(`  reflection: ${bool(cfg.reflection.enabled)}${reflectionModelDisplay}`);
  log(`  wal: ${bool(cfg.wal.enabled)}`);
  log(`  languageKeywords.autoBuild: ${bool(cfg.languageKeywords.autoBuild)}`);
  log(`  personaProposals: ${bool(cfg.personaProposals.enabled)}`);
  log(`  memoryTiering: ${bool(cfg.memoryTiering.enabled)}`);
  log(`  memoryTiering.compactionOnSessionEnd: ${bool(cfg.memoryTiering.compactionOnSessionEnd)}`);
  if (cfg.memoryTiering.enabled) {
    log(`    hotMaxTokens: ${cfg.memoryTiering.hotMaxTokens}`);
    log(`    inactivePreferenceDays: ${cfg.memoryTiering.inactivePreferenceDays}`);
    log(`    hotMaxFacts: ${cfg.memoryTiering.hotMaxFacts}`);
  }

  if (cfg.selfCorrection) {
    log(`  selfCorrection: true`);
    log(`  selfCorrection.semanticDedup: ${bool(cfg.selfCorrection.semanticDedup)}`);
    log(`  selfCorrection.applyToolsByDefault: ${bool(cfg.selfCorrection.applyToolsByDefault)}`);
    log(`  selfCorrection.autoRewriteTools: ${bool(cfg.selfCorrection.autoRewriteTools)}`);
    log(`  selfCorrection.analyzeViaSpawn: ${bool(cfg.selfCorrection.analyzeViaSpawn)}`);
  } else {
    log(`  selfCorrection: false`);
  }

  log(`  autoRecall.entityLookup: ${bool(cfg.autoRecall.entityLookup.enabled)}`);
  log(`  autoRecall.authFailure (reactive recall): ${bool(cfg.autoRecall.authFailure.enabled)}`);
  log(`  autoRecall.retrievalDirectives: ${bool(cfg.autoRecall.retrievalDirectives?.enabled)}`);

  log(`  activeTask (ACTIVE-TASK.md): ${bool(cfg.activeTask.enabled)}`);
  if (cfg.activeTask.enabled) {
    log(`    filePath: ${cfg.activeTask.filePath}`);
    log(`    staleThreshold: ${cfg.activeTask.staleThreshold}`);
    log(`    injectionBudget: ${cfg.activeTask.injectionBudget}`);
    log(`    autoCheckpoint: ${bool(cfg.activeTask.autoCheckpoint)}`);
    log(`    flushOnComplete: ${bool(cfg.activeTask.flushOnComplete)}`);
    log(`    staleWarning: ${bool(cfg.activeTask.staleWarning.enabled)}`);
  }

  log(`  nightlyCycle (dream-cycle): ${bool(cfg.nightlyCycle?.enabled)}`);
  log(`  passiveObserver: ${bool(cfg.passiveObserver?.enabled)}`);
  log(`  extraction (multi-pass): ${bool(cfg.extraction?.extractionPasses)}`);
  log(`  selfExtension (tool proposals): ${bool(cfg.selfExtension?.enabled)}`);
  log(`  crystallization (skill proposals): ${bool(cfg.crystallization?.enabled)}`);

  log(`  reinforcement (confidence boost): ${bool(cfg.reinforcement.enabled)}`);
  if (cfg.reinforcement.enabled) {
    log(`    passiveBoost: ${cfg.reinforcement.passiveBoost}`);
    log(`    activeBoost: ${cfg.reinforcement.activeBoost}`);
  }

  log(`  implicitFeedback: ${bool(cfg.implicitFeedback.enabled)}`);
  if (cfg.implicitFeedback.enabled) {
    log(`    feedToReinforcement: ${bool(cfg.implicitFeedback.feedToReinforcement)}`);
    log(`    feedToSelfCorrection: ${bool(cfg.implicitFeedback.feedToSelfCorrection)}`);
    log(`    trajectoryLLMAnalysis: ${bool(cfg.implicitFeedback.trajectoryLLMAnalysis)}`);
  }

  log(`  closedLoop: ${bool(cfg.closedLoop.enabled)}`);
  if (cfg.closedLoop.enabled) {
    log(`    runInNightlyCycle: ${bool(cfg.closedLoop.runInNightlyCycle)}`);
    log(`    measurementWindowDays: ${cfg.closedLoop.measurementWindowDays}`);
    log(`    minSampleSize: ${cfg.closedLoop.minSampleSize}`);
  }

  log(`  frustrationDetection: ${bool(cfg.frustrationDetection.enabled)}`);
  if (cfg.frustrationDetection.enabled) {
    log(`    windowSize: ${cfg.frustrationDetection.windowSize}`);
    log(`    injectionThreshold: ${cfg.frustrationDetection.injectionThreshold}`);
    log(`    decayRate: ${cfg.frustrationDetection.decayRate}`);
  }

  log(`  crossAgentLearning: ${bool(cfg.crossAgentLearning.enabled)}`);
  if (cfg.crossAgentLearning.enabled) {
    log(`    runInNightlyCycle: ${bool(cfg.crossAgentLearning.runInNightlyCycle)}`);
    log(`    windowDays: ${cfg.crossAgentLearning.windowDays}`);
    log(`    minSourceConfidence: ${cfg.crossAgentLearning.minSourceConfidence}`);
  }

  log(`  toolEffectiveness: ${bool(cfg.toolEffectiveness.enabled)}`);
  if (cfg.toolEffectiveness.enabled) {
    log(`    runInNightlyCycle: ${bool(cfg.toolEffectiveness.runInNightlyCycle)}`);
  }

  log(`  documents (MarkItDown): ${bool(cfg.documents.enabled)}`);
  if (cfg.documents.enabled) {
    log(`    visionEnabled: ${bool(cfg.documents.visionEnabled)}`);
    log(`    model: ${cfg.documents.visionModel ?? "(from llm.default)"}`);
  }

  log(`  provenance (DERIVED_FROM): ${bool(cfg.provenance.enabled)}`);

  log("\n───── Advanced Features ─────");
  if (cfg.search?.hydeEnabled) {
    log(`  search.hydeEnabled: DEPRECATED — use queryExpansion.enabled instead (auto-migrated)`);
    if (cfg.search.hydeModel) {
      log(`  search.hydeModel: DEPRECATED — use queryExpansion.model instead (value: ${cfg.search.hydeModel})`);
    }
  }
  log(`  queryExpansion.enabled: ${bool(cfg.queryExpansion.enabled)}`);
  if (cfg.queryExpansion.enabled) {
    const effectiveQEModel = cfg.queryExpansion.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
    log(`  queryExpansion.model: ${cfg.queryExpansion.model != null ? cfg.queryExpansion.model : `${effectiveQEModel} (nano tier)`}`);
  }
  if (cfg.errorReporting) {
    log(`  errorReporting: ${bool(cfg.errorReporting.enabled)} (consent: ${bool(cfg.errorReporting.consent)})`);
    if (cfg.errorReporting.enabled) {
      log(`    mode: ${cfg.errorReporting.mode ?? "community"}`);
      if (cfg.errorReporting.dsn) log(`    dsn: ${cfg.errorReporting.dsn}`);
      if (cfg.errorReporting.botId) log(`    botId: ${cfg.errorReporting.botId}`);
      if (cfg.errorReporting.botName) log(`    botName: ${cfg.errorReporting.botName}`);
    }
  }

  const cronCfgForVerify = getCronModelConfig(cfg);
  let defaultOrder = getLLMModelPreference(cronCfgForVerify, "default");
  let heavyOrder = getLLMModelPreference(cronCfgForVerify, "heavy");
  const providersWithKeys = getProvidersWithKeys(cronCfgForVerify);
  const llmSource = cfg.llm?._source === "gateway" ? " (auto from agents.defaults.model)" : cfg.llm ? " (from plugin config)" : "";
  const nanoOrder = getLLMModelPreference(cronCfgForVerify, "nano");
  const hasExplicitNano = Array.isArray(cfg.llm?.nano) && (cfg.llm.nano as string[]).length > 0;
  const nanoSameAsDefault = nanoOrder[0] === defaultOrder[0];

  // Build effective tier lists: append one model per provider that has a key but no model in config tiers
  // (so verify shows and tests Anthropic, Minimax, etc. when keys come from gateway merge)
  const hasModelFrom = (list: string[], prefix: string) =>
    list.some((m) => m.startsWith(`${prefix}/`) || (prefix === "anthropic" && m.startsWith("claude-")) || (prefix === "google" && m.startsWith("gemini-")));
  const apiConfigForVerify = ctx.api?.config as Record<string, unknown> | undefined;
  const gwProv = (apiConfigForVerify?.models as Record<string, unknown> | undefined)?.providers
    ?? (apiConfigForVerify?.llm as Record<string, unknown> | undefined)?.providers;
  const gwProvRecord = (gwProv && typeof gwProv === "object" && !Array.isArray(gwProv)) ? gwProv as Record<string, Record<string, unknown>> : undefined;
  const knownDefault: Record<string, string> = { anthropic: "anthropic/claude-sonnet-4-6", openai: "openai/gpt-4.1-mini", google: "google/gemini-2.5-flash" };
  for (const p of providersWithKeys) {
    if (hasModelFrom(defaultOrder, p) && hasModelFrom(heavyOrder, p)) continue;
    let model: string | null = knownDefault[p] ?? null;
    if (!model && gwProvRecord && gwProvRecord[p] && typeof gwProvRecord[p] === "object") {
      const g = gwProvRecord[p];
      const gm = typeof g.defaultModel === "string" ? g.defaultModel : typeof g.model === "string" ? g.model : null;
      if (gm?.trim()) model = `${p}/${gm.trim()}`;
    }
    if (!model) continue;
    if (!hasModelFrom(defaultOrder, p)) defaultOrder = [...defaultOrder, model];
    const heavyModel = p === "anthropic" ? "anthropic/claude-opus-4-6" : model;
    if (!hasModelFrom(heavyOrder, p)) heavyOrder = [...heavyOrder, heavyModel];
  }

  // Include providers that appear in failover lists (e.g. anthropic when keys are in gateway)
  const providersInFailover = new Set<string>();
  for (const model of [...nanoOrder, ...defaultOrder, ...heavyOrder]) {
    const prefix = model.includes("/") ? model.split("/")[0]!.trim() : "";
    if (prefix) providersInFailover.add(prefix);
  }
  const allProviders = [...new Set([...providersWithKeys, ...providersInFailover])].sort();
  log("\n───── LLM / Failover ─────");
  const nanoDisplay = hasExplicitNano
    ? nanoOrder.join(" → ")
    : `${nanoOrder[0] ?? "none"}${nanoSameAsDefault ? " (from llm.default — no nano model found)" : ""}`;
  log(`  nano tier (autoClassify, HyDE, classifyBeforeWrite, summarize): ${nanoDisplay}${llmSource}`);
  log(`  default tier (reflection, general): ${defaultOrder.join(" → ")}${llmSource}`);
  log(`  heavy tier (distill, self-correction): ${heavyOrder.join(" → ")}${llmSource}`);
  log(`  providers with keys: ${allProviders.length ? allProviders.join(", ") : "none"}`);
  // Hint when a provider has a key but no models in the tier lists (e.g. Anthropic key but no Claude/Opus in llm tiers)
  const inferProvider = (m: string): string => {
    const t = m.trim();
    if (t.includes("/")) return t.split("/")[0]!.trim().toLowerCase();
    const lower = t.toLowerCase();
    if (lower.startsWith("gemini-")) return "google";
    if (lower.startsWith("claude-")) return "anthropic";
    if (lower.startsWith("gpt-") || /^o[0-9]+/.test(lower)) return "openai";
    return "";
  };
  const providersInTiers = new Set<string>();
  for (const model of [...nanoOrder, ...defaultOrder, ...heavyOrder]) {
    const p = inferProvider(model);
    if (p) providersInTiers.add(p);
  }
  const knownPrefixes: Record<string, string> = { google: "Google", openai: "OpenAI", anthropic: "Anthropic" };
  for (const p of providersWithKeys) {
    if (!providersInTiers.has(p)) {
      const name = knownPrefixes[p] ?? p;
      const example = p === "anthropic" ? "anthropic/claude-opus-4-6" : p === "google" ? "google/gemini-3.1-pro-preview" : `${p}/<model>`;
      log(`  ℹ️  You have an API key for ${name} but no ${name} models in llm tiers — add e.g. ${example} to llm.default or llm.heavy to use and test it.`);
    }
  }
  // Gateway providers (for reference): plugin only uses providers with keys in plugin config
  const apiConfig = ctx.api?.config as Record<string, unknown> | undefined;
  const gatewayProviders = apiConfig?.models && typeof apiConfig.models === "object" && (apiConfig.models as Record<string, unknown>).providers && typeof (apiConfig.models as Record<string, unknown>).providers === "object"
    ? Object.keys((apiConfig.models as Record<string, unknown>).providers as Record<string, unknown>).filter(Boolean).sort()
    : [];
  if (gatewayProviders.length > 0) {
    const onlyInGateway = gatewayProviders.filter((g) => !allProviders.includes(g));
    if (onlyInGateway.length > 0) {
      log(`  Gateway also has providers: ${onlyInGateway.join(", ")} (plugin uses only providers with keys in plugin config; add llm.providers.<name> and <name>/model to llm tiers to use them here).`);
    }
  }
  if (defaultOrder.length > 1 || heavyOrder.length > 1) {
    log(`  (if a model fails, the next in the list is tried)`);
  }

  // Cost advisory
  const isHeavyModel = (m: string) => /\bpro\b|opus|\bo3\b|\bo1\b|\blarge\b|ultra|heavy/.test((m.split("/").pop() ?? m).toLowerCase());
  const isNanoModel  = (m: string) => /nano|\bmini\b|haiku|\blite\b/.test((m.split("/").pop() ?? m).toLowerCase());
  const isLightModel = (m: string) => isNanoModel(m) || /flash|\bsmall\b/.test((m.split("/").pop() ?? m).toLowerCase());
  const nanoPrimary = nanoOrder[0];
  const defaultPrimary = defaultOrder[0];
  const nanoIsHeavy = nanoPrimary ? isHeavyModel(nanoPrimary) : false;
  const hasNanoModel = nanoOrder.some(isNanoModel);
  const hasExplicitClassifyOverride = !!(cfg.autoClassify.model);
  const hasExplicitHydeOverride = !!(cfg.queryExpansion?.model || cfg.search?.hydeModel);

  if (nanoIsHeavy && !hasNanoModel && !hasExplicitClassifyOverride) {
    log(`  ⚠️  No nano/mini model for lightweight ops — autoClassify, query expansion, and summarize`);
    log(`     will use ${nanoPrimary} (a heavy model) for short, cheap tasks. This may increase costs.`);
    log(`     Fix: add llm.nano in plugin config, or set autoClassify.model and queryExpansion.model`);
    log(`     explicitly. Good options: openai/gpt-4.1-nano, google/gemini-2.0-flash-lite, anthropic/claude-haiku-*`);
  } else if (!hasNanoModel && !hasExplicitClassifyOverride && defaultPrimary && !isLightModel(defaultPrimary)) {
    log(`  ℹ️  Nano tier uses ${nanoPrimary ?? "default"}. For lower cost on classify/query-expansion/summarize,`);
    log(`     add llm.nano: ["openai/gpt-4.1-nano"] (OpenAI) or other nano/mini model to plugin config.`);
  }

  if (opts.testLlm) {
    const { chatComplete, UnconfiguredProviderError } = await import("../services/chat.js");
    const WARN = noEmoji ? "[WARN] " : "⚠️ ";
    const OK = noEmoji ? "[OK]" : "✅";
    const FAIL = noEmoji ? "[FAIL]" : "❌";
    const allModels = [...new Set([...nanoOrder, ...defaultOrder, ...heavyOrder])];
    const TEST_LLM_TIMEOUT_MS = 15_000;
    let anyUnconfigured = false;
    log("\n  LLM reachability (--test-llm):");
    const isNonChatModel = (m: string) => {
      const bare = m.includes("/") ? m.split("/")[1] ?? m : m;
      return bare.toLowerCase().includes("-codex");
    };
    for (const model of allModels) {
      if (isNonChatModel(model)) {
        log(`    ${model}: ${WARN}skipped — Codex/agentic models use a different API (not chat/completions)`);
        continue;
      }
      try {
        await chatComplete({
          model,
          content: "Reply with exactly: OK",
          temperature: 0,
          maxTokens: 10,
          openai,
          timeoutMs: TEST_LLM_TIMEOUT_MS,
        });
        log(`    ${model}: ${OK}`);
      } catch (e) {
        if (e instanceof UnconfiguredProviderError) {
          log(`    ${model}: ${WARN}skipped — ${e.message}`);
          anyUnconfigured = true;
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          log(`    ${model}: ${FAIL} ${msg}`);
        }
      }
    }
    if (anyUnconfigured) {
      log(`  → To enable skipped providers, add their API key to llm.providers.<provider>.apiKey in plugin config, or set env vars.`);
      log(`    Anthropic: llm.providers.anthropic.apiKey in config, or ANTHROPIC_API_KEY in the environment.`);
    }
  }

  // ───── Cost Tracking ─────
  log("\n───── Cost Tracking ─────");
  if (!ctx.cfg.costTracking.enabled) {
    log(`  Cost tracking: ⏸ Disabled`);
    log(`  Enable: openclaw hybrid-mem config-set costTracking.enabled true`);
  } else if (ctx.costTracker) {
    const totalCost = ctx.costTracker.getTotalCost(7);
    if (totalCost.calls === 0) {
      log(`  Cost tracking: ✅ Active — collecting data (first report available after ~1 hour of use)`);
    } else {
      const topFeatures = ctx.costTracker.getReport({ days: 7 });
      const totalUsd = totalCost.estimatedCostUsd;
      const topSpenders = topFeatures.features.slice(0, 3).map((f) => {
        const p = totalUsd > 0 ? Math.round((f.estimatedCostUsd / totalUsd) * 100) : 0;
        return `${f.feature}: ${p}%`;
      });
      log(`  Cost tracking: ✅ Active — $${totalUsd.toFixed(3)} last 7 days (${totalCost.calls} LLM calls)`);
      if (topSpenders.length > 0) {
        log(`  Top features: ${topSpenders.join(", ")}`);
      }
      log(`  Run 'openclaw hybrid-mem cost-report' for full breakdown.`);
    }
  } else {
    log(`  Cost tracking: ⚠️  Enabled in config but tracker failed to initialize`);
    log(`  Check logs or run 'openclaw hybrid-mem verify --fix' to diagnose.`);
  }

  // ───── Estimated Monthly Cost by Mode ─────
  log("\n───── Estimated Monthly Cost by Mode ─────");
  const modeEstimates = getModeCostEstimates();
  for (const est of modeEstimates) {
    const low = est.monthlyLow.toFixed(2);
    const high = est.monthlyHigh.toFixed(2);
    log(`  ${est.mode.padEnd(10)}: ~$${low}-${high}/mo  (${est.description})`);
  }
  log(`  ℹ️  Estimates assume ~100 conversations/month with nano-tier models.`);
  log(`     Heavy models (Opus, GPT-5.4) for distill/self-correction increase costs 5-10×.`);

  log("\n───── Ingestion & Distillation ─────");
  if (cfg.ingest) {
    log(`  ingest (paths configured): ${bool(true)}`);
  } else {
    log(`  ingest: ${bool(false)}`);
  }
  if (cfg.distill) {
    log(`  distill.extractDirectives: ${bool(cfg.distill.extractDirectives !== false)}`);
    log(`  distill.extractReinforcement: ${bool(cfg.distill.extractReinforcement !== false)}`);
    if (cfg.distill.extractionModelTier) {
      log(`  distill.extractionModelTier: ${cfg.distill.extractionModelTier}`);
    }
  } else {
    log(`  distill: ${bool(false)}`);
  }

  let credentialsOk = true;
  if (cfg.credentials.enabled) {
    if (credentialsDb) {
      try {
        const items = credentialsDb.list();
        if (items.length > 0) {
          const first = items[0];
          credentialsDb.get(first.service, first.type as CredentialType);
        }
        const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
        log(`\nCredentials (vault): OK (${items.length} stored)${encrypted ? " [encrypted]" : " [plaintext]"}`);
      } catch (e) {
        issues.push(`Credentials vault: ${String(e)}`);
        const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
        if (encrypted) {
          fixes.push(`Credentials vault: Wrong encryption key or corrupted DB. Set OPENCLAW_CRED_KEY to the key used when credentials were stored, or use a new vault path for plaintext. See docs/CREDENTIALS.md.`);
        } else {
          fixes.push(`Credentials vault: ${String(e)}. If this vault was created with encryption, set credentials.encryptionKey. See docs/CREDENTIALS.md.`);
        }
        credentialsOk = false;
        log(`\nCredentials (vault): FAIL — ${String(e)}`);
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:credentials-check" });
      }
    } else {
      log("\nCredentials (vault): enabled (vault not opened in this process)");
    }
  }

  const memoryDir = dirname(resolvedSqlitePath);
  const distillLastRunPath = join(memoryDir, ".distill_last_run");
  if (existsSync(distillLastRunPath)) {
    try {
      const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
      log(`\nSession distillation: last run recorded ${line ? `— ${line}` : "(empty file)"}`);
    } catch (e) {
      log("\nSession distillation: last run file present but unreadable");
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-distill-marker" });
    }
  } else {
    log("\nSession distillation: last run not recorded (optional).");
    log("  If you use session distillation (extracting facts from old logs): after each run, run: openclaw hybrid-mem record-distill");
    log("  If you have a nightly distillation cron job: add a final step to that job to run openclaw hybrid-mem record-distill so this is recorded.");
    log("  If you don't use it, ignore this.");
  }

  // Job name regex patterns for matching (use normalized name so "Weekly Reflection" etc. match)
  const cronStorePath = join(openclawDir, "cron", "jobs.json");
  const nightlyMemorySweepRe = /nightly[- ]?memory[- ]?sweep|memory distillation.*nightly|nightly.*memory.*distill/i;
  const weeklyReflectionRe = /weekly[- ]?reflection|memory reflection|pattern synthesis/i;
  const extractProceduresRe = /extract[- ]?procedures|weekly[- ]?extract[- ]?procedures|procedural memory/i;
  const nightlyMemoryToSkillsRe = /nightly[- ]?memory[- ]?to[- ]?skills|memory[- ]?to[- ]?skills|skills[- ]?suggest/i;
  const selfCorrectionRe = /self[- ]?correction[- ]?analysis|self[- ]?correction\b/i;
  const weeklyDeepMaintenanceRe = /weekly[- ]?deep[- ]?maintenance|deep maintenance/i;
  const weeklyPersonaProposalsRe = /weekly[- ]?persona[- ]?proposals|persona proposals/i;
  const monthlyConsolidationRe = /monthly[- ]?consolidation/i;

  const knownJobSlugs = new Set([
    "nightly-memory-sweep", "nightly-memory-to-skills", "weekly-reflection", "weekly-extract-procedures",
    "self-correction-analysis", "weekly-deep-maintenance", "monthly-consolidation", "weekly-persona-proposals",
  ]);

  /** Normalize job name to slug for matching: lowercase, spaces to single hyphen. */
  function nameToSlug(n: string): string {
    return n.toLowerCase().trim().replace(/\s+/g, "-").replace(/-+/g, "-");
  }

  // Helper function to map job names to canonical keys
  function getCanonicalJobKey(name: string, msg?: string): string | null {
    const nameLower = name.toLowerCase();
    const normalized = nameToSlug(name);
    if (nightlyMemorySweepRe.test(nameLower) || (msg && /nightly memory distillation|memory distillation pipeline/i.test(msg))) {
      return "nightly-memory-sweep";
    } else if (weeklyReflectionRe.test(nameLower)) {
      return "weekly-reflection";
    } else if (extractProceduresRe.test(nameLower)) {
      return "weekly-extract-procedures";
    } else if (nightlyMemoryToSkillsRe.test(nameLower) || (msg && /skills-suggest/i.test(msg))) {
      return "nightly-memory-to-skills";
    } else if (selfCorrectionRe.test(nameLower)) {
      return "self-correction-analysis";
    } else if (weeklyDeepMaintenanceRe.test(nameLower)) {
      return "weekly-deep-maintenance";
    } else if (weeklyPersonaProposalsRe.test(nameLower)) {
      return "weekly-persona-proposals";
    } else if (monthlyConsolidationRe.test(nameLower)) {
      return "monthly-consolidation";
    }
    // Fallback: if slug matches a known key exactly (e.g. "Weekly Reflection" -> "weekly-reflection"), use it
    if (knownJobSlugs.has(normalized)) {
      return normalized;
    }
    if (name) {
      return name;
    }
    return null;
  }

  // Helper function to format job status display
  function formatJobStatus(job: JobInfo, label: string, indent: string, log: (msg: string) => void): void {
    const statusIcon = job.enabled ? OK : PAUSE;
    const statusText = job.enabled ? "enabled " : "disabled";

    let statusDetails = "";
    const parts: string[] = [];

    if (job.state?.lastRunAtMs) {
      const lastStatus = job.state.lastStatus ?? "unknown";
      const lastRun = `last: ${relativeTime(job.state.lastRunAtMs)} (${lastStatus})`;
      parts.push(lastRun);
    } else {
      parts.push("last: never");
    }

    if (job.state?.nextRunAtMs) {
      parts.push(`next: ${relativeTime(job.state.nextRunAtMs)}`);
    }

    if (parts.length > 0) {
      statusDetails = "  " + parts.join("  ");
    }

    log(`${indent}${statusIcon} ${label.padEnd(30)} ${statusText}${statusDetails}`);

    // Show error details on next line if present
    if (job.state?.lastError && job.state.lastStatus === "error") {
      const errorPreview = job.state.lastError.slice(0, 100);
      log(`${indent}   └─ error: ${errorPreview}${job.state.lastError.length > 100 ? "..." : ""}`);
    }
  }

  // Enhanced job status display
  log("\nScheduled jobs (cron store at ~/.openclaw/cron/jobs.json):");

  // Read all jobs with state information
  interface JobInfo {
    name: string;
    enabled: boolean;
    state?: {
      nextRunAtMs?: number;
      lastRunAtMs?: number;
      lastStatus?: string;
      lastError?: string;
    };
  }

  const allJobs = new Map<string, JobInfo>();

  if (existsSync(cronStorePath)) {
    try {
      const raw = readFileSync(cronStorePath, "utf-8");
      const store = JSON.parse(raw) as Record<string, unknown>;
      const jobs = store.jobs;
      if (Array.isArray(jobs)) {
        for (const j of jobs) {
          if (typeof j !== "object" || j === null) continue;
          const job = j as Record<string, unknown>;
          const name = String(job.name ?? "");
          const enabled = job.enabled !== false;
          const state = job.state as { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastError?: string } | undefined;

          // Extract payload message for fallback matching
          const payload = job.payload as Record<string, unknown> | undefined;
          const msg = String((payload?.message ?? job.message) || "");

          // Map job names to our known jobs (check both name and payload message)
          const canonicalKey = getCanonicalJobKey(name, msg);
          if (canonicalKey) {
            allJobs.set(canonicalKey, { name, enabled, state });
          }
        }
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-job-state" });
      // Continue with incomplete data
    }
  }

  // Also check default config for jobs not found in cron store
  if (existsSync(defaultConfigPath)) {
    try {
      const raw = readFileSync(defaultConfigPath, "utf-8");
      const root = JSON.parse(raw) as Record<string, unknown>;
      const jobs = root.jobs;
      if (Array.isArray(jobs)) {
        for (const j of jobs) {
          if (typeof j !== "object" || j === null) continue;
          const job = j as Record<string, unknown>;
          const name = String(job.name ?? "");
          const enabled = job.enabled !== false;

          // Only add if not already found in cron store
          const canonicalKey = getCanonicalJobKey(name);
          if (canonicalKey && !allJobs.has(canonicalKey)) {
            allJobs.set(canonicalKey, { name, enabled });
          }
        }
      } else if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
        const keyed = jobs as Record<string, unknown>;
        for (const [key, value] of Object.entries(keyed)) {
          if (typeof value !== "object" || value === null) continue;
          const job = value as Record<string, unknown>;
          const enabled = job.enabled !== false;

          // Only add if not already found in cron store
          const canonicalKey = getCanonicalJobKey(key);
          if (canonicalKey && !allJobs.has(canonicalKey)) {
            allJobs.set(canonicalKey, { name: key, enabled });
          }
        }
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-default-config-jobs" });
      // Continue with incomplete data
    }
  }

  // Display each job with its status
  const jobsToDisplay = [
    { key: "nightly-memory-sweep", description: "session distillation", docsPath: "docs/SESSION-DISTILLATION.md § Nightly Cron Setup" },
    { key: "nightly-memory-to-skills", description: "memory-to-skills", docsPath: "docs/MEMORY-TO-SKILLS.md" },
    { key: "weekly-reflection", description: "pattern synthesis", docsPath: "docs/REFLECTION.md § Scheduled Job" },
    { key: "weekly-extract-procedures", description: "procedural memory", docsPath: "docs/PROCEDURAL-MEMORY.md" },
    { key: "self-correction-analysis", description: "self-correction", docsPath: "docs/SELF-CORRECTION-PIPELINE.md" },
    { key: "weekly-deep-maintenance", description: "deep maintenance", docsPath: null },
    { key: "monthly-consolidation", description: "monthly consolidation", docsPath: null },
    { key: "weekly-persona-proposals", description: "persona proposals", docsPath: null },
  ];

  for (const { key, description, docsPath } of jobsToDisplay) {
    const job = allJobs.get(key);

    if (!job) {
      log(`  ${FAIL} ${key.padEnd(30)} missing`);
      const fixMsg = docsPath
        ? `Optional: Set up ${description} via jobs. See ${docsPath}. Run 'openclaw hybrid-mem verify --fix' to add.`
        : `Optional: Set up ${description} via jobs. Run 'openclaw hybrid-mem verify --fix' to add.`;
      fixes.push(fixMsg);
      continue;
    }

    formatJobStatus(job, key, "  ", log);
  }

  // Display any unknown/custom jobs not in the hardcoded list
  const knownKeys = new Set(jobsToDisplay.map((j) => j.key));
  const unknownJobs = Array.from(allJobs.entries()).filter(([key]) => !knownKeys.has(key));

  if (unknownJobs.length > 0) {
    log("\n  Other custom jobs:");
    for (const [key, job] of unknownJobs) {
      formatJobStatus(job, job.name, "    ", log);
    }
  }

  log("\nBackground jobs (when gateway is running): prune every 60min, auto-classify every 24h if enabled. No external cron required.");

  if (opts.logFile && existsSync(opts.logFile)) {
    try {
      const content = readFileSync(opts.logFile, "utf-8");
      const lines = content.split("\n").filter((l) => /memory-hybrid|prune|auto-classify|periodic|failed/.test(l));
      const errLines = lines.filter((l) => /error|fail|warn/i.test(l));
      if (errLines.length > 0) {
        log(`\nRecent log lines mentioning memory-hybrid/errors (last ${errLines.length}):`);
        errLines.slice(-10).forEach((l) => log(`  ${l.slice(0, 120)}`));
      } else if (lines.length > 0) {
        log(`\nLog file: ${lines.length} relevant lines (no errors in sample)`);
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-log-file" });
    }
  } else if (opts.logFile) {
    log(`\nLog file not found: ${opts.logFile}`);
  }

  const allOk = configOk && sqliteOk && lanceOk && embeddingOk && (!cfg.credentials.enabled || credentialsOk);
  if (allOk) {
    log("\nAll checks passed.");
    if (restartPending) {
      process.exitCode = 2; // Scripting: 2 = restart pending (gateway restart recommended)
    }
    log("Note: If you see 'plugins.allow is empty' above, it is from OpenClaw. Optional: set plugins.allow to [\"openclaw-hybrid-memory\"] in openclaw.json for an explicit allow-list.");
    if (!allJobs.has("nightly-memory-sweep")) {
      log("Optional: Set up nightly session distillation via OpenClaw's scheduled jobs or system cron. See docs/SESSION-DISTILLATION.md.");
    }
  } else {
    log("\n--- Issues ---");
    if (loadBlocking.length > 0) {
      log("Load-blocking (prevent OpenClaw / plugin from loading):");
      loadBlocking.forEach((i) => log(`  - ${i}`));
    }
    const other = issues.filter((i) => !loadBlocking.includes(i));
    if (other.length > 0) {
      log(other.length > 0 && loadBlocking.length > 0 ? "Other:" : "Issues:");
      other.forEach((i) => log(`  - ${i}`));
    }
    log("\n--- Fixes for detected issues ---");
    fixes.forEach((f) => log(`  • ${f}`));
    log("\nEdit config: " + defaultConfigPath + " (or OPENCLAW_HOME/openclaw.json). Restart gateway after changing plugin config.");
  }

  if (opts.fix) {
    const applied: string[] = [];
    if (sqliteBindingsFailed || lanceBindingsFailed) {
      try {
        const { spawnSync } = await import("node:child_process");
        const pkgs = [
          ...(sqliteBindingsFailed ? ["better-sqlite3"] : []),
          ...(lanceBindingsFailed ? ["@lancedb/lancedb"] : []),
        ];
        for (const pkg of pkgs) {
          const r = spawnSync("npm", ["rebuild", pkg], { cwd: extDir, shell: true });
          if (r.status === 0) {
            applied.push(`Rebuilt native module: ${pkg}`);
          } else {
            log(`Rebuild ${pkg} failed (exit ${r.status}). Run manually: cd ${extDir} && npm rebuild ${pkg}`);
          }
        }
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:rebuild-modules" });
      }
    }

    if (existsSync(defaultConfigPath)) {
      try {
        const raw = readFileSync(defaultConfigPath, "utf-8");
        const fixConfig = JSON.parse(raw) as Record<string, unknown>;
        let changed = false;
        if (!fixConfig.plugins || typeof fixConfig.plugins !== "object") fixConfig.plugins = {};
        const plugins = fixConfig.plugins as Record<string, unknown>;
        if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
        const entries = plugins.entries as Record<string, unknown>;
        if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = { enabled: true, config: {} };
        const mh = entries[PLUGIN_ID] as Record<string, unknown>;
        if (!mh.config || typeof mh.config !== "object") mh.config = {};
        const cfgFix = mh.config as Record<string, unknown>;
        if (!cfgFix.embedding || typeof cfgFix.embedding !== "object") cfgFix.embedding = {};
        const emb = cfgFix.embedding as Record<string, unknown>;
        const curKey = emb.apiKey;
        const placeholder = typeof curKey !== "string" || curKey.length < 10 || curKey === "YOUR_OPENAI_API_KEY" || curKey === "<OPENAI_API_KEY>";
        if (placeholder) {
          emb.apiKey = "YOUR_OPENAI_API_KEY";
          emb.model = emb.model || "text-embedding-3-small";
          changed = true;
          applied.push("Set embedding.apiKey and model (use your key or ${OPENAI_API_KEY} in config)");
        }
        const memoryDirPath = dirname(resolvedSqlitePath);
        if (!existsSync(memoryDirPath)) {
          mkdirSync(memoryDirPath, { recursive: true });
          applied.push("Created memory directory: " + memoryDirPath);
        }

        // Add cron jobs (same logic as install)
        const cronDir = join(openclawDir, "cron");
        const cronStorePath = join(cronDir, "jobs.json");

        try {
          const scheduleOverrides: Record<string, string> = {};
          if (typeof cfg.memoryToSkills?.schedule === "string" && cfg.memoryToSkills.schedule.trim().length > 0) {
            scheduleOverrides[PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills"] = cfg.memoryToSkills.schedule;
          }
          if (typeof cfg.nightlyCycle?.schedule === "string" && cfg.nightlyCycle.schedule.trim().length > 0) {
            scheduleOverrides[PLUGIN_JOB_ID_PREFIX + "nightly-dream-cycle"] = cfg.nightlyCycle.schedule;
          }
          const { added, normalized } = ensureMaintenanceCronJobs(openclawDir, getCronModelConfig(cfg), {
            normalizeExisting: true,
            reEnableDisabled: false,
            scheduleOverrides: Object.keys(scheduleOverrides).length > 0 ? scheduleOverrides : undefined,
            messageOverrides: { [PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills"]: buildMemoryToSkillsMessage(cfg.memoryToSkills?.notify !== false) },
          });
          added.forEach((name) => applied.push(`Added ${name} job to ${cronStorePath}`));
          normalized.forEach((name) => applied.push(`Normalized ${name} job (schedule/pluginJobId)`));
        } catch (e) {
          log("Could not add optional jobs to cron store: " + String(e));
          capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:add-cron-jobs" });
        }

        if (changed) {
          writeFileSync(defaultConfigPath, JSON.stringify(fixConfig, null, 2), "utf-8");
        }
        if (applied.length > 0) {
          log("\n--- Applied fixes ---");
          applied.forEach((a) => log("  • " + a));
          if (changed) log("Config written: " + defaultConfigPath + ". Restart the gateway and run verify again.");
        }
      } catch (e) {
        log("\nCould not apply fixes to config: " + String(e));
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:apply-fixes" });
        const snippet = {
          embedding: { apiKey: "<set your key or use ${OPENAI_API_KEY}>", model: "text-embedding-3-small" },
          autoCapture: true,
          autoRecall: true,
          captureMaxChars: 5000,
          store: { fuzzyDedupe: false },
        };
        log(`Minimal config snippet to merge into plugins.entries["${PLUGIN_ID}"].config:`);
        log(JSON.stringify(snippet, null, 2));
      }
    } else {
      log("\n--- Fix (--fix) ---");
      log("Config file not found. Run 'openclaw hybrid-mem install' to create it with full defaults, then set your API key and restart.");
    }
  }
}

/**
 * Calculate distillation window (full vs incremental)
 */
export function runDistillWindowForCli(
  ctx: HandlerContext,
  _opts: { json: boolean },
): DistillWindowResult {
  const { resolvedSqlitePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  const distillLastRunPath = join(memoryDir, ".distill_last_run");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let mode: "full" | "incremental";
  let startDate: string;
  const endDate = today;
  let mtimeDays: number;

  if (!existsSync(distillLastRunPath)) {
    mode = "full";
    const start = new Date(now);
    start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
    startDate = start.toISOString().slice(0, 10);
    mtimeDays = FULL_DISTILL_MAX_DAYS;
  } else {
    try {
      const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
      if (!line) {
        mode = "full";
        const start = new Date(now);
        start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
        startDate = start.toISOString().slice(0, 10);
        mtimeDays = FULL_DISTILL_MAX_DAYS;
      } else {
        const lastRun = new Date(line);
        if (Number.isNaN(lastRun.getTime())) {
          mode = "full";
          const start = new Date(now);
          start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
          startDate = start.toISOString().slice(0, 10);
          mtimeDays = FULL_DISTILL_MAX_DAYS;
        } else {
          mode = "incremental";
          const lastRunDate = lastRun.toISOString().slice(0, 10);
          const threeDaysAgo = new Date(now);
          threeDaysAgo.setDate(threeDaysAgo.getDate() - INCREMENTAL_MIN_DAYS);
          const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
          startDate = lastRunDate < threeDaysAgoStr ? lastRunDate : threeDaysAgoStr;
          const start = new Date(startDate);
          mtimeDays = Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
          if (mtimeDays < 1) mtimeDays = 1;
        }
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runDistillWindowForCli" });
      mode = "full";
      const start = new Date(now);
      start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
      startDate = start.toISOString().slice(0, 10);
      mtimeDays = FULL_DISTILL_MAX_DAYS;
    }
  }
  return { mode, startDate, endDate, mtimeDays };
}

/**
 * Record distillation run timestamp
 */
export function runRecordDistillForCli(ctx: HandlerContext): RecordDistillResult {
  const { resolvedSqlitePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  mkdirSync(memoryDir, { recursive: true });
  const path = join(memoryDir, ".distill_last_run");
  const ts = new Date().toISOString();
  try {
    writeFileSync(path, ts + "\n", "utf-8");
    return { path, timestamp: ts };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runRecordDistillForCli" });
    throw err;
  }
}

/** In-memory concurrency lock: prevents two simultaneous scans of the same type. */
const SCAN_IN_PROGRESS = new Map<string, boolean>();

/** 23-hour threshold for startup guard (seconds). */
const SCAN_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

/**
 * Returns session .jsonl file paths modified within the last `days` days,
 * or — when `sinceTimestamp` is provided — modified strictly after that epoch-ms.
 * Shared by procedure/directive/reinforcement extraction.
 */
function getSessionFilePathsSince(sessionDir: string, days: number, sinceTimestamp?: number): string[] {
  if (!existsSync(sessionDir)) return [];
  const cutoff = sinceTimestamp !== undefined
    ? sinceTimestamp
    : Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const files = readdirSync(sessionDir);
    return files
      .filter((f) => f.endsWith(".jsonl") && !f.startsWith(".deleted"))
      .map((f) => join(sessionDir, f))
      .filter((p) => {
        try {
          return statSync(p).mtimeMs > cutoff;
        } catch (err) {
          capturePluginError(err as Error, {
            operation: 'stat-check',
            severity: 'info',
            subsystem: 'cli'
          });
          return false;
        }
      });
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "getSessionFilePathsSince" });
    return [];
  }
}

/**
 * Returns the maximum mtime (in epoch-ms) of the given file paths, or undefined if none exist.
 * Used to track the newest session timestamp for scan cursors.
 */
function getMaxMtime(filePaths: string[]): number | undefined {
  let maxMtime: number | undefined;
  for (const p of filePaths) {
    try {
      const mtime = statSync(p).mtimeMs;
      if (maxMtime === undefined || mtime > maxMtime) {
        maxMtime = mtime;
      }
    } catch (err) {
      // Ignore files that can't be stat'd
    }
  }
  return maxMtime;
}

/**
 * Apply the 23h startup guard and concurrency lock for a scan type.
 * Returns a skip reason string if the scan should be skipped, or null if it can proceed.
 * If it can proceed, marks the scan as in-progress (caller must call clearScanLock when done).
 */
function acquireScanSlot(
  scanType: string,
  lastRunAt: number | undefined,
  logger: { info?: (s: string) => void },
): string | null {
  if (SCAN_IN_PROGRESS.get(scanType)) {
    const msg = `Skipping ${scanType}: already running`;
    logger.info?.(msg);
    return msg;
  }
  if (lastRunAt !== undefined && lastRunAt !== 0 && Date.now() - lastRunAt < SCAN_MIN_INTERVAL_MS) {
    const hoursAgo = ((Date.now() - lastRunAt) / 3_600_000).toFixed(1);
    const msg = `Skipping ${scanType}: last run was ${hoursAgo}h ago (threshold: 23h). Use --full to override.`;
    logger.info?.(msg);
    return msg;
  }
  SCAN_IN_PROGRESS.set(scanType, true);
  return null;
}

function clearScanLock(scanType: string): void {
  SCAN_IN_PROGRESS.delete(scanType);
}

/**
 * Extract procedures from sessions
 */
export async function runExtractProceduresForCli(
  ctx: HandlerContext,
  opts: { sessionDir?: string; days?: number; dryRun: boolean; verbose?: boolean; full?: boolean },
): Promise<ExtractProceduresResult> {
  const { factsDb, cfg, logger } = ctx;
  const SCAN_TYPE = "extract-procedures";
  if (cfg.procedures?.enabled === false) {
    return { sessionsScanned: 0, proceduresStored: 0, positiveCount: 0, negativeCount: 0, dryRun: opts.dryRun };
  }
  const sessionDir = opts.sessionDir ?? cfg.procedures.sessionsDir;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when not full mode)
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip) return { sessionsScanned: 0, proceduresStored: 0, positiveCount: 0, negativeCount: 0, dryRun: false, skipped: true };
  }

  let filePaths: string[] | undefined;
  if (!opts.full && cursor) {
    // Incremental: only sessions modified after the last processed session timestamp
    filePaths = getSessionFilePathsSince(sessionDir, opts.days ?? 7, cursor.lastSessionTs);
    logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
  } else if (opts.days != null && opts.days > 0) {
    filePaths = getSessionFilePathsSince(sessionDir, opts.days);
  }

  try {
    const result = await extractProceduresFromSessions(
      factsDb,
      {
        sessionDir: filePaths ? undefined : sessionDir,
        filePaths,
        minSteps: cfg.procedures.minSteps,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      },
      { info: (s) => logger.info?.(s) ?? console.log(s), warn: (s) => logger.warn?.(s) ?? console.warn(s) },
    );
    if (!opts.dryRun) {
      let lastSessionTs: number | undefined;
      if (filePaths) {
        lastSessionTs = getMaxMtime(filePaths);
      } else {
        const allFiles = getSessionFilePathsSince(sessionDir, 0);
        lastSessionTs = getMaxMtime(allFiles);
      }
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return result;
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractProceduresForCli" });
    throw err;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Generate auto-skills from procedures
 */
export async function runGenerateAutoSkillsForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; verbose?: boolean },
): Promise<GenerateAutoSkillsResult> {
  const { factsDb, cfg, logger } = ctx;
  const info = opts.verbose ? (s: string) => logger.info?.(s) ?? console.log(s) : () => {};
  const warn = (s: string) => logger.warn?.(s) ?? console.warn(s);
  try {
    return generateAutoSkills(
      factsDb,
      {
        skillsAutoPath: cfg.procedures.skillsAutoPath,
        validationThreshold: cfg.procedures.validationThreshold,
        skillTTLDays: cfg.procedures.skillTTLDays,
        dryRun: opts.dryRun,
      },
      { info, warn },
    );
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runGenerateAutoSkillsForCli" });
    throw err;
  }
}

/**
 * Memory-to-skills: cluster procedures, synthesize SKILL.md drafts (issue #114).
 */
export async function runSkillsSuggestForCli(
  ctx: HandlerContext,
  opts: { dryRun?: boolean; apply?: boolean; days?: number; verbose?: boolean },
): Promise<SkillsSuggestResult> {
  const { factsDb, embeddings, openai, cfg, logger } = ctx;
  if (!cfg.memoryToSkills.enabled) {
    return {
      proceduresCollected: 0,
      clustersConsidered: 0,
      qualifyingClusters: 0,
      pathsWritten: [],
      skippedOther: 0,
      skippedDuplicate: 0,
      drafts: [],
    };
  }
  const cronCfg = getCronModelConfig(cfg);
  const defaultPref = getLLMModelPreference(cronCfg, "default");
  const model = defaultPref[0] ?? getDefaultCronModel(cronCfg, "default");
  const fallbackModels = defaultPref.length > 1 ? defaultPref.slice(1) : [];
  const info = opts.verbose ? (s: string) => logger.info?.(s) ?? console.log(s) : () => {};
  const warn = (s: string) => logger.warn?.(s) ?? console.warn(s);
  const windowDays = opts.days ?? cfg.memoryToSkills.windowDays;
  const workspaceRoot = process.env.OPENCLAW_WORKSPACE || process.cwd();
  const writeByDefault = cfg.memoryToSkills.writeByDefault === true;
  const dryRun = opts.dryRun === true ? true : opts.apply === true ? false : !writeByDefault;
  try {
    return await runMemoryToSkills(
      factsDb,
      embeddings,
      openai,
      cfg.memoryToSkills,
      {
        windowDays,
        minInstances: cfg.memoryToSkills.minInstances,
        consistencyThreshold: cfg.memoryToSkills.consistencyThreshold,
        outputDir: cfg.memoryToSkills.outputDir,
        workspaceRoot: workspaceRoot || undefined,
        dryRun,
        verbose: opts.verbose,
        model,
        fallbackModels,
      },
      { info, warn },
    );
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runSkillsSuggestForCli" });
    throw err;
  }
}

/**
 * Extract directives from sessions
 */
export async function runExtractDirectivesForCli(
  ctx: HandlerContext,
  opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean },
): Promise<DirectiveExtractResult & { stored?: number }> {
  const { factsDb, cfg, logger } = ctx;
  const SCAN_TYPE = "extract-directives";
  const sessionDir = cfg.procedures.sessionsDir;
  const days = opts.days ?? 3;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when not full mode)
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip) return { incidents: [], sessionsScanned: 0, stored: 0, skipped: true } as DirectiveExtractResult & { stored?: number; skipped?: boolean };
  }

  try {
    let filePaths: string[];
    if (!opts.full && cursor) {
      filePaths = getSessionFilePathsSince(sessionDir, days, cursor.lastSessionTs);
      logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
    } else {
      filePaths = getSessionFilePathsSince(sessionDir, days);
    }

    const directiveRegex = getDirectiveSignalRegex();
    const result = runDirectiveExtract({ filePaths, directiveRegex });

    if (opts.verbose) {
      for (const incident of result.incidents) {
        console.log(`[${incident.sessionFile}] ${incident.categories.join(", ")}: ${incident.extractedRule}`);
      }
    }

    // Store directives as facts if not dry-run
    let stored = 0;
    if (!opts.dryRun) {
      for (const incident of result.incidents) {
        try {
          if (factsDb.hasDuplicate(incident.extractedRule)) continue;
          const category = incident.categories.includes("preference") ? "preference" :
                          incident.categories.includes("absolute_rule") ? "rule" :
                          incident.categories.includes("conditional_rule") ? "rule" :
                          incident.categories.includes("warning") ? "rule" :
                          incident.categories.includes("future_behavior") ? "rule" :
                          incident.categories.includes("procedural") ? "pattern" :
                          incident.categories.includes("correction") ? "decision" :
                          incident.categories.includes("implicit_correction") ? "decision" :
                          incident.categories.includes("explicit_memory") ? "fact" : "other";
          factsDb.store({
            text: incident.extractedRule,
            category: category as MemoryCategory,
            importance: 0.8,
            entity: null,
            key: null,
            value: null,
            source: `directive:${incident.sessionFile}`,
            confidence: incident.confidence,
          });
          stored++;
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDirectivesForCli:store" });
        }
      }
    }

    const returnVal = { ...result, stored };
    if (!opts.dryRun) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return returnVal;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Extract reinforcement signals from sessions
 */
export async function runExtractReinforcementForCli(
  ctx: HandlerContext,
  opts: { days?: number; verbose?: boolean; dryRun?: boolean; workspace?: string; full?: boolean },
): Promise<ReinforcementExtractResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, proposalsDb, logger } = ctx;
  const SCAN_TYPE = "extract-reinforcement";
  const sessionDir = cfg.procedures.sessionsDir;
  const days = opts.days ?? 3;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip) return { incidents: [], sessionsScanned: 0, skipped: true } as ReinforcementExtractResult & { skipped?: boolean };
  }

  try {
    let filePaths: string[];
    if (!opts.full && cursor) {
      filePaths = getSessionFilePathsSince(sessionDir, days, cursor.lastSessionTs);
      logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
    } else {
      filePaths = getSessionFilePathsSince(sessionDir, days);
    }
    const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");

  const reinforcementRegex = getReinforcementSignalRegex();
  const result = runReinforcementExtract({ filePaths, reinforcementRegex });

  if (opts.verbose) {
    for (const incident of result.incidents) {
      console.log(`[${incident.sessionFile}] Confidence ${incident.confidence.toFixed(2)}: ${incident.userMessage.slice(0, 80)}`);
    }
  }

  const scCfg = cfg.selfCorrection;
  const runLLMAnalysis = scCfg?.reinforcementLLMAnalysis !== false && result.incidents.length > 0 && !opts.dryRun;
  let analysisCategory: string | undefined;

  // LLM analysis step — mirrors self-correction pipeline (#260)
  if (runLLMAnalysis) {
    type ReinforcementRemediation = {
      category: string;
      severity: string;
      remediationType: string;
      remediationContent: string | { text?: string; entity?: string; key?: string; tags?: string[]; taskPattern?: string; targetFile?: string; suggestedChange?: string };
    };
    let analysed: ReinforcementRemediation[] = [];
    try {
      const prompt = fillPrompt(loadPrompt("reinforcement-analyze"), {
        incidents_json: JSON.stringify(result.incidents),
      });
      const extractionTier = cfg.distill?.extractionModelTier ?? "nano";
      const cronCfg = getCronModelConfig(cfg);
      const tierPref = getLLMModelPreference(cronCfg, extractionTier);
      const model = tierPref[0] ?? getDefaultCronModel(cronCfg, extractionTier);
      const fallbackModels = tierPref.length > 1 ? tierPref.slice(1) : (cfg.distill?.fallbackModels ?? []);
      const content = await chatCompleteWithRetry({
        model,
        content: prompt,
        temperature: 0.2,
        maxTokens: distillMaxOutputTokens(model),
        openai,
        fallbackModels,
        label: "memory-hybrid: reinforcement analyze",
      });
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        analysed = JSON.parse(jsonMatch[0]) as ReinforcementRemediation[];
        analysisCategory = analysed.find((a) => a.category && a.remediationType !== "NO_ACTION")?.category;
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runExtractReinforcementForCli:llm-analysis" });
    }

    const toolsPath = join(workspaceRoot, "TOOLS.md");
    const positiveRulesSection = scCfg?.positiveRulesSection ?? "Positive Reinforcement Rules";
    const semanticThreshold = scCfg?.semanticDedupThreshold ?? 0.92;
    const semanticDedup = scCfg?.semanticDedup !== false;
    const toProposals = scCfg?.reinforcementToProposals !== false;

    for (const a of analysed) {
      if (a.remediationType === "NO_ACTION") continue;
      try {
        if (a.remediationType === "POSITIVE_RULE") {
          const line = typeof a.remediationContent === "string" ? a.remediationContent : (a.remediationContent as { text?: string })?.text ?? "";
          if (!line.trim()) continue;

          // Exact text dedup: skip if the rule already appears in TOOLS.md
          if (existsSync(toolsPath)) {
            const currentTools = readFileSync(toolsPath, "utf-8");
            if (currentTools.includes(line.trim())) continue;
          }

          // Semantic dedup: skip if a similar rule exists in the vector store (#260)
          let ruleVec: number[] | null = null;
          if (semanticDedup) {
            try {
              ruleVec = await embeddings.embed(line.trim());
              if (await vectorDb.hasDuplicate(ruleVec, semanticThreshold)) {
                logger?.info?.(`memory-hybrid: reinforcement POSITIVE_RULE skipped (semantic duplicate): ${line.slice(0, 80)}`);
                continue;
              }
            } catch (err) {
              capturePluginError(err as Error, { subsystem: "cli", operation: "reinforcement:positive-rule-dedup" });
              // Fail open: still insert the rule if dedup check fails
            }
          }

          if (existsSync(toolsPath)) {
            insertRulesUnderSection(toolsPath, positiveRulesSection, [line.trim()]);
            // Store the rule embedding in vector DB for future dedup (#260)
            if (ruleVec) {
              try {
                await vectorDb.store({ text: line.trim(), vector: ruleVec, importance: CLI_STORE_IMPORTANCE, category: "technical", id: `rule-${Date.now()}-${Math.random()}` });
              } catch (err) {
                capturePluginError(err as Error, { subsystem: "cli", operation: "reinforcement:positive-rule-store" });
              }
            }
          }
        } else if (a.remediationType === "MEMORY_STORE" || a.remediationType === "PATTERN_FACT") {
          const c = a.remediationContent;
          const isPattern = a.remediationType === "PATTERN_FACT";
          const obj = typeof c === "object" && c && "text" in c ? c as { text?: string; entity?: string; key?: string; tags?: string[] } : { text: String(c) };
          const text = (obj.text ?? "").trim();
          if (!text || factsDb.hasDuplicate(text)) continue;
          let vector: number[] | null = null;
          try {
            vector = await embeddings.embed(text);
            if (semanticDedup && (await vectorDb.hasDuplicate(vector, semanticThreshold))) continue;
          } catch (err) {
            capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractReinforcementForCli:embed-dedup" });
            continue;
          }
          const tags: string[] = Array.isArray(obj.tags) ? obj.tags : [];
          if (isPattern && !tags.includes("reinforcement")) tags.push("reinforcement");
          if (isPattern && !tags.includes("behavioral")) tags.push("behavioral");
          const entry = factsDb.store({
            text,
            category: isPattern ? "pattern" : "technical",
            importance: CLI_STORE_IMPORTANCE,
            entity: obj.entity ?? null,
            key: typeof obj.key === "string" ? obj.key : null,
            value: text.slice(0, 200),
            source: "reinforcement-analysis",
            tags,
          });
          if (vector) {
            await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category: isPattern ? "pattern" : "technical", id: entry.id });
            factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
          }
        } else if (a.remediationType === "PROCEDURE_BOOST") {
          const c = a.remediationContent;
          const taskPattern = typeof c === "object" && c && "taskPattern" in c ? String((c as { taskPattern?: string }).taskPattern ?? "") : String(c);
          if (taskPattern.trim()) {
            const procs = factsDb.searchProcedures(taskPattern, 3, cfg.distill?.reinforcementProcedureBoost ?? 0.1);
            for (const proc of procs) {
              factsDb.reinforceProcedure(proc.id, taskPattern, cfg.distill?.reinforcementPromotionThreshold ?? 2);
            }
          }
        } else if (a.remediationType === "PROPOSAL" && toProposals && proposalsDb) {
          const c = a.remediationContent;
          const obj = typeof c === "object" && c ? c as { targetFile?: string; suggestedChange?: string } : {};
          const suggestedChange = obj.suggestedChange ?? (typeof c === "string" ? c : "");
          const targetFile = obj.targetFile ?? inferTargetFile(suggestedChange);
          if (suggestedChange.trim()) {
            proposalsDb.create({
              targetFile,
              title: `Reinforcement: ${a.category}`,
              observation: `Positive signal from reinforcement analysis`,
              suggestedChange: suggestedChange.trim(),
              confidence: 0.7,
              evidenceSessions: result.incidents.map((i) => i.sessionFile).filter((v, idx, arr) => arr.indexOf(v) === idx),
            });
          }
        }
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractReinforcementForCli:apply-remediation" });
      }
    }
  }

  // Annotate facts/procedures with reinforcement if not dry-run
  if (!opts.dryRun) {
    const trackContext = cfg.reinforcement?.trackContext !== false;
    const maxEventsPerFact = cfg.reinforcement?.maxEventsPerFact ?? 50;
    for (const incident of result.incidents) {
      try {
        const context: ReinforcementContext = {
          querySnippet: incident.precedingUserMessage.slice(0, 200) || incident.userMessage.slice(0, 200),
          topic: analysisCategory,
          toolSequence: incident.toolCallSequence.length > 0 ? incident.toolCallSequence : undefined,
          sessionFile: incident.sessionFile,
        };

        // Reinforce recalled memories with rich context, boosted by diversity score (#259)
        const diversityWeight = cfg.reinforcement?.diversityWeight ?? 1.0;
        const baseBoost = cfg.reinforcement?.boostAmount ?? 1.0;
        for (const memId of incident.recalledMemoryIds) {
          const diversityScore = factsDb.calculateDiversityScore(memId);
          const effectiveBoost = baseBoost * (1 - diversityWeight + diversityWeight * diversityScore);
          factsDb.reinforceFact(memId, incident.userMessage, context, { trackContext, maxEventsPerFact, boostAmount: effectiveBoost });
        }

        // Reinforce procedures based on tool call sequence
        if (incident.toolCallSequence.length >= 2) {
          const taskPattern = incident.toolCallSequence.join(" -> ");
          const procedures = factsDb.searchProcedures(taskPattern, 3, cfg.distill?.reinforcementProcedureBoost ?? 0.1);
          for (const proc of procedures) {
            factsDb.reinforceProcedure(proc.id, incident.userMessage, cfg.distill?.reinforcementPromotionThreshold ?? 2);
          }
        }
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractReinforcementForCli" });
      }
    }
  }

    if (!opts.dryRun) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return result;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Generate persona proposals from reflection insights (patterns, rules, meta).
 * Reads identity files, calls LLM to find gaps, creates proposals in DB (fixes #81).
 */
export async function runGenerateProposalsForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; verbose?: boolean },
  api: { resolvePath: (file: string) => string },
): Promise<{ created: number }> {
  const { factsDb, proposalsDb, cfg, openai } = ctx;
  if (!cfg.personaProposals.enabled || !proposalsDb) {
    return { created: 0 };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const scopeFilter = cfg.autoRecall?.scopeFilter ?? undefined;
  const allRelevant = factsDb.getAll({ scopeFilter }).filter(
    (f) => (f.category === "pattern" || f.category === "rule") && !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  if (!scopeFilter && allRelevant.length > 0) {
    ctx.logger.warn?.(
      "memory-hybrid: generate-proposals — autoRecall.scopeFilter is not set; all stored facts are included regardless of which agent or user created them. Set autoRecall.scopeFilter (e.g. agentId/userId) to restrict proposals to a specific user/agent and avoid cross-user contamination.",
    );
  }
  const patterns = allRelevant.filter((f) => f.category === "pattern");
  const rules = allRelevant.filter((f) => f.category === "rule");
  const metaPatterns = patterns.filter((f) => f.tags?.includes("meta"));
  const insights: string[] = [];
  if (patterns.length) {
    insights.push("Patterns:\n" + patterns.slice(0, 30).map((f) => `- ${f.text}`).join("\n"));
  }
  if (rules.length) {
    insights.push("Rules:\n" + rules.slice(0, 30).map((f) => `- ${f.text}`).join("\n"));
  }
  if (metaPatterns.length) {
    insights.push("Meta-patterns:\n" + metaPatterns.slice(0, 10).map((f) => `- ${f.text}`).join("\n"));
  }
  if (insights.length === 0) {
    if (opts.verbose) ctx.logger.info?.("memory-hybrid: generate-proposals — no patterns/rules/meta in memory; skipping.");
    return { created: 0 };
  }
  const insightsBlock = insights.join("\n\n");
  const allowedFiles = cfg.personaProposals.allowedFiles;
  const identityFilesContent: string[] = [];
  for (const file of allowedFiles) {
    try {
      const path = api.resolvePath(file);
      if (existsSync(path)) {
        const content = readFileSync(path, "utf-8");
        identityFilesContent.push(`--- ${file} ---\n${content.slice(0, 8000)}\n`);
      } else {
        identityFilesContent.push(`--- ${file} ---\n(file not found)\n`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "runGenerateProposalsForCli:read-file", file });
      identityFilesContent.push(`--- ${file} ---\n(error reading file)\n`);
    }
  }
  const identityFilesBlock = identityFilesContent.join("\n");
  const prompt = fillPrompt(loadPrompt("generate-proposals"), {
    allowed_files: allowedFiles.join(", "),
    min_confidence: String(cfg.personaProposals.minConfidence),
    insights: insightsBlock,
    identity_files: identityFilesBlock,
  });
  const cronCfg = getCronModelConfig(cfg);
  const pref = getLLMModelPreference(cronCfg, "heavy");
  const model = pref[0];
  const fallbackModels = pref.length > 1 ? pref.slice(1) : (cfg.llm ? [] : (cfg.distill?.fallbackModels ?? []));
  let rawResponse: string;
  try {
    rawResponse = await chatCompleteWithRetry({
      model,
      content: prompt,
      temperature: 0.3,
      maxTokens: 4000,
      openai,
      fallbackModels,
      label: "memory-hybrid: generate-proposals",
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`memory-hybrid: generate-proposals LLM call failed (model=${model}, fallbacks=${JSON.stringify(fallbackModels)}): ${errMsg}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "runGenerateProposalsForCli:llm" });
    return { created: 0 };
  }
  let items: Array<{ targetFile: string; title: string; observation: string; suggestedChange: string; confidence: number }>;
  try {
    const firstBracket = rawResponse.indexOf("[");
    const lastBracket = rawResponse.lastIndexOf("]");
    const trimmed = firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket
      ? rawResponse.substring(firstBracket, lastBracket + 1)
      : rawResponse;
    items = JSON.parse(trimmed);
    if (!Array.isArray(items)) items = [];
  } catch (err) {
    if (opts.verbose) ctx.logger.warn?.(`memory-hybrid: generate-proposals — LLM output was not valid JSON: ${rawResponse.slice(0, 200)}`);
    return { created: 0 };
  }
  const weekDays = 7;
  const recentCount = proposalsDb.countRecentProposals(weekDays);
  const limit = cfg.personaProposals.maxProposalsPerWeek;
  const minConf = cfg.personaProposals.minConfidence;
  const evidenceSessions = Array.from({ length: Math.max(1, cfg.personaProposals.minSessionEvidence) }, () => "reflection-pipeline");
  const expiresAt = cfg.personaProposals.proposalTTLDays > 0
    ? nowSec + cfg.personaProposals.proposalTTLDays * 24 * 3600
    : null;
  let created = 0;
  for (const item of items) {
    if (recentCount + created >= limit) break;
    const targetFile = String(item.targetFile ?? "").trim();
    if (!allowedFiles.includes(targetFile as any)) continue;
    const workspace = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
    const snapshot = getFileSnapshot(join(workspace, targetFile));
    let confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) continue;
    confidence = capProposalConfidence(confidence, targetFile, String(item.suggestedChange ?? ""));
    if (confidence < minConf) {
      ctx.logger.info?.(`memory-hybrid: proposal dropped — confidence ${confidence < Number(item.confidence) ? `capped to ${confidence.toFixed(2)} (below minConf ${minConf})` : `below minConf ${minConf}`}: ${String(item.title ?? "").slice(0, 80)} -> ${targetFile}`);
      continue;
    }
    const title = String(item.title ?? "Update from reflection").slice(0, 256);
    const observation = String(item.observation ?? "").slice(0, 2000);
    const suggestedChange = String(item.suggestedChange ?? "").slice(0, 50000);
    if (!suggestedChange.trim()) continue;
    if (opts.dryRun) {
      if (opts.verbose) ctx.logger.info?.(`memory-hybrid: [dry-run] would create proposal: ${title} -> ${targetFile}`);
      created++;
      continue;
    }
    try {
      proposalsDb.create({
        targetFile,
        title,
        observation,
        suggestedChange,
        confidence,
        evidenceSessions,
        expiresAt,
        targetMtimeMs: snapshot?.mtimeMs ?? null,
        targetHash: snapshot?.hash ?? null,
      });
      created++;
      if (opts.verbose) ctx.logger.info?.(`memory-hybrid: proposal created: ${title} -> ${targetFile}`);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "runGenerateProposalsForCli:create" });
    }
  }
  return { created };
}

/**
 * Extract facts from daily memory markdown files
 */
export async function runExtractDailyForCli(
  ctx: HandlerContext,
  opts: { days: number; dryRun: boolean; verbose?: boolean },
  sink: ExtractDailySink,
): Promise<ExtractDailyResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, aliasDb } = ctx;
  const memoryDir = join(homedir(), ".openclaw", "memory");
  const daysBack = opts.days;
  let totalExtracted = 0;
  let totalStored = 0;
  for (let d = 0; d < daysBack; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split("T")[0];
    const filePath = join(memoryDir, `${dateStr}.md`);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l: string) => l.trim().length > 10);
    sink.log(`\nScanning ${dateStr} (${lines.length} lines)...`);
    for (const line of lines) {
      const trimmed = line.replace(/^[-*#>\s]+/, "").trim();
      if (trimmed.length < 15 || trimmed.length > 500) continue;
      const category = ctx.detectCategory(trimmed);
      const extracted = extractStructuredFields(trimmed, category);
      if (isCredentialLike(trimmed, extracted.entity, extracted.key, extracted.value)) {
        if (cfg.credentials.enabled && credentialsDb) {
          const parsed = tryParseCredentialForVault(trimmed, extracted.entity, extracted.key, extracted.value, {
            requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
          });
          if (parsed) {
            totalExtracted++;
            if (!opts.dryRun) {
              let storedInVault = false;
              try {
                const stored = credentialsDb.storeIfNew({
                  service: parsed.service,
                  type: parsed.type as any,
                  value: parsed.secretValue,
                  url: parsed.url,
                  notes: parsed.notes,
                });
                if (!stored) {
                  continue;
                }
                storedInVault = true;
                const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
                const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                const pointerEntry = factsDb.store({
                  text: pointerText,
                  category: "technical",
                  importance: BATCH_STORE_IMPORTANCE,
                  entity: "Credentials",
                  key: parsed.service,
                  value: `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`,
                  source: `daily-scan:${dateStr}`,
                  sourceDate: sourceDateSec,
                  tags: ["auth", ...extractTags(pointerText, "Credentials")],
                });
                try {
                  const vector = await embeddings.embed(pointerText);
                  factsDb.setEmbeddingModel(pointerEntry.id, embeddings.modelName);
                  if (!(await vectorDb.hasDuplicate(vector))) {
                    await vectorDb.store({ text: pointerText, vector, importance: BATCH_STORE_IMPORTANCE, category: "technical", id: pointerEntry.id });
                  }
                } catch (err) {
                  sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                  capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:vector-store" });
                }
                totalStored++;
              } catch (err) {
                if (storedInVault) {
                  try {
                    credentialsDb.delete(parsed.service, parsed.type as any);
                  } catch (cleanupErr) {
                    sink.warn(`memory-hybrid: Failed to clean up orphaned credential for ${parsed.service}: ${cleanupErr}`);
                    capturePluginError(cleanupErr as Error, { subsystem: "cli", operation: "runExtractDailyForCli:credential-compensating-delete" });
                  }
                }
                capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:credential-store" });
              }
            }
            // Skip normal fact-storage path — this line has been handled as a credential.
            continue;
          }
          // isCredentialLike but vault parse failed — skip this line entirely.
          continue;
        }
      }
      if (!extracted.entity && !extracted.key && category !== "decision") continue;
      totalExtracted++;
      if (opts.dryRun) {
        sink.log(
          `  [${category}] ${extracted.entity || "?"} / ${extracted.key || "?"} = ${
            extracted.value || trimmed.slice(0, 60)
          }`,
        );
        continue;
      }
      if (factsDb.hasDuplicate(trimmed)) continue;
      const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
      const storePayload = {
        text: trimmed,
        category,
        importance: BATCH_STORE_IMPORTANCE,
        entity: extracted.entity,
        key: extracted.key,
        value: extracted.value,
        source: `daily-scan:${dateStr}` as const,
        sourceDate: sourceDateSec,
        tags: extractTags(trimmed, extracted.entity),
      };
      let vecForStore: number[] | undefined;
      if (cfg.store.classifyBeforeWrite) {
        try {
          vecForStore = await embeddings.embed(trimmed);
        } catch (err) {
          sink.warn(`memory-hybrid: extract-daily embedding failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:embed" });
        }
        if (vecForStore) {
          let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vecForStore, 3);
          if (similarFacts.length === 0) {
            similarFacts = factsDb.findSimilarForClassification(trimmed, extracted.entity, extracted.key, 3);
          }
          if (similarFacts.length > 0) {
            try {
              const classification = await classifyMemoryOperation(
                trimmed, extracted.entity, extracted.key, similarFacts,
                openai, cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano"), sink,
              );
              if (classification.action === "NOOP") continue;
              if (classification.action === "DELETE" && classification.targetId) {
                factsDb.supersede(classification.targetId, null);
                aliasDb?.deleteByFactId(classification.targetId);
                continue;
              }
              if (classification.action === "UPDATE" && classification.targetId) {
                const oldFact = factsDb.getById(classification.targetId);
                if (oldFact) {
                  const newEntry = factsDb.store({
                    ...storePayload,
                    entity: extracted.entity ?? oldFact.entity,
                    key: extracted.key ?? oldFact.key,
                    value: extracted.value ?? oldFact.value,
                    validFrom: sourceDateSec,
                    supersedesId: classification.targetId,
                  });
                  factsDb.supersede(classification.targetId, newEntry.id);
                  aliasDb?.deleteByFactId(classification.targetId);
                  try {
                    factsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
                    if (!(await vectorDb.hasDuplicate(vecForStore))) {
                      await vectorDb.store({ text: trimmed, vector: vecForStore, importance: BATCH_STORE_IMPORTANCE, category, id: newEntry.id });
                    }
                  } catch (err) {
                    sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                    capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:vector-store-update" });
                  }
                  totalStored++;
                  continue;
                }
              }
            } catch (err) {
              sink.warn(`memory-hybrid: extract-daily classification failed: ${err}`);
              capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:classify" });
            }
          }
        }
      }
      const entry = factsDb.store(storePayload);
      try {
        const vector = vecForStore ?? await embeddings.embed(trimmed);
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        if (!(await vectorDb.hasDuplicate(vector))) {
          await vectorDb.store({ text: trimmed, vector, importance: BATCH_STORE_IMPORTANCE, category, id: entry.id });
        }
      } catch (err) {
        sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:vector-store-final" });
      }
      totalStored++;
    }
  }
  return { totalExtracted, totalStored, daysBack, dryRun: opts.dryRun };
}

/**
 * Gather backfill files from workspace
 */
function gatherBackfillFiles(workspaceRoot: string): Array<{ path: string; label: string }> {
  const memoryDir = join(workspaceRoot, "memory");
  const memoryMd = join(workspaceRoot, "MEMORY.md");
  const out: Array<{ path: string; label: string }> = [];
  if (existsSync(memoryMd)) out.push({ path: memoryMd, label: "MEMORY.md" });
  if (!existsSync(memoryDir)) return out;
  function walk(dir: string, rel = "memory"): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const relPath = join(rel, e.name);
      if (e.isDirectory()) {
        try {
          walk(full, relPath);
        } catch (err) {
          capturePluginError(err as Error, {
            operation: 'walk-directory',
            severity: 'info',
            subsystem: 'cli'
          });
          /* ignore */
        }
      } else if (e.name.endsWith(".md")) out.push({ path: full, label: relPath });
    }
  }
  walk(memoryDir);
  return out;
}

/**
 * Extract fact from backfill line
 */
function extractBackfillFact(line: string): { text: string; category: string; entity: string | null; key: string | null; value: string; source_date: string | null } | null {
  let t = line.replace(/^[-*#>\s]+/, "").trim();
  const datePrefix = /^\[(\d{4}-\d{2}-\d{2})\]\s*/;
  let source_date: string | null = null;
  const match = t.match(datePrefix);
  if (match) {
    source_date = match[1];
    t = t.slice(match[0].length).trim();
  }
  if (t.length < 10 || t.length > 500) return null;
  const lower = t.toLowerCase();
  if (/\b(api[_-]?key|password|secret|token)\s*[:=]/i.test(t)) return null;
  if (/^(see\s|---|```|\s*$)/.test(t) || t.split(/\s+/).length < 2) return null;

  let entity: string | null = null;
  let key: string | null = null;
  let value: string;
  let category = "other";

  const decisionMatch = t.match(
    /(?:decided|chose|picked|went with)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for)\s+(.+?))?\.?$/i
  );
  const decisionMatchSv = t.match(
    /(?:bestämde|valde)\s+(?:att\s+(?:använda\s+)?)?(.+?)(?:\s+(?:eftersom|för att)\s+(.+?))?\.?$/i
  );
  if (decisionMatch) {
    entity = "decision";
    key = decisionMatch[1].trim().slice(0, 100);
    value = (decisionMatch[2] || "no rationale").trim();
    category = "decision";
  } else if (decisionMatchSv) {
    entity = "decision";
    key = decisionMatchSv[1].trim().slice(0, 100);
    value = (decisionMatchSv[2] || "no rationale").trim();
    category = "decision";
  } else {
    const ruleMatch = t.match(/(?:always|never|alltid|aldrig)\s+(.+?)\.?$/i);
    if (ruleMatch) {
      entity = "convention";
      key = ruleMatch[1].trim().slice(0, 100);
      value = lower.includes("never") || lower.includes("aldrig") ? "never" : "always";
      category = "preference";
    } else {
      const possessiveMatch = t.match(
        /(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/
      );
      const possessiveMatchSv = t.match(/(?:mitt|min)\s+(\S+)\s+är\s+(.+?)\.?$/i);
      if (possessiveMatch) {
        entity = possessiveMatch[1] || "user";
        key = possessiveMatch[2].trim();
        value = possessiveMatch[3].trim();
        category = "fact";
      } else if (possessiveMatchSv) {
        entity = "user";
        key = possessiveMatchSv[1].trim();
        value = possessiveMatchSv[2].trim();
        category = "fact";
      } else {
        const preferMatch = t.match(
          /[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/
        );
        const preferMatchSv = t.match(/jag\s+(föredrar|gillar|ogillar|vill ha|behöver)\s+(.+?)\.?$/i);
        if (preferMatch) {
          entity = "user";
          key = preferMatch[1];
          value = preferMatch[2].trim();
          category = "preference";
        } else if (preferMatchSv) {
          entity = "user";
          key = preferMatchSv[1];
          value = preferMatchSv[2].trim();
          category = "preference";
        } else {
          const templateResult = tryExtractionFromTemplates(getExtractionTemplates(), t);
          if (templateResult && templateResult.entity && templateResult.value) {
            entity = templateResult.entity;
            key = templateResult.key;
            value = templateResult.value;
            if (entity === "decision") category = "decision";
            else if (entity === "convention") category = "preference";
            else if (entity === "user" && key) category = "preference";
            else category = "fact";
          } else {
            value = t.slice(0, 200);
          }
        }
      }
    }
  }
  return { text: t, category, entity, key, value, source_date };
}

/**
 * Backfill facts from workspace memory files
 */
export async function runBackfillForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; workspace?: string; limit?: number },
  sink: BackfillCliSink,
): Promise<BackfillCliResult> {
  const { factsDb, vectorDb, embeddings } = ctx;
  const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  const files = gatherBackfillFiles(workspaceRoot);
  if (files.length === 0) {
    sink.log(`No MEMORY.md or memory/**/*.md under ${workspaceRoot}`);
    return { stored: 0, skipped: 0, candidates: 0, files: 0, dryRun: opts.dryRun };
  }
  const allCandidates: Array<{ text: string; category: string; entity: string | null; key: string | null; value: string; source_date: string | null; source: string }> = [];
  for (const { path: filePath, label } of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const fact = extractBackfillFact(trimmed);
        if (fact) allCandidates.push({ ...fact, source: label });
      }
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runBackfillForCli:read-file", filePath });
    }
  }
  if (opts.dryRun) {
    sink.log(`Would process ${allCandidates.length} facts from ${files.length} files under ${workspaceRoot}`);
    return { stored: 0, skipped: 0, candidates: allCandidates.length, files: files.length, dryRun: true };
  }
  const limit = opts.limit ?? 0;
  let stored = 0;
  let skipped = 0;
  const progress = createProgressReporter(sink, allCandidates.length, "Backfilling");
  const sourceDateSec = (s: string | null) => {
    if (!s || typeof s !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const sec = Math.floor(ms / 1000);
    return isNaN(sec) ? null : sec;
  };
  let processed = 0;
  for (const fact of allCandidates) {
    if (limit > 0 && stored >= limit) break;
    progress.update(processed + 1);
    if (factsDb.hasDuplicate(fact.text)) {
      skipped++;
      processed++;
      continue;
    }
    try {
      const entry = factsDb.store({
        text: fact.text,
        category: fact.category as MemoryCategory,
        importance: 0.8,
        entity: fact.entity,
        key: fact.key,
        value: fact.value,
        source: `backfill:${fact.source}`,
        sourceDate: sourceDateSec(fact.source_date),
      });
      try {
        const vector = await embeddings.embed(fact.text);
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        if (!(await vectorDb.hasDuplicate(vector))) {
          await vectorDb.store({
            text: fact.text,
            vector,
            importance: 0.8,
            category: fact.category,
            id: entry.id,
          });
        }
      } catch (err) {
        sink.warn(`memory-hybrid: backfill vector store failed for "${fact.text.slice(0, 50)}...": ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runBackfillForCli:vector-store" });
      }
      stored++;
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runBackfillForCli:store-fact" });
    }
    processed++;
  }
  progress.done();
  return { stored, skipped, candidates: allCandidates.length, files: files.length, dryRun: opts.dryRun };
}

/**
 * Gather session files from agents directory.
 * When `sinceTimestampMs` is provided (watermark mode), returns only files with mtime > sinceTimestampMs.
 */
function gatherSessionFiles(opts: { all?: boolean; days?: number; since?: string; sinceTimestampMs?: number }): Array<{ path: string; mtime: number }> {
  const openclawDir = join(homedir(), ".openclaw");
  const agentsDir = join(openclawDir, "agents");
  if (!existsSync(agentsDir)) return [];
  const cutoffMs =
    opts.sinceTimestampMs !== undefined
      ? opts.sinceTimestampMs
      : opts.since
        ? new Date(opts.since).getTime()
        : Date.now() - (opts.all ? 90 : (opts.days ?? 3)) * 24 * 60 * 60 * 1000;
  const out: Array<{ path: string; mtime: number }> = [];
  try {
    for (const agentName of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentName.isDirectory()) continue;
      const sessionsDir = join(agentsDir, agentName.name, "sessions");
      if (!existsSync(sessionsDir)) continue;
      for (const f of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".jsonl") || f.name.startsWith(".deleted")) continue;
        const fp = join(sessionsDir, f.name);
        try {
          const stat = statSync(fp);
          if (stat.mtimeMs > cutoffMs) out.push({ path: fp, mtime: stat.mtimeMs });
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "gatherSessionFiles:stat", filePath: fp });
        }
      }
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "gatherSessionFiles" });
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

/**
 * Extract text content from session JSONL file
 */
function extractTextFromSessionJsonl(filePath: string): string {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (obj.type !== "message" || !obj.message) continue;
      const msg = obj.message;
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          parts.push(block.text.trim());
        }
      }
    } catch {
      // NOTE: Intentionally NOT using capturePluginError here to avoid flooding
      // error logs with JSON parse errors from malformed session lines.
      // This is a best-effort parser; we skip bad lines silently.
    }
  }
  return parts.join("\n\n");
}

/** Extract raw user message texts from a session file (for regex/sentiment). */
function extractUserMessageTextsFromSessionJsonl(filePath: string): string[] {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (!obj || typeof obj !== "object") continue;
      if (obj.type !== "message" || !obj.message || obj.message.role !== "user") continue;
      const content = obj.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          out.push(block.text.trim());
        }
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

const SENTIMENT_BATCH_SIZE = 40;
const SENTIMENT_MSG_MAX_CHARS = 200;

/**
 * Analyze session logs with an LLM to discover user-specific praise/frustration phrases.
 * Uses a cheap (nano-tier) model first to filter by sentiment; only pre-filtered messages go to the heavy-tier model.
 * Model-agnostic: nano and heavy models come from config (llm.nano / llm.default and llm.heavy).
 * When --days is omitted: first run uses 30 days, subsequent runs use 3 days (for weekly nightly).
 */
export async function runAnalyzeFeedbackPhrasesForCli(
  ctx: HandlerContext,
  opts: { days?: number; model?: string; outputPath?: string; learn?: boolean },
): Promise<{ reinforcement: string[]; correction: string[]; sessionsScanned: number; learned?: boolean; error?: string }> {
  const { cfg, logger, openai } = ctx;
  const existing = loadUserFeedbackPhrases();
  const effectiveDays = opts.days ?? (existing.initialRunDone ? 3 : 30);
  const sessionFiles = gatherSessionFiles({ days: effectiveDays });
  if (sessionFiles.length === 0) {
    return { reinforcement: [], correction: [], sessionsScanned: 0, error: "No session files found under ~/.openclaw/agents/*/sessions/ in the last " + effectiveDays + " days." };
  }

  const reinforcementRegex = getReinforcementSignalRegex();
  const correctionRegex = getCorrectionSignalRegex();
  const allTexts: string[] = [];
  for (const { path: fp } of sessionFiles) {
    try {
      allTexts.push(...extractUserMessageTextsFromSessionJsonl(fp));
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runAnalyzeFeedbackPhrasesForCli:read-session" });
    }
  }
  const unmatched = allTexts.filter((text) => {
    reinforcementRegex.lastIndex = 0;
    correctionRegex.lastIndex = 0;
    return !reinforcementRegex.test(text) && !correctionRegex.test(text);
  });

  let toAnalyze: string[] = [];
  if (unmatched.length > 0) {
    const nanoPref = getLLMModelPreference(getCronModelConfig(cfg), "nano");
    const nanoModel = nanoPref[0] ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
    const labels: string[] = [];
    for (let i = 0; i < unmatched.length; i += SENTIMENT_BATCH_SIZE) {
      const batch = unmatched.slice(i, i + SENTIMENT_BATCH_SIZE);
      const truncated = batch.map((t) => t.slice(0, SENTIMENT_MSG_MAX_CHARS).replace(/\n/g, " "));
      const prompt =
        "For each of the following user messages (one per line), output exactly one word per line in the same order: positive_feedback, negative_feedback, or neutral. Output ONLY one word per line, no preamble, no explanation.\n\n" +
        truncated.join("\n");
      try {
        const content = await chatCompleteWithRetry({
          model: nanoModel,
          content: prompt,
          temperature: 0,
          maxTokens: 500,
          openai,
          fallbackModels: nanoPref.length > 1 ? nanoPref.slice(1) : undefined,
          label: "memory-hybrid: feedback-phrases sentiment",
        });
        const lines = (content ?? "").split(/\r?\n/).map((l) => l.trim().toLowerCase());
        if (lines.length < batch.length) {
          logger.warn?.(`memory-hybrid: sentiment model returned ${lines.length} lines for batch of ${batch.length}; some messages may default to neutral`);
        }
        for (let j = 0; j < batch.length; j++) {
          const word = lines[j] ?? "";
          if (word.includes("positive")) labels.push("positive_feedback");
          else if (word.includes("negative")) labels.push("negative_feedback");
          else labels.push("neutral");
        }
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runAnalyzeFeedbackPhrasesForCli:sentiment" });
        labels.push(...batch.map(() => "neutral"));
      }
    }
    toAnalyze = unmatched.filter((_, idx) => labels[idx] !== "neutral");
  }

  if (toAnalyze.length === 0) {
    return { reinforcement: [], correction: [], sessionsScanned: sessionFiles.length };
  }

  const maxChars = 400_000;
  const userMessagesBlock = toAnalyze.map((t) => "User: " + t).join("\n");
  const truncatedBlock = userMessagesBlock.length > maxChars ? userMessagesBlock.slice(0, maxChars) + "\n[truncated...]" : userMessagesBlock;
  const prompt = fillPrompt(loadPrompt("analyze-feedback-phrases"), { user_messages: truncatedBlock });
  const cronCfg = getCronModelConfig(cfg);
  const defaultPref = getLLMModelPreference(cronCfg, "default");
  const model = opts.model ?? defaultPref[0] ?? getDefaultCronModel(cronCfg, "default");
  const { spawn } = await import("node:child_process");
  const { tmpdir: osTmp } = await import("node:os");
  const promptPath = join(osTmp(), `analyze-feedback-phrases-${Date.now()}.txt`);
  writeFileSync(promptPath, prompt, "utf-8");
  try {
    // Build args conditionally: only add --model if model is truthy (avoids passing "undefined" string)
    const spawnArgs = ["sessions", "spawn"];
    if (model) spawnArgs.push("--model", model);
    spawnArgs.push("--message", "Analyze the attached file and output ONLY a JSON object with keys reinforcement and correction (arrays of strings). No markdown, no code fences.", "--attach", promptPath);
    // Use async spawn to avoid blocking the event loop during the LLM call (which may take 60–120+ seconds).
    // Stream accumulation removes the 2 MB maxBuffer ceiling of spawnSync.
    const r = await new Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const child = spawn("openclaw", spawnArgs, { shell: process.platform === "win32" });
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (err: Error) => resolve({ stdout: "", stderr: "", status: null, error: err }));
      child.on("close", (code: number | null) => resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        status: code,
      }));
    });
    if (r.error) {
      return { reinforcement: [], correction: [], sessionsScanned: sessionFiles.length, error: `sessions spawn failed: ${r.error.message}` };
    }
    const content = (r.stdout ?? "") + (r.stderr ?? "");
    if (r.status !== 0) {
      return { reinforcement: [], correction: [], sessionsScanned: sessionFiles.length, error: `sessions spawn exited ${r.status}: ${content.slice(0, 500)}` };
    }
    // Robust JSON extraction: try full parse first, then locate first {...} block regardless of key order
    let reinforcement: string[] = [];
    let correction: string[] = [];
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return { reinforcement: [], correction: [], sessionsScanned: sessionFiles.length, error: "LLM returned empty output" };
    }
    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(trimmedContent);
    } catch {
      const braceStart = trimmedContent.indexOf("{");
      const braceEnd = trimmedContent.lastIndexOf("}");
      if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
        return { reinforcement: [], correction: [], sessionsScanned: sessionFiles.length, error: "Failed to locate JSON object in LLM output: " + trimmedContent.slice(0, 500) };
      }
      try {
        parsedOutput = JSON.parse(trimmedContent.slice(braceStart, braceEnd + 1));
      } catch (e) {
        return { reinforcement: [], correction: [], sessionsScanned: sessionFiles.length, error: "Failed to parse LLM JSON: " + String(e) };
      }
    }
    if (parsedOutput !== null && typeof parsedOutput === "object") {
      const obj = parsedOutput as { reinforcement?: unknown; correction?: unknown };
      if (Array.isArray(obj.reinforcement)) {
        reinforcement = obj.reinforcement.filter((s) => typeof s === "string" && s.trim()) as string[];
      }
      if (Array.isArray(obj.correction)) {
        correction = obj.correction.filter((s) => typeof s === "string" && s.trim()) as string[];
      }
    }
    if (opts.outputPath) {
      try {
        mkdirSync(dirname(opts.outputPath), { recursive: true });
        writeFileSync(opts.outputPath, JSON.stringify({ reinforcement, correction, sessionsScanned: sessionFiles.length }, null, 2), "utf-8");
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runAnalyzeFeedbackPhrasesForCli:write-output" });
      }
    }
    let learned = false;
    if (opts.learn) {
      const merged = {
        reinforcement: [...new Set([...existing.reinforcement, ...reinforcement])],
        correction: [...new Set([...existing.correction, ...correction])],
      };
      saveUserFeedbackPhrases(merged);
      learned = reinforcement.length > 0 || correction.length > 0;
      if (learned) {
        logger.info?.(`memory-hybrid: saved ${merged.reinforcement.length} reinforcement and ${merged.correction.length} correction phrases to .user-feedback-phrases.json`);
      }
    } else if (!existing.initialRunDone) {
      // Persist initialRunDone even without --learn so the 30→3-day auto-window works on subsequent runs
      saveUserFeedbackPhrases(existing);
    }
    return { reinforcement, correction, sessionsScanned: sessionFiles.length, learned };
  } finally {
    try {
      if (existsSync(promptPath)) rmSync(promptPath, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Ingest files from workspace
 */
export async function runIngestFilesForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; workspace?: string; paths?: string[] },
  sink: IngestFilesSink,
): Promise<IngestFilesResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg } = ctx;
  const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? process.cwd();
  const ingestCfg = cfg.ingest;
  const patterns = opts.paths?.length
    ? opts.paths
    : ingestCfg?.paths?.length
      ? ingestCfg.paths
      : DEFAULT_INGEST_PATHS;
  const chunkSize = ingestCfg?.chunkSize ?? 800;
  const overlap = ingestCfg?.overlap ?? 100;

  const files = gatherIngestFiles(workspaceRoot, patterns);
  if (files.length === 0) {
    sink.log(`No markdown files found for patterns: ${patterns.join(", ")} under ${workspaceRoot}`);
    return { stored: 0, skipped: 0, extracted: 0, files: 0, dryRun: opts.dryRun };
  }

  const cronCfgIngest = getCronModelConfig(cfg);
  const ingestPref = getLLMModelPreference(cronCfgIngest, "default");
  const model = ingestPref[0] ?? cfg.distill?.defaultModel ?? "gemini-3-pro-preview";
  const ingestFallbacks = ingestPref.length > 1 ? ingestPref.slice(1) : (cfg.llm ? undefined : cfg.distill?.fallbackModels);
  const ingestPrompt = loadPrompt("ingest-files");
  const batches: string[] = [];
  let currentBatch = "";
  const batchTokenLimit = distillBatchTokenLimit(model);

  for (const fp of files) {
    try {
      const content = readFileSync(fp, "utf-8");
      if (!content.trim()) continue;
      const relPath = fp.startsWith(workspaceRoot) ? fp.slice(workspaceRoot.length).replace(/^\//, "") : basename(fp);
      const chunks = chunkTextByChars(content, chunkSize, overlap);
      for (let c = 0; c < chunks.length; c++) {
        const header =
          chunks.length === 1
            ? `\n--- FILE: ${relPath} ---\n\n`
            : `\n--- FILE: ${relPath} (chunk ${c + 1}/${chunks.length}) ---\n\n`;
        const block = header + chunks[c];
        const blockTokens = Math.ceil(block.length / 4);
        if (currentBatch.length > 0 && estimateTokens(currentBatch) + blockTokens > batchTokenLimit) {
          batches.push(currentBatch);
          currentBatch = block;
        } else {
          currentBatch += (currentBatch ? "\n" : "") + block;
        }
      }
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:read-file", filePath: fp });
    }
  }
  if (currentBatch.trim()) batches.push(currentBatch);

  const allFacts: Array<{ category: string; text: string; entity?: string; key?: string; value?: string; tags?: string[] }> = [];
  for (let b = 0; b < batches.length; b++) {
    sink.log(`Processing batch ${b + 1}/${batches.length}...`);
    const userContent = ingestPrompt + "\n\n" + batches[b];
    try {
      const content = await chatCompleteWithRetry({
        model: model,
        content: userContent,
        temperature: 0.2,
        maxTokens: distillMaxOutputTokens(model),
        openai,
        fallbackModels: ingestFallbacks,
        label: `memory-hybrid: ingest-files batch ${b + 1}/${batches.length}`,
      });
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const jsonMatch = line.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        try {
          const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          const category = String(obj.category || "technical").toLowerCase();
          const text = String(obj.text || "").trim();
          if (!text || text.length < 10) continue;
          const entity = typeof obj.entity === "string" ? obj.entity : null;
          const key = typeof obj.key === "string" ? obj.key : null;
          const value = typeof obj.value === "string" ? obj.value : (entity && key ? text.slice(0, 200) : "");
          const tags = Array.isArray(obj.tags) ? (obj.tags as string[]).filter((t) => typeof t === "string") : [];
          allFacts.push({
            category: isValidCategory(category) ? category : "technical",
            text,
            entity: entity ?? undefined,
            key: key ?? undefined,
            value,
            tags: [...tags, "ingest"],
          });
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:parse-json" });
        }
      }
    } catch (err) {
      sink.warn(`memory-hybrid: ingest-files LLM batch ${b + 1} failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:llm-batch" });
    }
  }

  if (opts.dryRun) {
    sink.log(`Would extract ${allFacts.length} facts from ${files.length} files`);
    return { stored: 0, skipped: 0, extracted: allFacts.length, files: files.length, dryRun: true };
  }

  let stored = 0;
  let skipped = 0;
  for (const fact of allFacts) {
    if (factsDb.hasDuplicate(fact.text)) {
      skipped++;
      continue;
    }
    try {
      const vector = await embeddings.embed(fact.text);
      if (await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD)) {
        skipped++;
        continue;
      }
      const entry = factsDb.store({
        text: fact.text,
        category: (isValidCategory(fact.category) ? fact.category : "technical") as MemoryCategory,
        importance: BATCH_STORE_IMPORTANCE,
        entity: fact.entity ?? null,
        key: fact.key ?? null,
        value: fact.value ?? fact.text.slice(0, 200),
        source: "ingest",
        decayClass: "stable",
        tags: fact.tags,
      });
      try {
        await vectorDb.store({
          text: fact.text,
          vector,
          importance: BATCH_STORE_IMPORTANCE,
          category: fact.category,
          id: entry.id,
        });
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      } catch (err) {
        sink.warn(`memory-hybrid: ingest-files vector store failed for "${fact.text.slice(0, 40)}...": ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:vector-store" });
      }
      stored++;
    } catch (err) {
      sink.warn(`memory-hybrid: ingest-files store failed for "${fact.text.slice(0, 40)}...": ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:store-fact" });
    }
  }
  return { stored, skipped, extracted: allFacts.length, files: files.length, dryRun: false };
}

/**
 * Distill facts from session files
 */
export async function runDistillForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; all?: boolean; days?: number; since?: string; model?: string; verbose?: boolean; maxSessions?: number; maxSessionTokens?: number; full?: boolean },
  sink: DistillCliSink,
): Promise<DistillCliResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, logger } = ctx;
  const SCAN_TYPE = "distill";
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when --all/--full/--since overrides watermark)
  const useWatermark = !opts.full && !opts.all && !opts.since;
  if (useWatermark && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip) return { sessionsScanned: 0, factsExtracted: 0, stored: 0, dedupSkipped: 0, dryRun: false, skipped: true };
  }

  try {
  const gatherOpts = useWatermark && cursor && cursor.lastSessionTs > 0
    ? { sinceTimestampMs: cursor.lastSessionTs }
    : { all: opts.all, days: opts.days ?? (opts.all ? 90 : 3), since: opts.since };

  if (useWatermark && cursor && cursor.lastSessionTs > 0) {
    logger.info?.(`memory-hybrid: distill incremental — sessions since last run (${new Date(cursor.lastSessionTs).toISOString()})`);
  }

  const sessionFiles = gatherSessionFiles(gatherOpts);
  const maxSessions = opts.maxSessions ?? 0;
  const filesToProcess = maxSessions > 0 ? sessionFiles.slice(0, maxSessions) : sessionFiles;
  if (filesToProcess.length === 0) {
    sink.log("No session files found under ~/.openclaw/agents/*/sessions/");
    if (useWatermark && !opts.dryRun) {
      factsDb.updateScanCursor(SCAN_TYPE, 0, 0);
      clearScanLock(SCAN_TYPE);
    }
    return { sessionsScanned: 0, factsExtracted: 0, stored: 0, dedupSkipped: 0, dryRun: opts.dryRun };
  }
  const cronCfgDistill = getCronModelConfig(cfg);
  const heavyPref = getLLMModelPreference(cronCfgDistill, "heavy");
  const model = opts.model ?? heavyPref[0] ?? cfg.distill?.defaultModel ?? getDefaultCronModel(cronCfgDistill, "heavy");
  const distillFallbacks = heavyPref.length > 1 ? heavyPref.slice(1) : (cfg.llm ? undefined : cfg.distill?.fallbackModels);
  const batches: string[] = [];
  let currentBatch = "";
  const batchTokenLimit = distillBatchTokenLimit(model);
  const maxSessionTokens = opts.maxSessionTokens ?? batchTokenLimit;
  for (let i = 0; i < filesToProcess.length; i++) {
    const { path: fp } = filesToProcess[i];
    try {
      const text = extractTextFromSessionJsonl(fp);
      if (!text.trim()) continue;
      const textTokens = Math.ceil(text.length / 4);
      const chunks = chunkSessionText(text, maxSessionTokens);
      if (chunks.length > 1) {
        sink.log(`memory-hybrid: distill: session too large (${textTokens} tokens), splitting into ${chunks.length} chunks`);
      }

      // Safety check: ensure chunks don't exceed model-specific batch limits
      const safeLimit = batchTokenLimit; // Use model-specific limit instead of hardcoded 350k
      const validChunks = chunks.filter((chunk, idx) => {
        const chunkTokens = Math.ceil(chunk.length / 4);
        if (chunkTokens > safeLimit) {
          sink.warn(`memory-hybrid: distill: chunk ${idx + 1} too large (${chunkTokens} tokens), skipping`);
          return false;
        }
        return true;
      });

      for (let c = 0; c < validChunks.length; c++) {
        const header =
          validChunks.length === 1
            ? `\n--- SESSION: ${basename(fp)} ---\n\n`
            : `\n--- SESSION: ${basename(fp)} (chunk ${c + 1}/${validChunks.length}) ---\n\n`;
        const block = header + validChunks[c];
        const blockTokens = Math.ceil(block.length / 4);
        if (currentBatch.length > 0 && (estimateTokens(currentBatch) + blockTokens > batchTokenLimit)) {
          batches.push(currentBatch);
          currentBatch = block;
        } else {
          currentBatch += (currentBatch ? "\n" : "") + block;
        }
      }
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:extract-text", filePath: fp });
    }
  }
  if (currentBatch.trim()) batches.push(currentBatch);
  const distillPrompt = loadPrompt("distill-sessions");
  const allFacts: Array<{ category: string; text: string; entity?: string; key?: string; value?: string; source_date?: string; tags?: string[] }> = [];
  const progress = createProgressReporter(sink, batches.length, "Distilling sessions");
  for (let b = 0; b < batches.length; b++) {
    progress.update(b + 1);
    const userContent = distillPrompt + "\n\n" + batches[b];
    try {
      const content = await chatCompleteWithRetry({
        model,
        content: userContent,
        temperature: 0.2,
        maxTokens: distillMaxOutputTokens(model),
        openai,
        fallbackModels: distillFallbacks,
        label: `memory-hybrid: distill batch ${b + 1}/${batches.length}`,
      });
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const jsonMatch = line.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        try {
          const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          const category = String(obj.category || "other").toLowerCase();
          const text = String(obj.text || "").trim();
          if (!text || text.length < 10) continue;
          const entity = typeof obj.entity === "string" ? obj.entity : null;
          const key = typeof obj.key === "string" ? obj.key : null;
          const value = typeof obj.value === "string" ? obj.value : (entity && key ? text.slice(0, 200) : "");
          const source_date = typeof obj.source_date === "string" ? obj.source_date : null;
          const tags = Array.isArray(obj.tags) ? (obj.tags as string[]).filter((t) => typeof t === "string") : undefined;
          allFacts.push({ category, text, entity: entity ?? undefined, key: key ?? undefined, value, source_date: source_date ?? undefined, tags });
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:parse-json" });
        }
      }
    } catch (err) {
      sink.warn(`memory-hybrid: distill LLM batch ${b + 1} failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:llm-batch" });
    }
  }
  progress.done();
  if (opts.dryRun) {
    sink.log(`Would extract ${allFacts.length} facts from ${filesToProcess.length} sessions`);
    return { sessionsScanned: filesToProcess.length, factsExtracted: allFacts.length, stored: 0, dedupSkipped: 0, dryRun: true };
  }
  const sourceDateSec = (s: string | null | undefined) => {
    if (!s || typeof s !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
  };
  let stored = 0;
  let skipped = 0;
  for (const fact of allFacts) {
    const isCred = isCredentialLike(fact.text, fact.entity ?? null, fact.key ?? null, fact.value);
    if (isCred && cfg.credentials.enabled && credentialsDb) {
      const parsed = tryParseCredentialForVault(fact.text, fact.entity ?? null, fact.key ?? null, fact.value, {
        requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
      });
      if (parsed) {
        if (!opts.dryRun) {
          let storedInVault = false;
          try {
            const storeResult = credentialsDb.storeIfNew({ service: parsed.service, type: parsed.type as any, value: parsed.secretValue, url: parsed.url, notes: parsed.notes });
            if (!storeResult) {
              continue;
            }
            storedInVault = true;
            const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in vault.`;
            const entry = factsDb.store({
              text: pointerText,
              category: "technical",
              importance: BATCH_STORE_IMPORTANCE,
              entity: "Credentials",
              key: parsed.service,
              value: `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`,
              source: "distillation",
              sourceDate: sourceDateSec(fact.source_date),
            });
            try {
              const vector = await embeddings.embed(pointerText);
              factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
              if (!(await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD))) {
                await vectorDb.store({ text: pointerText, vector, importance: BATCH_STORE_IMPORTANCE, category: "technical", id: entry.id });
              }
            } catch (err) {
              capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:credential-vector-store" });
            }
            stored++;
            if (opts.verbose) sink.log(`  stored credential: ${parsed.service}`);
          } catch (err) {
            if (storedInVault) {
              try {
                credentialsDb.delete(parsed.service, parsed.type as any);
              } catch (cleanupErr) {
                if (opts.verbose) sink.log(`  failed to clean up orphaned credential for ${parsed.service}: ${cleanupErr}`);
                capturePluginError(cleanupErr as Error, { subsystem: "cli", operation: "runDistillForCli:credential-compensating-delete" });
              }
            }
            capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:credential-store" });
          }
        }
        continue;
      }
      continue;
    }
    if (factsDb.hasDuplicate(fact.text)) {
      skipped++;
      continue;
    }
    try {
      const vector = await embeddings.embed(fact.text);
      if (await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD)) {
        skipped++;
        continue;
      }
      const entry = factsDb.store({
        text: fact.text,
        category: (isValidCategory(fact.category) ? fact.category : "other") as MemoryCategory,
        importance: BATCH_STORE_IMPORTANCE,
        entity: fact.entity ?? null,
        key: fact.key ?? null,
        value: fact.value ?? fact.text.slice(0, 200),
        source: "distillation",
        sourceDate: sourceDateSec(fact.source_date),
        tags: fact.tags?.length ? fact.tags : extractTags(fact.text, fact.entity ?? undefined),
      });
      try {
        await vectorDb.store({ text: fact.text, vector, importance: BATCH_STORE_IMPORTANCE, category: fact.category, id: entry.id });
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      } catch (err) {
        sink.warn(`memory-hybrid: distill vector store failed for "${fact.text.slice(0, 40)}...": ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:vector-store" });
      }
      stored++;
      if (opts.verbose) sink.log(`  stored: [${fact.category}] ${fact.text.slice(0, 60)}...`);
    } catch (err) {
      sink.warn(`memory-hybrid: distill store failed for "${fact.text.slice(0, 40)}...": ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:store-fact" });
    }
  }
  try {
    runRecordDistillForCli(ctx);
  } catch (err) {
    sink.warn(`memory-hybrid: failed to record distill timestamp: ${err}`);
    capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:record-timestamp" });
  }
  if (!opts.dryRun) {
    const lastSessionTs = getMaxMtime(filesToProcess.map((f) => f.path));
    factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, filesToProcess.length);
  }
  return { sessionsScanned: filesToProcess.length, factsExtracted: allFacts.length, stored, dedupSkipped: skipped, dryRun: false };
  } finally {
    if (useWatermark && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Migrate credentials to vault
 */
export async function runMigrateToVaultForCli(ctx: HandlerContext): Promise<MigrateToVaultResult | null> {
  const { factsDb, vectorDb, embeddings, credentialsDb, aliasDb, resolvedSqlitePath } = ctx;
  if (!credentialsDb) return null;
  const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
  try {
    return await migrateCredentialsToVault({
      factsDb,
      vectorDb,
      embeddings,
      credentialsDb,
      aliasDb,
      migrationFlagPath,
      markDone: true,
    });
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runMigrateToVaultForCli" });
    throw err;
  }
}

/**
 * Audit credentials vault: list entries and flag suspicious ones (value/service heuristics).
 */
export function runCredentialsAuditForCli(ctx: HandlerContext): CredentialsAuditResult {
  const { credentialsDb } = ctx;
  const entries: Array<{ service: string; type: string; url: string | null; flags: string[] }> = [];
  if (!credentialsDb) return { entries, total: 0 };
  const list = credentialsDb.listAll();
  // Group entries by canonical value and by normalized service name so we can flag
  // older duplicates in each group. Each item carries its `updated` timestamp so we
  // can sort newest-first and keep only group[0] (the newest) un-flagged.
  const valueToEntries = new Map<string, Array<{ service: string; type: string; updated: number }>>();
  const normKeyToEntries = new Map<string, Array<{ service: string; type: string; updated: number }>>();
  for (const row of list) {
    const value = row.value;
    const updated = row.updated;
    const flags = [...auditCredentialValue(value, row.type), ...auditServiceName(row.service)];
    const normKey = `${normalizeServiceForDedup(row.service)}:${row.type}`;
    if (!valueToEntries.has(value)) valueToEntries.set(value, []);
    valueToEntries.get(value)!.push({ service: row.service, type: row.type, updated });
    if (!normKeyToEntries.has(normKey)) normKeyToEntries.set(normKey, []);
    normKeyToEntries.get(normKey)!.push({ service: row.service, type: row.type, updated });
    entries.push({ service: row.service, type: row.type, url: row.url, flags });
  }
  for (const [, group] of valueToEntries) {
    if (group.length > 1) {
      // Sort newest-first so that group[0] is the most recently updated entry.
      // Only the older copies (i >= 1) are flagged, preserving the newest credential.
      const sorted = [...group].sort((a, b) => b.updated - a.updated);
      for (let i = 1; i < sorted.length; i++) {
        const { service, type } = sorted[i];
        const e = entries.find((x) => x.service === service && x.type === type);
        if (e && !e.flags.includes("duplicate_value")) e.flags.push("duplicate_value");
      }
    }
  }
  for (const [, group] of normKeyToEntries) {
    if (group.length > 1) {
      // Sort newest-first; only flag the older normalized-service duplicates (i >= 1).
      const sorted = [...group].sort((a, b) => b.updated - a.updated);
      for (let i = 1; i < sorted.length; i++) {
        const { service, type } = sorted[i];
        const e = entries.find((x) => x.service === service && x.type === type);
        if (e && !e.flags.includes("duplicate_normalized_service")) e.flags.push("duplicate_normalized_service");
      }
    }
  }
  return { entries, total: entries.length };
}

/**
 * List credentials metadata (service, type, url) without decryption.
 * Used by the `credentials list` CLI command.
 */
export function runCredentialsListForCli(ctx: HandlerContext): Array<{ service: string; type: string; url: string | null }> {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return [];
  return credentialsDb.list();
}

/**
 * Get a single credential value by service (and optional type). Used by the `credentials get` CLI command.
 * Returns null if vault is disabled or no matching entry exists.
 */
export function runCredentialsGetForCli(
  ctx: HandlerContext,
  opts: { service: string; type?: string },
): { service: string; type: string; value: string; url: string | null; notes: string | null } | null {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return null;
  const type = opts.type as CredentialType | undefined;
  const entry = credentialsDb.get(opts.service.trim(), type);
  if (!entry) return null;
  return {
    service: entry.service,
    type: entry.type,
    value: entry.value,
    url: entry.url ?? null,
    notes: entry.notes ?? null,
  };
}

/**
 * Prune credentials vault: remove entries flagged by audit. Default dry-run; use --yes to apply.
 */
export function runCredentialsPruneForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; yes?: boolean; onlyFlags?: string[] },
): CredentialsPruneResult {
  const { credentialsDb } = ctx;
  const removed: Array<{ service: string; type: string }> = [];
  const apply = opts.yes === true && !opts.dryRun;
  if (!credentialsDb) return { removed: 0, entries: [], dryRun: !apply };
  const audit = runCredentialsAuditForCli(ctx);
  const flagsToPrune = opts.onlyFlags && opts.onlyFlags.length > 0 ? new Set(opts.onlyFlags) : null;
  for (const e of audit.entries) {
    if (e.flags.length === 0) continue;
    const match = !flagsToPrune || e.flags.some((f) => flagsToPrune.has(f));
    if (!match) continue;
    if (apply) {
      credentialsDb.delete(e.service, e.type as CredentialType);
      removed.push({ service: e.service, type: e.type });
    } else {
      removed.push({ service: e.service, type: e.type });
    }
  }
  return { removed: removed.length, entries: removed, dryRun: !apply };
}

/**
 * Extract self-correction incidents from sessions
 */
export function runSelfCorrectionExtractForCli(
  ctx: HandlerContext,
  opts: {
    days?: number;
    outputPath?: string;
  },
): SelfCorrectionExtractResult {
  const sessionFiles = gatherSessionFiles({
    days: opts.days ?? 3,
  });
  const filePaths = sessionFiles.map((f) => f.path);
  if (filePaths.length === 0) {
    return { incidents: [], sessionsScanned: 0 };
  }
  try {
    const result = runSelfCorrectionExtract({
      filePaths,
      correctionRegex: getCorrectionSignalRegex(),
    });
    if (opts.outputPath && result.incidents.length > 0) {
      try {
        mkdirSync(dirname(opts.outputPath), { recursive: true });
        writeFileSync(opts.outputPath, JSON.stringify(result.incidents, null, 2), "utf-8");
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionExtractForCli:write-output" });
      }
    }
    return result;
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionExtractForCli" });
    throw err;
  }
}

/**
 * Run self-correction analysis and remediation
 */
export async function runSelfCorrectionRunForCli(
  ctx: HandlerContext,
  opts: {
    extractPath?: string;
    incidents?: CorrectionIncident[];
    workspace?: string;
    dryRun?: boolean;
    model?: string;
    approve?: boolean;
    applyTools?: boolean;
    full?: boolean;
  },
): Promise<SelfCorrectionRunResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, logger, proposalsDb } = ctx;
  const SCAN_TYPE = "self-correction-run";

  // Startup guard + concurrency lock (skip if already ran within 23h and not forced)
  // Only apply when no explicit incidents/extractPath provided (i.e. fresh scan)
  if (!opts.full && !opts.dryRun && !opts.incidents && !opts.extractPath) {
    const cursor = factsDb.getScanCursor(SCAN_TYPE);
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip) {
      return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath: null, skipped: true };
    }
  }

  try {
  const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  const scCfg = cfg.selfCorrection ?? DEFAULT_SELF_CORRECTION;
  const reportDir = join(workspaceRoot, "memory", "reports");
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = join(reportDir, `self-correction-${today}.md`);
  let incidents: CorrectionIncident[];
  if (opts.incidents && opts.incidents.length > 0) {
    incidents = opts.incidents;
  } else if (opts.extractPath) {
    try {
      const raw = readFileSync(opts.extractPath, "utf-8");
      incidents = JSON.parse(raw) as CorrectionIncident[];
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:read-extract" });
      return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath: null, error: String(e) };
    }
  } else {
    const extractResult = runSelfCorrectionExtractForCli(ctx, { days: 3 });
    incidents = extractResult.incidents;
  }
  if (incidents.length === 0) {
    const emptyReport = `# Self-Correction Analysis (${today})\n\nScanned sessions: 3 days.\nIncidents found: 0.\n`;
    try {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(reportPath, emptyReport, "utf-8");
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:write-empty-report" });
    }
    if (!opts.dryRun && !opts.incidents && !opts.extractPath) {
      factsDb.updateScanCursor(SCAN_TYPE, 0, 0);
      clearScanLock(SCAN_TYPE);
    }
    return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath };
  }
  const prompt = fillPrompt(loadPrompt("self-correction-analyze"), {
    incidents_json: JSON.stringify(incidents),
  });
  const heavyPref = getLLMModelPreference(getCronModelConfig(cfg), "heavy");
  const model = opts.model ?? heavyPref[0] ?? getDefaultCronModel(getCronModelConfig(cfg), "heavy");
  const scFallbackModels = opts.model ? [] : (heavyPref.length > 1 ? heavyPref.slice(1) : (cfg.llm ? [] : (cfg.distill?.fallbackModels ?? [])));
  let analysed: Array<{
    category: string;
    severity: string;
    remediationType: string;
    remediationContent: string | { text?: string; entity?: string; key?: string; tags?: string[] };
    repeated?: boolean;
  }> = [];
  const useSpawn = scCfg.analyzeViaSpawn && incidents.length > scCfg.spawnThreshold;
  try {
    let content: string;
    if (useSpawn) {
      const { spawnSync } = await import("node:child_process");
      const { tmpdir: osTmp } = await import("node:os");
      const promptPath = join(osTmp(), `self-correction-prompt-${Date.now()}.txt`);
      writeFileSync(promptPath, prompt, "utf-8");
      const spawnModel = (scCfg.spawnModel?.trim() || getDefaultCronModel(getCronModelConfig(cfg), "default"));
      const r = spawnSync(
        "openclaw",
        ["sessions", "spawn", "--model", spawnModel, "--message", "Analyze the attached incidents and output ONLY a JSON array (no markdown, no code fences). Use the instructions in the attached file.", "--attach", promptPath],
        { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
      );
      try {
        if (existsSync(promptPath)) rmSync(promptPath, { force: true });
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:cleanup-tmp" });
      }
      content = (r.stdout ?? "") + (r.stderr ?? "");
      if (r.status !== 0) throw new Error(`sessions spawn exited ${r.status}: ${content.slice(0, 500)}`);
    } else {
      content = await chatCompleteWithRetry({
        model,
        content: prompt,
        temperature: 0.2,
        maxTokens: distillMaxOutputTokens(model),
        openai,
        fallbackModels: scFallbackModels,
        label: "memory-hybrid: self-correction analyze",
      });
    }
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      analysed = JSON.parse(jsonMatch[0]) as typeof analysed;
    }
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:llm-analysis" });
    return {
      incidentsFound: incidents.length,
      analysed: 0,
      autoFixed: 0,
      proposals: [],
      reportPath: null,
      error: String(e),
    };
  }
  const proposals: string[] = [];
  const toolsSuggestions: string[] = [];
  let autoFixed = 0;
  let toolsApplied = 0;
  const toApply = analysed.filter((a) => a.remediationType !== "NO_ACTION" && !a.repeated).slice(0, SELF_CORRECTION_CAP);
  const toolsPath = join(workspaceRoot, "TOOLS.md");
  const toolsSection = scCfg.toolsSection;
  const semanticThreshold = scCfg.semanticDedupThreshold ?? 0.92;

  for (const a of toApply) {
    if (a.remediationType === "MEMORY_STORE") {
      const c = a.remediationContent;
      const obj = typeof c === "object" && c && "text" in c ? c : { text: String(c), entity: "Fact", tags: [] as string[] };
      const text = (obj.text ?? "").trim();
      if (!text || factsDb.hasDuplicate(text)) continue;
      let vector: number[] | null = null;
      if (scCfg.semanticDedup || !opts.dryRun) {
        try {
          vector = await embeddings.embed(text);
          if (scCfg.semanticDedup && (await vectorDb.hasDuplicate(vector, semanticThreshold))) continue;
        } catch (err) {
          logger.warn?.(`memory-hybrid: self-correction embed/semantic dedup failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:embed-dedup" });
          continue;
        }
      }
      if (opts.dryRun) continue;
      try {
        const entry = factsDb.store({
          text,
          category: "technical",
          importance: CLI_STORE_IMPORTANCE,
          entity: obj.entity ?? null,
          key: typeof obj.key === "string" ? obj.key : null,
          value: text.slice(0, 200),
          source: "self-correction",
          tags: Array.isArray(obj.tags) ? obj.tags : [],
        });
        if (vector) {
          await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category: "technical", id: entry.id });
          factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        }
        autoFixed++;
      } catch (err) {
        logger.warn?.(`memory-hybrid: self-correction MEMORY_STORE failed: ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:memory-store" });
      }
    } else if (a.remediationType === "TOOLS_RULE") {
      const line = typeof a.remediationContent === "string" ? a.remediationContent : (a.remediationContent as { text?: string })?.text ?? "";
      if (line.trim()) toolsSuggestions.push(line.trim());
    } else if (a.remediationType === "AGENTS_RULE" || a.remediationType === "SKILL_UPDATE") {
      const line = typeof a.remediationContent === "string" ? a.remediationContent : (a.remediationContent as { text?: string })?.text ?? "";
      if (line.trim()) {
        proposals.push(`[${a.remediationType}] ${line.trim()}`);
        // Wire AGENTS_RULE into proposals DB (#260) — closes the dead end
        if (a.remediationType === "AGENTS_RULE" && proposalsDb && (scCfg as { agentsRuleToProposals?: boolean }).agentsRuleToProposals !== false && !opts.dryRun) {
          try {
            const targetFile = inferTargetFile(line);
            const incidentContext = incidents.length > 0 ? `Correction incident: "${incidents[0].userMessage.slice(0, 200)}"` : "Self-correction analysis";
            proposalsDb.create({
              targetFile,
              title: `Self-correction: ${a.category ?? "behavior"}`,
              observation: incidentContext,
              suggestedChange: line.trim(),
              confidence: 0.7,
              evidenceSessions: incidents.map((inc) => inc.sessionFile).filter((v, idx, arr) => arr.indexOf(v) === idx),
            });
          } catch (err) {
            capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:agents-rule-proposal" });
          }
        }
      }
    }
  }

  const noApplyTools = opts.applyTools === false;
  const shouldApplyTools = !opts.dryRun && (scCfg.applyToolsByDefault !== false || opts.approve) && !noApplyTools;
  if (toolsSuggestions.length > 0 && !opts.dryRun) {
    if (scCfg.autoRewriteTools && shouldApplyTools && existsSync(toolsPath)) {
      try {
        const currentTools = readFileSync(toolsPath, "utf-8");
        const rewritePrompt = fillPrompt(loadPrompt("self-correction-rewrite-tools"), {
          current_tools: currentTools,
          new_rules: toolsSuggestions.join("\n"),
        });
        const rewritten = await chatCompleteWithRetry({
          model,
          content: rewritePrompt,
          temperature: 0.2,
          maxTokens: 16000,
          openai,
          fallbackModels: scFallbackModels,
          label: "memory-hybrid: self-correction rewrite-tools",
        });
        const cleaned = rewritten.trim().replace(/^```\w*\n?|```\s*$/g, "").trim();
        if (cleaned.length > 50) {
          writeFileSync(toolsPath, cleaned, "utf-8");
          toolsApplied = toolsSuggestions.length;
          autoFixed += toolsApplied;
        }
      } catch (err) {
        logger.warn?.(`memory-hybrid: self-correction TOOLS rewrite failed: ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:tools-rewrite" });
      }
    } else if (shouldApplyTools && existsSync(toolsPath)) {
      try {
        const { inserted } = insertRulesUnderSection(toolsPath, toolsSection, toolsSuggestions);
        toolsApplied = inserted;
        autoFixed += inserted;
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:insert-tools" });
      }
    }
  }

  const reportLines = [
    `# Self-Correction Analysis (${today})`,
    "",
    `Scanned: last 3 days. Incidents found: ${incidents.length}.`,
    `Analysed: ${analysed.length}. Auto-fixed: ${autoFixed}. Needs review: ${proposals.length}.`,
    "",
    ...(autoFixed > 0 ? ["## Auto-applied", "", `- ${autoFixed} memory store(s) and/or TOOLS.md rule(s).`, ""] : []),
    ...(toolsSuggestions.length > 0 && toolsApplied === 0 && !scCfg.autoRewriteTools
      ? [
          "## Suggested TOOLS.md rules (not applied this run). To apply: config applyToolsByDefault is true by default, or use --approve. To skip applying: --no-apply-tools.",
          "",
          ...toolsSuggestions.map((s) => `- ${s}`),
          "",
        ]
      : []),
    ...(toolsApplied > 0 ? ["## TOOLS.md updated", "", `- ${toolsApplied} rule(s) inserted under section \"${toolsSection}\".`, ""] : []),
    ...(proposals.length > 0 ? ["## Proposed (review before applying)", "", ...proposals.map((p) => `- ${p}`), ""] : []),
  ];
  try {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportPath, reportLines.join("\n"), "utf-8");
  } catch (e) {
    logger.warn?.(`memory-hybrid: could not write report: ${e}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:write-report" });
  }
  // Record savings: each auto-fixed incident avoided ~2 manual LLM round-trips
  if (autoFixed > 0 && ctx.costTracker && !opts?.dryRun) {
    ctx.costTracker.recordSavings({
      feature: "self-correction",
      action: "auto-fixed incident",
      countAvoided: autoFixed,
      estimatedSavingUsd: autoFixed * 0.002,
      note: `${autoFixed} incident(s) auto-remediated`,
    });
  }

  if (!opts.dryRun && !opts.incidents && !opts.extractPath) {
    factsDb.updateScanCursor(SCAN_TYPE, Date.now(), incidents.length);
  }

  return {
    incidentsFound: incidents.length,
    analysed: analysed.length,
    autoFixed,
    proposals,
    reportPath,
    toolsSuggestions: toolsSuggestions.length > 0 ? toolsSuggestions : undefined,
    toolsApplied: toolsApplied > 0 ? toolsApplied : undefined,
  };
  } finally {
    if (!opts.full && !opts.dryRun && !opts.incidents && !opts.extractPath) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Upgrade plugin to latest version
 */
export async function runUpgradeForCli(
  ctx: HandlerContext,
  requestedVersion?: string,
): Promise<UpgradeCliResult> {
  const { cfg, logger } = ctx;
  const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { spawnSync } = await import("node:child_process");
  const version = requestedVersion?.trim() || "latest";
  try {
    rmSync(extDir, { recursive: true, force: true });
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runUpgradeForCli:remove-dir" });
    return {
      ok: false,
      error: `Could not remove plugin directory: ${e}. Use standalone installer: npx -y openclaw-hybrid-memory-install ${version}`,
    };
  }
  // Use standalone installer so upgrade works even when config is invalid (plugin missing).
  const npxArgs = ["-y", "openclaw-hybrid-memory-install", version];
  const r = spawnSync("npx", npxArgs, {
    stdio: "inherit",
    cwd: homedir(),
    shell: true,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      error: `Install failed (exit ${r.status}). Run manually: npx -y openclaw-hybrid-memory-install ${version}`,
    };
  }
  let installedVersion = version;
  try {
    const pkgPath = join(extDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      installedVersion = pkg.version ?? installedVersion;
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runUpgradeForCli:read-version" });
  }
  // Ensure maintenance cron jobs exist (add missing, normalize existing; never re-enable disabled)
  try {
    const openclawDir = join(homedir(), ".openclaw");
    const pluginConfig = getCronModelConfig(cfg);
    const scheduleOverrides: Record<string, string> = {};
    if (typeof cfg.memoryToSkills?.schedule === "string" && cfg.memoryToSkills.schedule.trim().length > 0) {
      scheduleOverrides[PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills"] = cfg.memoryToSkills.schedule;
    }
    if (typeof cfg.nightlyCycle?.schedule === "string" && cfg.nightlyCycle.schedule.trim().length > 0) {
      scheduleOverrides[PLUGIN_JOB_ID_PREFIX + "nightly-dream-cycle"] = cfg.nightlyCycle.schedule;
    }
    const { added, normalized } = ensureMaintenanceCronJobs(openclawDir, pluginConfig, {
      normalizeExisting: true,
      reEnableDisabled: false,
      scheduleOverrides: Object.keys(scheduleOverrides).length > 0 ? scheduleOverrides : undefined,
      messageOverrides: { [PLUGIN_JOB_ID_PREFIX + "nightly-memory-to-skills"]: buildMemoryToSkillsMessage(cfg.memoryToSkills?.notify !== false) },
    });
    if (added.length > 0 || normalized.length > 0) {
      logger?.info?.(`memory-hybrid: upgrade — cron jobs: ${added.length} added, ${normalized.length} normalized (disabled jobs left as-is). Run openclaw hybrid-mem verify to confirm.`);
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runUpgradeForCli:ensure-cron-jobs" });
    // non-fatal: user can run verify --fix later
  }
  return { ok: true, version: installedVersion, pluginDir: extDir };
}

/** Get plugin entry config from root openclaw config (for schedule overrides etc.). */
function getPluginEntryConfig(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const plugins = root?.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const entry = entries?.[PLUGIN_ID] as Record<string, unknown> | undefined;
  const config = entry?.config;
  return config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : undefined;
}

/**
 * Get plugin config from file
 */
function getPluginConfigFromFile(configPath: string): { config: Record<string, unknown>; root: Record<string, unknown> } | { error: string } {
  if (!existsSync(configPath)) return { error: `Config not found: ${configPath}` };
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "getPluginConfigFromFile:read" });
    return { error: `Could not read config: ${e}` };
  }
  if (!root.plugins || typeof root.plugins !== "object") root.plugins = {};
  const plugins = root.plugins as Record<string, unknown>;
  if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = { enabled: true, config: {} };
  const entry = entries[PLUGIN_ID] as Record<string, unknown>;
  if (!entry.config || typeof entry.config !== "object") entry.config = {};
  const config = entry.config as Record<string, unknown>;
  // Repair: credentials must be an object (schema). If written as boolean, normalize so next write is valid.
  if (config.credentials === true || config.credentials === false) {
    config.credentials = { enabled: config.credentials };
  }
  return { config, root };
}

/**
 * Set nested config value
 */
function setNested(obj: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    // Prevent prototype pollution via dangerous path segments
    if (p === "__proto__" || p === "constructor" || p === "prototype") {
      return false;
    }
    if (!(p in cur) || typeof (cur as any)[p] !== "object" || (cur as any)[p] === null) (cur as any)[p] = {};
    cur = (cur as any)[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  // Also prevent setting dangerous keys at the final segment
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    return false;
  }
  const v =
    value === "true" || value === "enabled"
      ? true
      : value === "false" || value === "disabled"
        ? false
        : value === "null"
          ? null
          : /^-?\d+$/.test(String(value))
            ? parseInt(String(value), 10)
            : /^-?\d*\.\d+$/.test(String(value))
              ? parseFloat(String(value))
              : value;
  (cur as any)[last] = v;
  return true;
}

/**
 * Get nested config value
 */
function getNested(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
  return cur;
}

/**
 * Show help for config key
 */
export function runConfigSetHelpForCli(
  ctx: HandlerContext,
  key: string,
): ConfigCliResult {
  const k = key.trim();
  if (!k) return { ok: false, error: "Key is required (e.g. autoCapture, credentials.enabled)" };
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const out = getPluginConfigFromFile(configPath);
  if ("error" in out) return { ok: false, error: out.error };
  const current = getNested(out.config, k);
  const currentStr = current === undefined ? "(not set)" : typeof current === "string" ? current : JSON.stringify(current);
  let desc = "";
  try {
    const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pluginPath = join(extDir, "openclaw.plugin.json");
    if (existsSync(pluginPath)) {
      const plugin = JSON.parse(readFileSync(pluginPath, "utf-8")) as { uiHints?: Record<string, { help?: string; label?: string }> };
      const hint = plugin.uiHints?.[k];
      if (hint?.help) {
        desc = hint.help.length > MAX_DESC_LEN ? hint.help.slice(0, MAX_DESC_LEN - 3) + "..." : hint.help;
      } else if (hint?.label) {
        desc = hint.label;
      }
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runConfigSetHelpForCli:read-hints" });
  }
  if (!desc) desc = "No description for this key.";
  const lines = [`${k} = ${currentStr}`, "", desc];
  return { ok: true, configPath, message: lines.join("\n") };
}

/**
 * Set config mode
 */
export function runConfigModeForCli(
  ctx: HandlerContext,
  mode: string,
): ConfigCliResult {
  const valid: ConfigMode[] = ["essential", "normal", "expert", "full"];
  if (!valid.includes(mode as ConfigMode)) {
    return { ok: false, error: `Invalid mode: ${mode}. Use one of: ${valid.join(", ")}` };
  }
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const out = getPluginConfigFromFile(configPath);
  if ("error" in out) return { ok: false, error: out.error };
  out.config.mode = mode;
  try {
    writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
    writeFileSync(getRestartPendingPath(), "", "utf-8");
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigModeForCli:write" });
    return { ok: false, error: `Could not write config: ${e}` };
  }
  return { ok: true, configPath, message: `Set mode to "${mode}". Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
}

/**
 * Set config value
 */
export function runConfigSetForCli(
  ctx: HandlerContext,
  key: string,
  value: string,
): ConfigCliResult {
  if (!key.trim()) return { ok: false, error: "Key is required (e.g. autoCapture, credentials.enabled, store.fuzzyDedupe, errorReporting.botName, errorReporting.botId)" };
  const k = key.trim();
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const out = getPluginConfigFromFile(configPath);
  if ("error" in out) return { ok: false, error: out.error };
  // When setting any errorReporting.* key, ensure errorReporting object exists and has required enabled/consent so schema validates
  if (k.startsWith("errorReporting.")) {
    let er = out.config.errorReporting as Record<string, unknown> | undefined;
    if (typeof er !== "object" || er === null) {
      er = { enabled: false, consent: false };
      out.config.errorReporting = er;
    }
    if (!("enabled" in er)) (er as Record<string, unknown>).enabled = false;
    if (!("consent" in er)) (er as Record<string, unknown>).consent = false;
  }
  // When setting any memoryToSkills.* key, ensure memoryToSkills object exists
  if (k.startsWith("memoryToSkills.")) {
    let mts = out.config.memoryToSkills as Record<string, unknown> | undefined;
    if (typeof mts !== "object" || mts === null) {
      mts = {};
      out.config.memoryToSkills = mts;
    }
  }
  // errorReporting must stay an object (schema); "config-set errorReporting true" → errorReporting.enabled + consent = true
  if (k === "errorReporting" && !k.includes(".")) {
    const boolVal = value === "true" || value === "enabled";
    let er = out.config.errorReporting as Record<string, unknown> | undefined;
    if (typeof er !== "object" || er === null) er = { enabled: false, consent: false };
    (er as Record<string, unknown>).enabled = boolVal;
    (er as Record<string, unknown>).consent = boolVal;
    out.config.errorReporting = er;
    const written = (er as Record<string, unknown>).enabled;
    try {
      hybridConfigSchema.parse(out.config);
    } catch (schemaErr: unknown) {
      capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), { subsystem: "cli", operation: "runConfigSetForCli:validation-errorReporting" });
      return { ok: false, error: `Invalid config value: ${schemaErr}` };
    }
    try {
      writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
      writeFileSync(getRestartPendingPath(), "", "utf-8");
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write-errorReporting" });
      return { ok: false, error: `Could not write config: ${e}` };
    }
    return { ok: true, configPath, message: `Set errorReporting.enabled and errorReporting.consent = ${written}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
  }
  // memoryToSkills must stay an object (schema); "config-set memoryToSkills true" → memoryToSkills.enabled = true
  if (k === "memoryToSkills" && !k.includes(".")) {
    const boolVal = value === "true" || value === "enabled";
    let mts = out.config.memoryToSkills as Record<string, unknown> | undefined;
    if (typeof mts !== "object" || mts === null) mts = {};
    (mts as Record<string, unknown>).enabled = boolVal;
    out.config.memoryToSkills = mts;
    const written = (mts as Record<string, unknown>).enabled;
    try {
      hybridConfigSchema.parse(out.config);
    } catch (schemaErr: unknown) {
      capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), { subsystem: "cli", operation: "runConfigSetForCli:validation-memoryToSkills" });
      return { ok: false, error: `Invalid config value: ${schemaErr}` };
    }
    try {
      writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
      writeFileSync(getRestartPendingPath(), "", "utf-8");
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write-memoryToSkills" });
      return { ok: false, error: `Could not write config: ${e}` };
    }
    return { ok: true, configPath, message: `Set memoryToSkills.enabled = ${written}. Restart the gateway for changes to take effect. Run: openclaw hybrid-mem skills-suggest. Use openclaw hybrid-mem verify to confirm.` };
  }
  // credentials must stay an object (schema); "config-set credentials true" → credentials.enabled = true
  if (k === "credentials" && !k.includes(".")) {
    const boolVal = value === "true" || value === "enabled";
    const cred = out.config.credentials as Record<string, unknown> | undefined;
    if (typeof cred !== "object" || cred === null) {
      out.config.credentials = { enabled: boolVal };
    } else {
      (out.config.credentials as Record<string, unknown>).enabled = boolVal;
    }
    const written = (out.config.credentials as Record<string, unknown>).enabled;
    // Validate config against schema before writing
    try {
      hybridConfigSchema.parse(out.config);
    } catch (schemaErr: unknown) {
      capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), { subsystem: "cli", operation: "runConfigSetForCli:validation-credentials" });
      return { ok: false, error: `Invalid config value: ${schemaErr}` };
    }
    try {
      writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
      writeFileSync(getRestartPendingPath(), "", "utf-8");
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write-credentials" });
      return { ok: false, error: `Could not write config: ${e}` };
    }
    return { ok: true, configPath, message: `Set credentials.enabled = ${written}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
  }
  // Object toggles: "config-set <key> enabled" must set <key>: { enabled: true }, never replace with boolean (parsers expect cfg.<key>?.enabled === true).
  const boolVal = value === "true" || value === "enabled";
  const objectToggles: Array<{ key: string; prop: string }> = [
    { key: "nightlyCycle", prop: "enabled" },
    { key: "passiveObserver", prop: "enabled" },
    { key: "selfExtension", prop: "enabled" },
    { key: "crystallization", prop: "enabled" },
    { key: "personaProposals", prop: "enabled" },
    { key: "reflection", prop: "enabled" },
    { key: "procedures", prop: "enabled" },
    { key: "graph", prop: "enabled" },
    { key: "wal", prop: "enabled" },
    { key: "aliases", prop: "enabled" },
    { key: "ambient", prop: "enabled" },
    { key: "documents", prop: "enabled" },
    { key: "workflowTracking", prop: "enabled" },
    { key: "queryExpansion", prop: "enabled" },
    { key: "reranking", prop: "enabled" },
    { key: "contextualVariants", prop: "enabled" },
    { key: "verification", prop: "enabled" },
    { key: "provenance", prop: "enabled" },
    { key: "graphRetrieval", prop: "enabled" },
    { key: "clusters", prop: "enabled" },
    { key: "gaps", prop: "enabled" },
    { key: "health", prop: "enabled" },
    { key: "memoryTiering", prop: "enabled" },
    { key: "reinforcement", prop: "enabled" },
    { key: "implicitFeedback", prop: "enabled" },
    { key: "closedLoop", prop: "enabled" },
    { key: "frustrationDetection", prop: "enabled" },
    { key: "crossAgentLearning", prop: "enabled" },
    { key: "toolEffectiveness", prop: "enabled" },
    { key: "futureDateProtection", prop: "enabled" },
    { key: "path", prop: "enabled" },
    { key: "activeTask", prop: "enabled" },
  ];
  for (const { key, prop } of objectToggles) {
    if (k === key && !k.includes(".")) {
      let obj = out.config[key] as Record<string, unknown> | undefined;
      if (typeof obj !== "object" || obj === null) obj = {};
      (obj as Record<string, unknown>)[prop] = boolVal;
      out.config[key] = obj;
      try {
        hybridConfigSchema.parse(out.config);
      } catch (schemaErr: unknown) {
        capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), { subsystem: "cli", operation: "runConfigSetForCli:validation-" + key });
        return { ok: false, error: `Invalid config value: ${schemaErr}` };
      }
      try {
        writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
        writeFileSync(getRestartPendingPath(), "", "utf-8");
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write-" + key });
        return { ok: false, error: `Could not write config: ${e}` };
      }
      return { ok: true, configPath, message: `Set ${key}.${prop} = ${boolVal}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
    }
  }
  // extraction uses .extractionPasses not .enabled
  if (k === "extraction" && !k.includes(".")) {
    const ext = out.config.extraction as Record<string, unknown> | undefined;
    const obj = typeof ext === "object" && ext !== null ? { ...ext } : {};
    (obj as Record<string, unknown>).extractionPasses = boolVal;
    out.config.extraction = obj;
    try {
      hybridConfigSchema.parse(out.config);
    } catch (schemaErr: unknown) {
      capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), { subsystem: "cli", operation: "runConfigSetForCli:validation-extraction" });
      return { ok: false, error: `Invalid config value: ${schemaErr}` };
    }
    try {
      writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
      writeFileSync(getRestartPendingPath(), "", "utf-8");
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write-extraction" });
      return { ok: false, error: `Could not write config: ${e}` };
    }
    return { ok: true, configPath, message: `Set extraction.extractionPasses = ${boolVal}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
  }
  // verbosity: must be one of the valid levels
  if (k === "verbosity") {
    const validVerbosity = ["quiet", "normal", "verbose"];
    if (!validVerbosity.includes(value)) {
      return { ok: false, error: `Invalid verbosity: "${value}". Use one of: ${validVerbosity.join(", ")}` };
    }
    out.config.verbosity = value;
    try {
      hybridConfigSchema.parse(out.config);
    } catch (schemaErr: unknown) {
      capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), { subsystem: "cli", operation: "runConfigSetForCli:validation-verbosity" });
      return { ok: false, error: `Invalid config value: ${schemaErr}` };
    }
    try {
      writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
      writeFileSync(getRestartPendingPath(), "", "utf-8");
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write-verbosity" });
      return { ok: false, error: `Could not write config: ${e}` };
    }
    return { ok: true, configPath, message: `Set verbosity = "${value}". Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
  }
  // Enum-like keys: normalize value to lowercase so "Nano" → "nano" for schema validation
  const enumKeys: Record<string, string[]> = {
    "distill.extractionModelTier": ["nano", "default", "heavy"],
  };
  let valueToSet: unknown = value;
  if (enumKeys[k]) {
    const normalized = String(value).trim().toLowerCase();
    if (!enumKeys[k].includes(normalized)) {
      return { ok: false, error: `Invalid ${k}: "${value}". Use one of: ${enumKeys[k].join(", ")}` };
    }
    valueToSet = normalized;
  }
  if (!setNested(out.config, k, valueToSet)) {
    return { ok: false, error: `Invalid config key: ${key}` };
  }
  const written = getNested(out.config, k);
  const writtenStr = typeof written === "string" ? written : JSON.stringify(written);

  // Validate config against schema before writing
  try {
    hybridConfigSchema.parse(out.config);
  } catch (schemaErr: unknown) {
    capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), { subsystem: "cli", operation: "runConfigSetForCli:validation" });
    return { ok: false, error: `Invalid config value: ${schemaErr}` };
  }

  try {
    writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
    writeFileSync(getRestartPendingPath(), "", "utf-8");
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write" });
    return { ok: false, error: `Could not write config: ${e}` };
  }
  return { ok: true, configPath, message: `Set ${key} = ${writtenStr}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
}

/**
 * Uninstall plugin
 */
export function runUninstallForCli(
  ctx: HandlerContext,
  opts: { cleanAll: boolean; leaveConfig: boolean },
): UninstallCliResult {
  const { resolvedSqlitePath, resolvedLancePath } = ctx;
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const cleaned: string[] = [];
  let outcome: UninstallCliResult["outcome"];
  let error = "";

  if (!opts.leaveConfig && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
      const plugins = config.plugins as Record<string, unknown>;
      if (!plugins.slots || typeof plugins.slots !== "object") plugins.slots = {};
      (plugins.slots as Record<string, string>).memory = "memory-core";
      if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
      const entries = plugins.entries as Record<string, unknown>;
      if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = {};
      (entries[PLUGIN_ID] as Record<string, boolean>).enabled = false;
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      outcome = "config_updated";
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runUninstallForCli:update-config" });
      outcome = "config_error";
      error = String(e);
    }
  } else if (!opts.leaveConfig) {
    outcome = "config_not_found";
  } else {
    outcome = "leave_config";
  }

  if (opts.cleanAll) {
    if (existsSync(resolvedSqlitePath)) {
      try {
        rmSync(resolvedSqlitePath, { force: true });
        cleaned.push(resolvedSqlitePath);
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runUninstallForCli:remove-sqlite" });
      }
    }
    if (existsSync(resolvedLancePath)) {
      try {
        rmSync(resolvedLancePath, { recursive: true, force: true });
        cleaned.push(resolvedLancePath);
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runUninstallForCli:remove-lance" });
      }
    }
  }

  const base = { pluginId: PLUGIN_ID, cleaned };
  if (outcome === "config_error") return { ...base, outcome, error };
  return { ...base, outcome } as UninstallCliResult;
}

/**
 * Extract implicit feedback signals from recent sessions and feed them into
 * the reinforcement and self-correction pipelines as synthetic incidents.
 * Issue #262 — Phase 1 integration.
 */
export async function runExtractImplicitFeedbackForCli(
  ctx: HandlerContext,
  opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    includeTrajectories?: boolean;
    includeClosedLoop?: boolean;
  },
): Promise<{
  signalsExtracted: number;
  positiveCount: number;
  negativeCount: number;
  trajectoriesBuilt: number;
  sessionsScanned: number;
  closedLoopReport?: string;
}> {
  const { factsDb, cfg, logger, openai } = ctx;
  const days = opts.days ?? 3;
  const sessionDir = cfg.procedures.sessionsDir;
  const filePaths = getSessionFilePathsSince(sessionDir, days);

  const implicitCfg = cfg.implicitFeedback ?? {
    enabled: true,
    minConfidence: 0.5,
    signalTypes: undefined,
    rephraseThreshold: 0.8,
    topicChangeThreshold: 0.3,
    terseResponseRatio: 0.4,
    feedToReinforcement: true,
    feedToSelfCorrection: true,
  };

  if (implicitCfg.enabled === false) {
    return { signalsExtracted: 0, positiveCount: 0, negativeCount: 0, trajectoriesBuilt: 0, sessionsScanned: 0 };
  }

  let totalSignals = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let trajectoriesBuilt = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;

  for (const filePath of filePaths) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").split("\n");
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "runExtractImplicitFeedbackForCli:read-file",
        severity: "info",
        subsystem: "implicit-feedback",
      });
      continue;
    }

    const sessionFile = basename(filePath);
    const turns = parseSessionTurns(lines);
    if (turns.length < 3) continue;

    // Phase 1: Extract implicit signals
    const signals = extractImplicitSignals(turns, implicitCfg, sessionFile);

    if (opts.verbose) {
      for (const sig of signals) {
        logger?.info?.(`[${sessionFile}] ${sig.type} (${sig.polarity}, conf ${sig.confidence.toFixed(2)}): ${sig.context.userMessage.slice(0, 60)}`);
      }
    }

    totalSignals += signals.length;
    for (const sig of signals) {
      if (sig.polarity === "positive") positiveCount++;
      else if (sig.polarity === "negative") negativeCount++;
    }

    if (!opts.dryRun && rawDb) {
      // Store raw signals in implicit_signals table
      try {
        const insert = rawDb.prepare(`
          INSERT OR IGNORE INTO implicit_signals (session_file, signal_type, confidence, polarity, user_message, agent_message, preceding_turns, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'implicit')
        `);
        for (const sig of signals) {
          try {
            insert.run(
              sig.context.sessionFile,
              sig.type,
              sig.confidence,
              sig.polarity,
              sig.context.userMessage.slice(0, 500),
              sig.context.agentMessage.slice(0, 500),
              sig.context.precedingTurns,
            );
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "runExtractImplicitFeedbackForCli:insert-signal",
              severity: "info",
              subsystem: "implicit-feedback",
            });
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:store-signals",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }

    // Route positive signals to reinforcement pipeline
    if (!opts.dryRun && implicitCfg.feedToReinforcement !== false && signals.length > 0) {
      const minConf = implicitCfg.minConfidence ?? 0.5;
      const positiveSignals = signals.filter((s) => s.polarity === "positive" && s.confidence >= minConf);
      const trackContext = cfg.reinforcement?.trackContext !== false;
      const maxEventsPerFact = cfg.reinforcement?.maxEventsPerFact ?? 50;
      for (const sig of positiveSignals) {
        try {
          const searchQuery = sig.context.agentMessage || sig.context.userMessage;
          const matches = factsDb.search(searchQuery, 3);
          const context: ReinforcementContext = {
            querySnippet: sig.context.userMessage.slice(0, 200),
            topic: sig.type,
            sessionFile: sig.context.sessionFile,
          };
          for (const match of matches) {
            factsDb.reinforceFact(match.entry.id, sig.context.userMessage, context, {
              trackContext,
              maxEventsPerFact,
              boostAmount: 0.5 * sig.confidence, // weaker than explicit praise
            });
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runExtractImplicitFeedbackForCli:feed-reinforcement",
            severity: "info",
            subsystem: "implicit-feedback",
          });
        }
      }
    }

    // Route negative signals to self-correction pipeline as pattern facts
    if (!opts.dryRun && implicitCfg.feedToSelfCorrection !== false && signals.length > 0) {
      const minConf = implicitCfg.minConfidence ?? 0.5;
      const negativeSignals = signals.filter((s) => s.polarity === "negative" && s.confidence >= minConf);
      for (const sig of negativeSignals) {
        try {
          const text = `[Implicit ${sig.type}] "${sig.context.userMessage.slice(0, 200)}"`;
          if (!factsDb.hasDuplicate(text)) {
            factsDb.store({
              text,
              category: "pattern",
              importance: Math.max(0.3, sig.confidence * 0.6),
              entity: null,
              key: null,
              value: text.slice(0, 200),
              source: "implicit-feedback",
              tags: ["implicit-feedback", "negative", sig.type],
            });
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runExtractImplicitFeedbackForCli:feed-self-correction",
            severity: "info",
            subsystem: "implicit-feedback",
          });
        }
      }
    }

    // Phase 2: Build trajectories
    if (opts.includeTrajectories !== false && !opts.dryRun && rawDb) {
      try {
        const trajectories = buildTrajectories(turns, sessionFile);
        trajectoriesBuilt += trajectories.length;

        const insertTraj = rawDb.prepare(`
          INSERT OR REPLACE INTO feedback_trajectories
            (id, session_file, turns_json, outcome, outcome_signal, key_pivot, lessons_json, topic, tools_used, turn_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const traj of trajectories) {
          try {
            // If LLM analysis is enabled, use it to enhance lessons
            if (implicitCfg.trajectoryLLMAnalysis) {
              try {
                const prompt = loadPrompt("trajectory-analyze");
                const nanoPref = getLLMModelPreference(getCronModelConfig(cfg), "nano");
                const model = nanoPref[0] ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
                const fallbackModels = nanoPref.length > 1 ? nanoPref.slice(1) : (cfg.distill?.fallbackModels ?? []);
                const chatFn = async (opts: { model?: string; messages: Array<{ role: string; content: string }> }) => {
                  const userMessage = opts.messages.find((m) => m.role === "user");
                  if (!userMessage) throw new Error("No user message found");
                  return await chatCompleteWithRetry({
                    model: opts.model ?? model,
                    content: userMessage.content,
                    temperature: 0.2,
                    maxTokens: 4000,
                    openai,
                    fallbackModels,
                    label: "memory-hybrid: trajectory-analyze",
                  });
                };
                const llmAnalysis = await analyzeTrajectoriesWithLLM(traj, prompt, chatFn);
                if (llmAnalysis) {
                  // Replace heuristic lessons with LLM-produced lesson and patterns
                  traj.lessonsExtracted = [llmAnalysis.keyLesson, ...llmAnalysis.patterns];
                  if (llmAnalysis.pivotTurn !== null) {
                    traj.keyPivot = llmAnalysis.pivotTurn;
                  }
                  if (llmAnalysis.outcome) {
                    traj.outcome = llmAnalysis.outcome;
                  }
                }
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "runExtractImplicitFeedbackForCli:llm-trajectory-analysis",
                  severity: "info",
                  subsystem: "implicit-feedback",
                });
              }
            }

            const row = serializeTrajectory(traj);
            insertTraj.run(
              row.id, row.session_file, row.turns_json, row.outcome,
              row.outcome_signal, row.key_pivot, row.lessons_json,
              row.topic, row.tools_used, row.turn_count,
            );
            // Store lessons as PATTERN_FACT entries in factsDb
            for (const lesson of traj.lessonsExtracted) {
              if (!lesson.trim() || factsDb.hasDuplicate(lesson)) continue;
              try {
                factsDb.store({
                  text: lesson,
                  category: "pattern",
                  importance: 0.6,
                  entity: null,
                  key: null,
                  value: lesson.slice(0, 200),
                  source: "implicit-feedback",
                  tags: ["trajectory", "feedback"],
                });
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "runExtractImplicitFeedbackForCli:store-lesson",
                  severity: "info",
                  subsystem: "implicit-feedback",
                });
              }
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "runExtractImplicitFeedbackForCli:insert-trajectory",
              severity: "info",
              subsystem: "implicit-feedback",
            });
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:build-trajectories",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }
  }

  // Phase 3: Closed-loop analysis
  let closedLoopReport: string | undefined;
  if (opts.includeClosedLoop !== false && !opts.dryRun) {
    try {
      const clCfg = cfg.closedLoop ?? { enabled: true };
      if (clCfg.enabled !== false) {
        const report = runClosedLoopAnalysis(factsDb, clCfg);
        if (report.rulesAnalyzed > 0) {
          if (opts.verbose) {
            closedLoopReport = getEffectivenessReport(factsDb);
          }
          logger?.info?.(`Closed-loop: analyzed ${report.rulesAnalyzed} rules, deprecated ${report.deprecated}, boosted ${report.boosted}`);
        }
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "runExtractImplicitFeedbackForCli:closed-loop",
        severity: "warning",
        subsystem: "implicit-feedback",
      });
    }
  }

  return {
    signalsExtracted: totalSignals,
    positiveCount,
    negativeCount,
    trajectoriesBuilt,
    sessionsScanned: filePaths.length,
    closedLoopReport,
  };
}

// ---------------------------------------------------------------------------
// Cross-agent learning CLI handler (Issue #263 — Phase 2)
// ---------------------------------------------------------------------------

export interface CrossAgentLearningCliResult {
  agentsScanned: number;
  lessonsConsidered: number;
  generalisedStored: number;
  linksCreated: number;
  skippedDuplicates: number;
  errors: number;
}

export async function runCrossAgentLearningForCli(ctx: HandlerContext): Promise<CrossAgentLearningCliResult> {
  const { factsDb, cfg } = ctx;
  const caCfg = cfg.crossAgentLearning;

  if (!caCfg?.enabled) {
    return { agentsScanned: 0, lessonsConsidered: 0, generalisedStored: 0, linksCreated: 0, skippedDuplicates: 0, errors: 0 };
  }

  // Build OpenAI proxy
  const openai = ctx.openai;

  const result = await runCrossAgentLearning(factsDb, openai, caCfg, ctx.logger ?? {});

  // Record savings: each generalised pattern avoids re-learning by other agents
  if (result.generalisedStored > 0 && ctx.costTracker) {
    ctx.costTracker.recordSavings({
      feature: "cross-agent-learning",
      action: "generalised pattern stored",
      countAvoided: result.generalisedStored,
      estimatedSavingUsd: result.generalisedStored * 0.001,
      note: `${result.agentsScanned} agent(s) scanned, ${result.skippedDuplicates} duplicates skipped`,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tool effectiveness CLI handler (Issue #263 — Phase 3)
// ---------------------------------------------------------------------------

export async function runToolEffectivenessForCli(
  ctx: HandlerContext,
  opts: { verbose?: boolean } = {},
): Promise<string> {
  const { cfg } = ctx;
  const teCfg = cfg.toolEffectiveness;

  if (teCfg?.enabled === false) {
    return "Tool effectiveness scoring is disabled (toolEffectiveness.enabled = false).";
  }

  // Derive the workflow store DB path from the sqlite path
  const sqlitePath = cfg.sqlitePath ?? join(homedir(), ".openclaw", "memory", "memory.db");
  const workflowDbPath = sqlitePath.replace(/(\.[^.]+)?$/, "-workflows.db");
  const effectivenessDbPath = sqlitePath.replace(/(\.[^.]+)?$/, "-tool-effectiveness.db");

  const effStore = new ToolEffectivenessStore(effectivenessDbPath);
  try {
    const report = await computeToolEffectiveness(
      workflowDbPath,
      effStore,
      teCfg ?? {},
      ctx.logger ?? {},
    );

    // Gap 3 (#263): Generate monthly report, gated to once per calendar month
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthlyKey = `tool-effectiveness-monthly-${month}`;
    try {
      const rawDb = ctx.factsDb.getRawDb();
      const existing = rawDb
        .prepare(`SELECT id FROM facts WHERE key = ? AND superseded_at IS NULL LIMIT 1`)
        .get(monthlyKey);
      if (!existing) {
        await generateMonthlyReport(effStore, ctx.factsDb);
      }
    } catch (mrErr) {
      capturePluginError(mrErr instanceof Error ? mrErr : new Error(String(mrErr)), {
        operation: "tool-effectiveness-monthly-report-check",
        subsystem: "tool-effectiveness",
        severity: "info",
      });
    }

    return formatToolEffectivenessReport(report);
  } finally {
    effStore.close();
  }
}

export interface CostReportCliOpts {
  days?: number;
  model?: boolean;
  feature?: string;
  csv?: boolean;
  /** Output format: "pretty" (default, emoji + percentages) or "compact" (terse, no emoji). */
  format?: "pretty" | "compact";
  /** Show config-mode cost estimate table instead of live data. */
  modes?: boolean;
}

/**
 * Show LLM cost breakdown by feature (or model with --model flag).
 * Issue #270.
 */
export function runCostReportForCli(
  ctx: HandlerContext,
  opts: CostReportCliOpts,
  sink: { log: (msg: string) => void },
): void {
  const { costTracker } = ctx;
  const { log } = sink;
  const days = opts.days ?? 7;
  const verbosity = ctx.cfg.verbosity ?? "normal";
  // quiet: only totals (compact layout); normal/verbose: full per-feature breakdown with savings
  const compact = opts.format === "compact" || verbosity === "quiet";

  // --modes: show config-mode cost estimate table (no live data needed)
  if (opts.modes) {
    const estimates = getModeCostEstimates();
    if (!compact) {
      log("");
      log("📊 Config-Mode Cost Estimates ($/month, estimated)");
      log("   Based on typical usage with the default cheapest model (gpt-4.1-nano).");
      log("   Actual costs depend on your volume, model choices, and feature config.");
      log("");
    } else {
      log("───── Config-Mode Cost Estimates ─────");
    }
    const modeW = 12;
    const descW = 58;
    const costW = 20;
    const header = [
      "Mode".padEnd(modeW),
      "Description".padEnd(descW),
      "Est. $/month".padStart(costW),
    ].join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const e of estimates) {
      const costRange = `$${e.monthlyLow.toFixed(2)} – $${e.monthlyHigh.toFixed(2)}`;
      log([
        e.mode.padEnd(modeW),
        e.description.padEnd(descW),
        costRange.padStart(costW),
      ].join("  "));
      if (!compact) {
        log(`${"".padEnd(modeW)}  Features: ${e.features.join(", ")}`);
        log("");
      }
    }
    if (!compact) {
      log(`Set mode: openclaw hybrid-mem config-mode <mode>`);
    }
    return;
  }

  if (!costTracker) {
    if (!ctx.cfg.costTracking.enabled) {
      log("Cost tracking is disabled.");
      log("Enable it: openclaw hybrid-mem config-set costTracking.enabled true");
    } else {
      log("Cost tracking is not available (costTracker not initialized).");
    }
    return;
  }

  function fmtNum(n: number): string {
    return n.toLocaleString("en-US");
  }
  function fmtCost(n: number): string {
    return `$${n.toFixed(4)}`;
  }
  function pct(part: number, total: number): string {
    if (total === 0) return "  0%";
    return `${Math.round((part / total) * 100)}%`.padStart(4);
  }

  if (opts.model) {
    // Model breakdown
    const breakdown = costTracker.getModelBreakdown(days);
    if (breakdown.length === 0) {
      if (compact) {
        log(`No LLM cost data in the last ${days} days.`);
      } else {
        log(`\n✅ Cost tracking is active — no data yet for the last ${days} days.`);
        log(`   Data appears after your first LLM calls (~1 hour of typical use).`);
      }
      return;
    }
    if (opts.csv) {
      log("model,calls,input_tokens,output_tokens,est_cost_usd");
      for (const r of breakdown) {
        log(`${r.model},${r.calls},${r.inputTokens},${r.outputTokens},${r.estimatedCostUsd.toFixed(6)}`);
      }
      return;
    }
    const total = breakdown.reduce(
      (acc, r) => ({ calls: acc.calls + r.calls, inputTokens: acc.inputTokens + r.inputTokens, outputTokens: acc.outputTokens + r.outputTokens, estimatedCostUsd: acc.estimatedCostUsd + r.estimatedCostUsd }),
      { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    );
    if (!compact) {
      log(`\n📊 LLM Cost Report — by Model (last ${days} days)`);
      log(`💰 Total: ${fmtCost(total.estimatedCostUsd)} across ${total.calls} calls`);
      log("");
    } else {
      log(`\n───── LLM Cost by Model (last ${days} days) ─────`);
    }
    const colW = [
      Math.max(20, ...breakdown.map((r) => r.model.length)) + 2,
      8, 12, 12, 12, 5,
    ];
    const header = [
      "Model".padEnd(colW[0]!),
      "Calls".padStart(colW[1]!),
      "In-Tokens".padStart(colW[2]!),
      "Out-Tokens".padStart(colW[3]!),
      "Est. Cost".padStart(colW[4]!),
      ...(compact ? [] : ["  %".padStart(colW[5]!)]),
    ].join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const r of breakdown) {
      log([
        r.model.padEnd(colW[0]!),
        String(r.calls).padStart(colW[1]!),
        fmtNum(r.inputTokens).padStart(colW[2]!),
        fmtNum(r.outputTokens).padStart(colW[3]!),
        fmtCost(r.estimatedCostUsd).padStart(colW[4]!),
        ...(compact ? [] : [pct(r.estimatedCostUsd, total.estimatedCostUsd).padStart(colW[5]!)]),
      ].join("  "));
    }
    log("─".repeat(header.length));
    log([
      "Total".padEnd(colW[0]!),
      String(total.calls).padStart(colW[1]!),
      fmtNum(total.inputTokens).padStart(colW[2]!),
      fmtNum(total.outputTokens).padStart(colW[3]!),
      fmtCost(total.estimatedCostUsd).padStart(colW[4]!),
      ...(compact ? [] : ["100%".padStart(colW[5]!)]),
    ].join("  "));
  } else {
    // Feature breakdown
    const report = costTracker.getReport({ days, feature: opts.feature });
    const savingsReport = costTracker.getSavingsReport(days);

    // Build a savings lookup by feature for fast join
    const savingsByFeature = new Map<string, number>();
    for (const s of savingsReport.features) {
      savingsByFeature.set(s.feature, s.estimatedSavingUsd);
    }

    if (report.features.length === 0) {
      if (compact) {
        log(`No LLM cost data in the last ${days} days.`);
      } else {
        log(`\n✅ Cost tracking is active — no data yet for the last ${days} days.`);
        log(`   Costs will appear here after your first LLM calls (~1 hour of typical use).`);
      }
      // Still show savings if any exist (value delivered without cost)
      if (savingsReport.total.estimatedSavingUsd > 0 && !compact) {
        log(`\n💚 Automation savings (last ${days} days): ${fmtCost(savingsReport.total.estimatedSavingUsd)} (${savingsReport.total.countAvoided} ops avoided)`);
      }
      return;
    }
    if (opts.csv) {
      log("feature,calls,input_tokens,output_tokens,est_cost_usd,est_savings_usd,net_cost_usd");
      for (const r of report.features) {
        const savings = savingsByFeature.get(r.feature) ?? 0;
        log(`${r.feature},${r.calls},${r.inputTokens},${r.outputTokens},${r.estimatedCostUsd.toFixed(6)},${savings.toFixed(6)},${(r.estimatedCostUsd - savings).toFixed(6)}`);
      }
      return;
    }

    const totalSavings = savingsReport.total.estimatedSavingUsd;
    const netCost = report.total.estimatedCostUsd - totalSavings;

    if (!compact) {
      const featureCount = report.features.length;
      log(`\n📊 LLM Cost Report — last ${days} days`);
      log(`💰 Gross cost: ${fmtCost(report.total.estimatedCostUsd)} across ${featureCount} feature${featureCount === 1 ? "" : "s"} (${report.total.calls} LLM calls)`);
      if (totalSavings > 0) {
        log(`💚 Automation savings: ${fmtCost(totalSavings)} (${savingsReport.total.countAvoided} ops avoided)`);
        log(`📉 Net cost: ${fmtCost(Math.max(0, netCost))}`);
      }
      log("");
    } else {
      log(`\n───── LLM Cost Report (last ${days} days) ─────`);
    }

    const hasSavings = totalSavings > 0;
    // Column widths: Feature | Calls | In-Tokens | Out-Tokens | Est.Cost | [Savings] | [Net] | [%]
    const colW = [
      Math.max(20, ...report.features.map((r) => r.feature.length)) + 2,
      8, 12, 12, 12,
      ...(hasSavings ? [12, 12] : []),
      ...(compact ? [] : [5]),
    ];
    const headerParts = [
      "Feature".padEnd(colW[0]!),
      "Calls".padStart(colW[1]!),
      "In-Tokens".padStart(colW[2]!),
      "Out-Tokens".padStart(colW[3]!),
      "Est. Cost".padStart(colW[4]!),
    ];
    if (hasSavings) {
      headerParts.push("Savings".padStart(colW[5]!));
      headerParts.push("Net Cost".padStart(colW[6]!));
    }
    if (!compact) {
      headerParts.push("  %".padStart(colW[hasSavings ? 7 : 5]!));
    }
    const header = headerParts.join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const r of report.features) {
      const savings = savingsByFeature.get(r.feature) ?? 0;
      const net = Math.max(0, r.estimatedCostUsd - savings);
      const parts = [
        r.feature.padEnd(colW[0]!),
        String(r.calls).padStart(colW[1]!),
        fmtNum(r.inputTokens).padStart(colW[2]!),
        fmtNum(r.outputTokens).padStart(colW[3]!),
        fmtCost(r.estimatedCostUsd).padStart(colW[4]!),
      ];
      if (hasSavings) {
        parts.push((savings > 0 ? `-$${savings.toFixed(4)}` : "").padStart(colW[5]!));
        parts.push(fmtCost(net).padStart(colW[6]!));
      }
      if (!compact) {
        parts.push(pct(r.estimatedCostUsd, report.total.estimatedCostUsd).padStart(colW[hasSavings ? 7 : 5]!));
      }
      log(parts.join("  "));
    }
    log("─".repeat(header.length));
    const totalParts = [
      "Total".padEnd(colW[0]!),
      String(report.total.calls).padStart(colW[1]!),
      fmtNum(report.total.inputTokens).padStart(colW[2]!),
      fmtNum(report.total.outputTokens).padStart(colW[3]!),
      fmtCost(report.total.estimatedCostUsd).padStart(colW[4]!),
    ];
    if (hasSavings) {
      totalParts.push((`-$${totalSavings.toFixed(4)}`).padStart(colW[5]!));
      totalParts.push(fmtCost(Math.max(0, netCost)).padStart(colW[6]!));
    }
    if (!compact) {
      totalParts.push("100%".padStart(colW[hasSavings ? 7 : 5]!));
    }
    log(totalParts.join("  "));
    log("");
    // Unknown-model warning
    if (report.unknownModelCalls > 0) {
      log(`⚠️  ${report.unknownModelCalls} call(s) used unrecognized models (cost unknown): ${report.unknownModels.join(", ")}`);
    }
    // Model summary line
    const modelBreakdown = costTracker.getModelBreakdown(days);
    if (modelBreakdown.length > 0) {
      const modelSummary = modelBreakdown
        .map((m) => `${m.model} (${m.calls} calls)`)
        .join(", ");
      log(`Models used: ${modelSummary}`);
    }
    // Savings breakdown if any (and we have savings not already shown inline)
    if (!hasSavings && savingsReport.features.length > 0) {
      log("");
      log(`💚 Automation savings (last ${days} days): ${fmtCost(savingsReport.total.estimatedSavingUsd)} (${savingsReport.total.countAvoided} ops avoided)`);
    }
  }
  log("");
  log("ℹ️  Costs are estimates based on published model pricing. Actual costs may vary.");
  log("   Embedding calls are not included in this report.");
}

