/**
 * CLI Install/Uninstall/Upgrade Command Handlers
 *
 * Contains all install-related functions extracted from handlers.ts:
 * - buildPreFilterConfig
 * - Cron constants and helpers (PLUGIN_JOB_ID_PREFIX, MIN_INTERVAL_MS,
 *   MAINTENANCE_CRON_JOBS, LEGACY_JOB_MATCHERS, resolveCronJob,
 *   ensureMaintenanceCronJobs, createProgressReporter)
 * - deepMerge
 * - runResetAuthBackoffForCli
 * - runInstallForCli
 * - runUninstallForCli
 * - runUpgradeForCli
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { HybridMemoryConfig } from "../config.js";
import { type CronModelConfig, getCronModelConfig, getDefaultCronModel } from "../config.js";
import { buildGuardPrefix } from "../services/cron-guard.js";
import { capturePluginError } from "../services/error-reporter.js";
import { type PreFilterConfig, preFilterSessions } from "../services/session-pre-filter.js";
import { resetAllBackoff } from "../utils/auth-failover.js";
import { PLUGIN_ID } from "../utils/constants.js";
import type { HandlerContext } from "./handlers.js";
import type { InstallCliResult, UninstallCliResult, UpgradeCliResult } from "./types.js";

/**
 * Build a PreFilterConfig from the plugin config.
 * Resolves the Ollama endpoint from extraction.preFilter.endpoint,
 * then llm.providers.ollama.baseURL, then the default localhost URL.
 */
export function buildPreFilterConfig(cfg: HybridMemoryConfig): PreFilterConfig {
  const pf = cfg.extraction?.preFilter;
  const ollamaEndpoint = pf?.endpoint ?? cfg.llm?.providers?.ollama?.baseURL ?? "http://localhost:11434";
  return {
    enabled: pf?.enabled === true,
    model: pf?.model ?? "qwen3:8b",
    endpoint: ollamaEndpoint,
    maxCharsPerSession: pf?.maxCharsPerSession ?? 2000,
  };
}
// Re-export preFilterSessions so callers in other handler modules can import from here.

// Shared cron job definitions used by install and verify --fix.
// Canonical schedule per #86 (7 jobs, non-overlapping). Model is resolved dynamically from user config via getLLMModelPreference.
// modelTier: "default" = standard LLM, "heavy" = larger context; resolved via getDefaultCronModel at install/verify time.
// Order: daily 02:00 → daily 02:30 → Sun 03:00 → Sun 04:00 → Sat 04:00 → Sun 10:00 → 1st 05:00.
const PLUGIN_JOB_ID_PREFIX = "hybrid-mem:";

/**
 * Minimum run interval guard (in milliseconds) for each job frequency tier.
 * When the cron runner triggers a job (e.g. on gateway restart), the agent-level
 * guard in the message prefix causes it to skip if it already ran within this interval.
 * Guard files are stored persistently in ~/.openclaw/cron/guard/ (issue #305).
 */
const MIN_INTERVAL_MS: Record<string, number> = {
  daily: 20 * 60 * 60 * 1000, // 20 hours (daily jobs)
  weekly: 5 * 24 * 60 * 60 * 1000, // 5 days (weekly jobs)
  monthly: 25 * 24 * 60 * 60 * 1000, // 25 days (monthly jobs)
};

// buildGuardPrefix is imported from services/cron-guard.ts (issue #305).

const MAINTENANCE_CRON_JOBS: Array<
  Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number; featureGate?: string }
> = [
  // Daily 02:00 | nightly-memory-sweep | prune → distill --days 3 → extract-daily
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}nightly-distill`,
    name: "nightly-memory-sweep",
    schedule: { kind: "cron", expr: "0 2 * * *" },
    channel: "system",
    message:
      "Nightly memory maintenance. Run in order:\n1. openclaw hybrid-mem prune\n2. openclaw hybrid-mem distill --days 3\n3. openclaw hybrid-mem extract-daily\n4. openclaw hybrid-mem resolve-contradictions\nCheck if distill is enabled (config distill.enabled !== false) before steps 2 and 3. If disabled, skip steps 2 and 3 and exit 0. Report counts.",
    isolated: true,
    modelTier: "default",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
  },
  // Daily 02:30 | self-correction-analysis | self-correction-run
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}self-correction-analysis`,
    name: "self-correction-analysis",
    schedule: { kind: "cron", expr: "30 2 * * *" },
    channel: "system",
    message:
      "Run self-correction analysis: openclaw hybrid-mem self-correction-run. Check if self-correction is enabled (config selfCorrection is truthy). Exit 0 if disabled.",
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
  },
  // Sunday 03:00 | weekly-reflection | reflect --verbose → reflect-rules → reflect-meta
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-reflection`,
    name: "weekly-reflection",
    schedule: { kind: "cron", expr: "0 3 * * 0" },
    channel: "system",
    message:
      "Run weekly reflection pipeline:\n1. openclaw hybrid-mem reflect --verbose\n2. openclaw hybrid-mem reflect-rules --verbose\n3. openclaw hybrid-mem reflect-meta --verbose\nCheck reflection.enabled. Exit 0 if disabled.",
    isolated: true,
    modelTier: "default",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // Sunday 04:00 | weekly-extract-procedures (nano = background model, avoids locking main AI)
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-extract-procedures`,
    name: "weekly-extract-procedures",
    schedule: { kind: "cron", expr: "0 4 * * 0" },
    channel: "system",
    message:
      "Run weekly extraction pipeline:\n1. openclaw hybrid-mem extract-procedures --days 7\n2. openclaw hybrid-mem extract-directives --days 7\n3. openclaw hybrid-mem extract-reinforcement --days 7\n4. openclaw hybrid-mem generate-auto-skills\nCheck feature configs. Exit 0 if all disabled.",
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // Saturday 04:00 | weekly-deep-maintenance | compact → vectordb-optimize → scope promote
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-deep-maintenance`,
    name: "weekly-deep-maintenance",
    schedule: { kind: "cron", expr: "0 4 * * 6" },
    channel: "system",
    message:
      "Run weekly deep maintenance:\n1. openclaw hybrid-mem compact\n2. openclaw hybrid-mem vectordb-optimize\n3. openclaw hybrid-mem scope promote\nReport counts for each step.",
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // Sunday 10:00 | weekly-persona-proposals | generate-proposals → notify if pending
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-persona-proposals`,
    name: "weekly-persona-proposals",
    schedule: { kind: "cron", expr: "0 10 * * 0" },
    channel: "system",
    message:
      "Run: openclaw hybrid-mem generate-proposals. This creates persona proposals from recent reflection insights. If there are pending proposals, notify the user in this system channel with a concise summary of the proposals. Exit 0 if personaProposals disabled.",
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // 1st of month 05:00 | monthly-consolidation | consolidate → build-languages → backfill-decay
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}monthly-consolidation`,
    name: "monthly-consolidation",
    schedule: { kind: "cron", expr: "0 5 1 * *" },
    channel: "system",
    message:
      "Run monthly consolidation:\n1. openclaw hybrid-mem consolidate --threshold 0.92\n2. openclaw hybrid-mem build-languages\n3. openclaw hybrid-mem backfill-decay\nReport what was merged, languages detected. Check feature configs. Exit 0 if all disabled.",
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.monthly,
  },
  // Daily 02:45 | nightly-dream-cycle | dream-cycle (prune → consolidate → reflect)
  // Phase 2.7: Only install when nightlyCycle.enabled; off by default (Phase 1).
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`,
    name: "nightly-dream-cycle",
    schedule: { kind: "cron", expr: "45 2 * * *" },
    channel: "system",
    message:
      "Run nightly dream cycle: openclaw hybrid-mem dream-cycle\nThis runs in order: (1) prune expired/decayed facts, (2) consolidate old episodic events into facts, (3) reflect on recent facts to extract patterns, (4) extract rules if enough patterns accumulated.\nCheck if nightlyCycle.enabled is true in config before running. Exit 0 if disabled. Report counts: facts pruned, events consolidated, patterns found, rules generated.",
    isolated: true,
    modelTier: "default",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
    featureGate: "nightlyCycle.enabled",
  },
  // Every 4h | sensor-sweep | tier-1 + tier-2 data collection (no LLM, Issue #236)
  // Default schedule; overridden by cfg.sensorSweep.schedule during install/verify/upgrade.
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}sensor-sweep`,
    name: "sensor-sweep",
    schedule: { kind: "cron", expr: "0 */4 * * *" },
    channel: "system",
    message:
      "Run sensor sweep data collection (no LLM):\n1. openclaw hybrid-mem sensor-sweep --tier 1\n2. openclaw hybrid-mem sensor-sweep --tier 2\nCheck if sensorSweep.enabled is true in config before running. Exit 0 if disabled. Report events written and skipped per sensor.",
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: 3 * 60 * 60 * 1000,
    featureGate: "sensorSweep.enabled",
  },
];

/** Resolve model for a cron job def and return a job record suitable for the store (has model, no modelTier).
 * Strips the top-level `channel` field (maintenance jobs don't need user delivery) and sets delivery.mode = "none"
 * so the job runner never tries to send a WhatsApp/channel notification for plugin-internal jobs.
 * If the def has minIntervalMs, prepends a guard prefix to the message to prevent re-runs on gateway restart (#304). */
function resolveCronJob(
  def: Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number },
  pluginConfig: CronModelConfig | undefined,
): Record<string, unknown> {
  const { modelTier, channel: _channel, minIntervalMs, featureGate: _featureGate, ...rest } = def;
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
  [`${PLUGIN_JOB_ID_PREFIX}nightly-distill`]: (j) =>
    String(j.name ?? "")
      .toLowerCase()
      .includes("nightly-memory-sweep"),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-reflection`]: (j) =>
    /weekly-reflection|memory reflection|pattern synthesis/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-extract-procedures`]: (j) =>
    /extract-procedures|weekly-extract-procedures|procedural memory/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}self-correction-analysis`]: (j) =>
    /self-correction-analysis|self-correction\b/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-deep-maintenance`]: (j) =>
    /weekly-deep-maintenance|deep maintenance/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-persona-proposals`]: (j) =>
    /weekly-persona-proposals|persona proposals/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}monthly-consolidation`]: (j) => /monthly-consolidation/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`]: (j) => /nightly-dream-cycle|dream.cycle/i.test(String(j.name ?? "")),
};

/**
 * Ensure maintenance cron jobs exist in ~/.openclaw/cron/jobs.json. Add any missing jobs; optionally normalize existing (schedule, pluginJobId).
 * Never re-enables jobs the user has disabled unless reEnableDisabled is true (callers should pass false to honor disabled jobs).
 * scheduleOverrides: optional map pluginJobId -> cron expr.
 * messageOverrides: optional map pluginJobId -> cron job message string.
 */
export function ensureMaintenanceCronJobs(
  openclawDir: string,
  pluginConfig: CronModelConfig | undefined,
  options: {
    normalizeExisting?: boolean;
    reEnableDisabled?: boolean;
    scheduleOverrides?: Record<string, string>;
    messageOverrides?: Record<string, string>;
    featureGates?: Record<string, boolean>;
  } = {},
): { added: string[]; normalized: string[] } {
  const {
    normalizeExisting = false,
    reEnableDisabled = false,
    scheduleOverrides,
    messageOverrides,
    featureGates,
  } = options;
  const added: string[] = [];
  const normalized: string[] = [];
  const cronDir = join(openclawDir, "cron");
  const cronStorePath = join(cronDir, "jobs.json");
  mkdirSync(cronDir, { recursive: true });
  const store: { jobs?: unknown[] } = existsSync(cronStorePath)
    ? (JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] })
    : {};
  if (!Array.isArray(store.jobs)) store.jobs = [];
  const jobsArr = store.jobs as Array<Record<string, unknown>>;
  let jobsChanged = false;
  for (const def of MAINTENANCE_CRON_JOBS) {
    const id = def.pluginJobId as string;
    const name = def.name as string;
    const scheduleExpr = scheduleOverrides?.[id];
    const existing = jobsArr.find((j) => j && (j.pluginJobId === id || LEGACY_JOB_MATCHERS[id]?.(j)));
    // If feature gate is explicitly disabled, disable existing job (if any) and mark it as
    // feature-gate-disabled so we can re-enable it later when the gate turns back on.
    // This distinguishes system-controlled disable from user-controlled disable.
    if (def.featureGate && featureGates && featureGates[def.featureGate] !== true) {
      if (existing && existing.enabled !== false) {
        existing.enabled = false;
        existing.featureGateDisabled = true;
        jobsChanged = true;
      }
      continue;
    }
    // Feature gate evaluates to true: re-enable the job ONLY if it was previously disabled by the
    // feature gate (featureGateDisabled === true). Never re-enable jobs the user disabled manually.
    if (
      def.featureGate &&
      featureGates &&
      featureGates[def.featureGate] === true &&
      existing &&
      existing.enabled === false &&
      existing.featureGateDisabled === true
    ) {
      existing.enabled = true;
      existing.featureGateDisabled = undefined;
      jobsChanged = true;
    }
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
        // Issue #304: Add guard prefix if missing.
        // Issue #305: Also migrate old /tmp/ guard paths to persistent ~/.openclaw/cron/guard/ paths.
        // The on-disk format uses payload.message (agentTurn jobs), but older entries may use top-level message.
        if (def.minIntervalMs) {
          const jobSlug = name.replace(/\s+/g, "-");
          const guard = buildGuardPrefix(jobSlug, def.minIntervalMs as number);
          const oldTmpPath = `/tmp/hybrid-mem-guard-${jobSlug}`;
          const payload = existing.payload as { message?: string; kind?: string } | undefined;
          if (payload && typeof payload.message === "string") {
            if (!payload.message.includes("GUARD CHECK")) {
              // Add guard prefix if missing (issue #304)
              payload.message = guard + payload.message;
              jobsChanged = true;
              if (!normalized.includes(name)) normalized.push(name);
            } else if (payload.message.includes(oldTmpPath)) {
              // Migrate old /tmp/ guard path to persistent path (issue #305)
              const doubleLf = payload.message.indexOf("\n\n");
              if (doubleLf >= 0) {
                payload.message = guard + payload.message.slice(doubleLf + 2);
                jobsChanged = true;
                if (!normalized.includes(name)) normalized.push(name);
              }
            }
          } else if (typeof existing.message === "string") {
            if (!existing.message.includes("GUARD CHECK")) {
              existing.message = guard + existing.message;
              jobsChanged = true;
              if (!normalized.includes(name)) normalized.push(name);
            } else if (existing.message.includes(oldTmpPath)) {
              const doubleLf = existing.message.indexOf("\n\n");
              if (doubleLf >= 0) {
                existing.message = guard + existing.message.slice(doubleLf + 2);
                jobsChanged = true;
                if (!normalized.includes(name)) normalized.push(name);
              }
            }
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
export function createProgressReporter(
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
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else if (tgtVal === undefined) {
      (target as Record<string, unknown>)[key] = srcVal;
    }
  }
}

/**
 * Reset OAuth failover backoff state.
 */
export async function runResetAuthBackoffForCli(ctx: HandlerContext): Promise<void> {
  const statePath = join(dirname(ctx.resolvedSqlitePath), ".auth-backoff.json");
  resetAllBackoff({ statePath });
  console.log(
    "OAuth failover backoff cleared. Next LLM calls will try OAuth again for providers with both OAuth and API key.",
  );
}

/**
 * Get plugin config from file
 */
export function getPluginConfigFromFile(
  configPath: string,
): { config: Record<string, unknown>; root: Record<string, unknown> } | { error: string } {
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

/** Build install-time OpenClaw defaults for hybrid memory.
 *
 * `agents.defaults.memorySearch` intentionally omits `provider` and `model` so
 * OpenClaw can use the same embedding provider/model the user already configured
 * elsewhere (for example Azure Foundry, Cohere, NVIDIA, or other gateway-backed
 * providers) instead of pinning memorySearch to a fixed provider enum.
 */
export function buildInstallDefaults(pluginId: string = PLUGIN_ID): Record<string, unknown> {
  return {
    memory: { backend: "builtin" as const, citations: "auto" as const },
    plugins: {
      slots: { memory: pluginId },
      entries: {
        "memory-core": { enabled: true },
        [pluginId]: {
          enabled: true,
          config: {
            mode: "local",
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
            credentials: {
              enabled: false,
              store: "sqlite" as const,
              encryptionKey: "",
              autoDetect: false,
              expiryWarningDays: 7,
            },
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
            systemPrompt:
              "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
            prompt:
              "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving.",
          },
        },
      },
    },
  };
}

/** Get plugin entry config from root openclaw config (for schedule overrides etc.). */
function getPluginEntryConfig(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const plugins = root?.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const entry = entries?.[PLUGIN_ID] as Record<string, unknown> | undefined;
  const config = entry?.config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : undefined;
}

/**
 * Install plugin configuration and cron jobs
 */
export function runInstallForCli(opts: { dryRun: boolean }): InstallCliResult {
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const fullDefaults = buildInstallDefaults();

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runInstallForCli:read-config" });
      return { ok: false, error: `Could not read ${configPath}: ${e}` };
    }
  }
  const existingApiKey =
    (config?.plugins as Record<string, unknown>)?.entries &&
    ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)?.[PLUGIN_ID] &&
    (
      ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<
        string,
        unknown
      >
    )?.config &&
    (
      (
        ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<
          string,
          unknown
        >
      ).config as Record<string, unknown>
    )?.embedding &&
    (
      (
        (
          ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<
            string,
            unknown
          >
        ).config as Record<string, unknown>
      ).embedding as Record<string, unknown>
    )?.apiKey;
  const isRealKey =
    typeof existingApiKey === "string" &&
    existingApiKey.length >= 10 &&
    existingApiKey !== "YOUR_OPENAI_API_KEY" &&
    existingApiKey !== "<OPENAI_API_KEY>";

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
      const dreamCycleRaw = pluginCfg?.nightlyCycle as Record<string, unknown> | undefined;
      const dreamCycleSchedule =
        typeof dreamCycleRaw?.schedule === "string" && (dreamCycleRaw.schedule as string).trim().length > 0
          ? (dreamCycleRaw.schedule as string).trim()
          : undefined;
      const sensorSweepRaw = pluginCfg?.sensorSweep as Record<string, unknown> | undefined;
      const sensorSweepSchedule =
        typeof sensorSweepRaw?.schedule === "string" && (sensorSweepRaw.schedule as string).trim().length > 0
          ? (sensorSweepRaw.schedule as string).trim()
          : undefined;
      const installScheduleOverrides: Record<string, string> = {};
      if (dreamCycleSchedule)
        installScheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`] = dreamCycleSchedule;
      if (sensorSweepSchedule) installScheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}sensor-sweep`] = sensorSweepSchedule;
      ensureMaintenanceCronJobs(openclawDir, pluginConfig, {
        normalizeExisting: false,
        reEnableDisabled: false,
        scheduleOverrides: Object.keys(installScheduleOverrides).length > 0 ? installScheduleOverrides : undefined,
        featureGates: {
          "sensorSweep.enabled": (sensorSweepRaw?.enabled as boolean | undefined) === true,
          "nightlyCycle.enabled": (dreamCycleRaw?.enabled as boolean | undefined) === true,
        },
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

export async function runUpgradeForCli(ctx: HandlerContext, requestedVersion?: string): Promise<UpgradeCliResult> {
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
    if (typeof cfg.nightlyCycle?.schedule === "string" && cfg.nightlyCycle.schedule.trim().length > 0) {
      scheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`] = cfg.nightlyCycle.schedule;
    }
    if (typeof cfg.sensorSweep?.schedule === "string" && cfg.sensorSweep.schedule.trim().length > 0) {
      scheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}sensor-sweep`] = cfg.sensorSweep.schedule;
    }
    const { added, normalized } = ensureMaintenanceCronJobs(openclawDir, pluginConfig, {
      normalizeExisting: true,
      reEnableDisabled: false,
      scheduleOverrides: Object.keys(scheduleOverrides).length > 0 ? scheduleOverrides : undefined,
      featureGates: {
        "sensorSweep.enabled": cfg.sensorSweep?.enabled === true,
        "nightlyCycle.enabled": cfg.nightlyCycle?.enabled === true,
      },
    });
    if (added.length > 0 || normalized.length > 0) {
      logger?.info?.(
        `memory-hybrid: upgrade — cron jobs: ${added.length} added, ${normalized.length} normalized (disabled jobs left as-is). Run openclaw hybrid-mem verify to confirm.`,
      );
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runUpgradeForCli:ensure-cron-jobs" });
    // non-fatal: user can run verify --fix later
  }
  return { ok: true, version: installedVersion, pluginDir: extDir };
}
