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

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getEnv } from "../utils/env-manager.js";
import { expandTilde } from "../utils/path.js";

import type { HybridMemoryConfig } from "../config.js";
import { type CronModelConfig, getCronModelConfig, getDefaultCronModel } from "../config.js";
import { buildGuardPrefix } from "../services/cron-guard.js";
import { capturePluginError } from "../services/error-reporter.js";
import { type PreFilterConfig, preFilterSessions } from "../services/session-pre-filter.js";
import { resetAllBackoff } from "../utils/auth-failover.js";
import { PLUGIN_ID } from "../utils/constants.js";
import {
  extractCronStoreJobModel,
  readAgentsPrimaryModelFromOpenclawJsonPath,
  setCronStoreJobModelFields,
} from "../utils/openclaw-agent-defaults.js";
import type { HandlerContext } from "./handlers.js";
import type { InstallCliResult, UninstallCliResult, UpgradeCliResult } from "./types.js";

/** Subfolder under workspace `skills/` — OpenClaw loads this with highest precedence vs shared/bundled skills. */
const HYBRID_MEMORY_SKILL_DIR = "hybrid-memory";

/** Reject empty paths and the literal strings "undefined"/"null" (common when env vars are set incorrectly). */
function isUsableWorkspacePath(p: string): boolean {
  const t = p.trim();
  if (t.length === 0) return false;
  const lower = t.toLowerCase();
  if (lower === "undefined" || lower === "null") return false;
  return true;
}

/**
 * Resolve the agent workspace root (where `skills/`, `memory/`, MEMORY.md, etc. live).
 * Order: `OPENCLAW_WORKSPACE` (if valid), `agents.defaults.workspace`, `agent.workspace` (OpenClaw [agent workspace](https://docs.openclaw.ai/concepts/agent-workspace) shape), else `~/.openclaw/workspace`.
 */
export function resolveAgentWorkspaceRoot(config: Record<string, unknown>): string {
  const env = process.env.OPENCLAW_WORKSPACE?.trim();
  if (env && isUsableWorkspacePath(env)) return expandTilde(env);
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const ws = defaults?.workspace;
  if (typeof ws === "string" && isUsableWorkspacePath(ws)) return expandTilde(ws.trim());
  const agentBlock = config.agent as Record<string, unknown> | undefined;
  const legacyWs = agentBlock?.workspace;
  if (typeof legacyWs === "string" && isUsableWorkspacePath(legacyWs)) return expandTilde(legacyWs.trim());
  return join(homedir(), ".openclaw", "workspace");
}

function bundledHybridMemorySkillDir(pluginRootDir: string): string {
  return join(pluginRootDir, "skills", HYBRID_MEMORY_SKILL_DIR);
}

function bundledHybridMemorySkillPath(pluginRootDir: string): string {
  return join(bundledHybridMemorySkillDir(pluginRootDir), "SKILL.md");
}

/** @internal Exported for tests — copies bundled `skills/hybrid-memory/` (SKILL.md + references/) into the workspace. */
export function installHybridMemoryWorkspaceSkill(opts: {
  mergedOpenclawConfig: Record<string, unknown>;
  pluginRootDir: string;
  dryRun: boolean;
}): { path: string; error?: string } {
  const srcDir = bundledHybridMemorySkillDir(opts.pluginRootDir);
  const skillMd = bundledHybridMemorySkillPath(opts.pluginRootDir);
  const workspaceRoot = resolveAgentWorkspaceRoot(opts.mergedOpenclawConfig);
  const dest = join(workspaceRoot, "skills", HYBRID_MEMORY_SKILL_DIR, "SKILL.md");
  if (!existsSync(skillMd)) {
    return { path: dest, error: `Bundled skill missing at ${skillMd}` };
  }
  if (opts.dryRun) {
    return { path: dest };
  }
  try {
    mkdirSync(join(workspaceRoot, "skills"), { recursive: true });
    const destDir = join(workspaceRoot, "skills", HYBRID_MEMORY_SKILL_DIR);
    cpSync(srcDir, destDir, { recursive: true });
    return { path: dest };
  } catch (err) {
    return { path: dest, error: String(err) };
  }
}

/**
 * Path to merged OpenClaw config JSON for workspace resolution and skill bootstrap.
 * Order: `OPENCLAW_CONFIG`, `OPENCLAW_CONFIG_PATH`, then `{OPENCLAW_HOME}/openclaw.json`, else `~/.openclaw/openclaw.json`.
 */
export function resolveOpenclawJsonPathForWorkspace(): string {
  const explicit = getEnv("OPENCLAW_CONFIG")?.trim() || getEnv("OPENCLAW_CONFIG_PATH")?.trim();
  if (explicit) return expandTilde(explicit);
  const owHome = getEnv("OPENCLAW_HOME")?.trim();
  if (owHome) return join(expandTilde(owHome), "openclaw.json");
  return join(homedir(), ".openclaw", "openclaw.json");
}

/**
 * Load `openclaw.json` for workspace resolution (`agents.defaults.workspace`, etc.).
 * Returns `{}` if the file is missing or unreadable (caller still gets `OPENCLAW_WORKSPACE` via env in {@link resolveAgentWorkspaceRoot}).
 */
export function loadOpenclawRootForWorkspace(): Record<string, unknown> {
  const configPath = resolveOpenclawJsonPathForWorkspace();
  try {
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Copy bundled `skills/hybrid-memory/` into the workspace **only when** `{workspace}/skills/hybrid-memory/SKILL.md`
 * is missing — so the skill appears without a manual `hybrid-mem install`, without overwriting operator edits on every restart.
 * Full overwrite (including references) remains the job of `installHybridMemoryWorkspaceSkill` from **`hybrid-mem install`**.
 */
export function ensureHybridMemoryWorkspaceSkillIfMissing(opts: {
  pluginRootDir: string;
  mergedOpenclawConfig: Record<string, unknown>;
}): {
  path: string;
  deployed: boolean;
  skippedReason?: "already_exists" | "bundled_missing" | string;
} {
  const skillMd = bundledHybridMemorySkillPath(opts.pluginRootDir);
  const workspaceRoot = resolveAgentWorkspaceRoot(opts.mergedOpenclawConfig);
  const destDir = join(workspaceRoot, "skills", HYBRID_MEMORY_SKILL_DIR);
  const dest = join(destDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    return { path: dest, deployed: false, skippedReason: "bundled_missing" };
  }
  if (existsSync(dest)) {
    return { path: dest, deployed: false, skippedReason: "already_exists" };
  }
  // Avoid clobbering a partial or hand-edited tree when SKILL.md alone is missing.
  if (existsSync(destDir)) {
    return { path: dest, deployed: false, skippedReason: "destination_dir_exists" };
  }
  try {
    mkdirSync(join(workspaceRoot, "skills"), { recursive: true });
    const srcDir = bundledHybridMemorySkillDir(opts.pluginRootDir);
    cpSync(srcDir, destDir, { recursive: true });
    return { path: dest, deployed: true };
  } catch (err) {
    return { path: dest, deployed: false, skippedReason: String(err) };
  }
}

const TOOLS_MD_MANAGED_BEGIN = "<!-- openclaw-hybrid-memory:managed-begin -->";
const TOOLS_MD_MANAGED_END = "<!-- openclaw-hybrid-memory:managed-end -->";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getToolsMdManagedBlockRe(): RegExp {
  return new RegExp(`${escapeRegExp(TOOLS_MD_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(TOOLS_MD_MANAGED_END)}`);
}

/** True if applying the managed block would modify `existing` (append, replace, or replace with different body). */
function toolsMdManagedBlockWouldChange(existing: string, newBlock: string): boolean {
  const re = getToolsMdManagedBlockRe();
  if (!re.test(existing)) return true;
  return existing.replace(re, newBlock) !== existing;
}

function buildHybridMemoryToolsMdManagedBlock(innerBody: string): string {
  const inner = innerBody.trimEnd();
  return [
    TOOLS_MD_MANAGED_BEGIN,
    "",
    "## Hybrid memory (`openclaw-hybrid-memory`)",
    "",
    "_This section is refreshed by `openclaw hybrid-mem install` / `upgrade`. Add your own tool notes elsewhere in this file._",
    "",
    inner,
    "",
    TOOLS_MD_MANAGED_END,
  ].join("\n");
}

/** @internal Merges or refreshes the managed Hybrid memory block in workspace `TOOLS.md`. */
export function applyHybridMemoryToolsMd(opts: {
  mergedOpenclawConfig: Record<string, unknown>;
  pluginRootDir: string;
  dryRun: boolean;
}): { path: string; error?: string; updated: boolean } {
  const workspaceRoot = resolveAgentWorkspaceRoot(opts.mergedOpenclawConfig);
  const toolsPath = join(workspaceRoot, "TOOLS.md");
  const snippetPath = join(opts.pluginRootDir, "workspace-snippets", "TOOLS-hybrid-memory-body.md");
  if (!existsSync(snippetPath)) {
    return { path: toolsPath, error: `Bundled TOOLS snippet missing at ${snippetPath}`, updated: false };
  }
  let innerBody: string;
  try {
    innerBody = readFileSync(snippetPath, "utf-8");
  } catch (err) {
    return { path: toolsPath, error: String(err), updated: false };
  }
  const block = buildHybridMemoryToolsMdManagedBlock(innerBody);
  if (opts.dryRun) {
    let wouldChange = !existsSync(toolsPath);
    if (!wouldChange && existsSync(toolsPath)) {
      try {
        const cur = readFileSync(toolsPath, "utf-8");
        wouldChange = !cur.includes(TOOLS_MD_MANAGED_BEGIN) || toolsMdManagedBlockWouldChange(cur, block);
      } catch {
        wouldChange = true;
      }
    }
    return { path: toolsPath, updated: wouldChange };
  }
  const managedRe = getToolsMdManagedBlockRe();
  try {
    mkdirSync(workspaceRoot, { recursive: true });
    if (!existsSync(toolsPath)) {
      writeFileSync(toolsPath, `# TOOLS\n\n${block}\n`, "utf-8");
      return { path: toolsPath, updated: true };
    }
    const existing = readFileSync(toolsPath, "utf-8");
    if (managedRe.test(existing)) {
      const next = existing.replace(managedRe, block);
      if (next !== existing) {
        writeFileSync(toolsPath, next, "utf-8");
        return { path: toolsPath, updated: true };
      }
      return { path: toolsPath, updated: false };
    }
    writeFileSync(toolsPath, `${existing.trimEnd()}\n\n${block}\n`, "utf-8");
    return { path: toolsPath, updated: true };
  } catch (err) {
    return { path: toolsPath, error: String(err), updated: false };
  }
}

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

// Each entry uses pluginJobId as stable identity; resolveCronJob also sets `id` to that value for gateway `cron.run` / UI parity.
const MAINTENANCE_CRON_JOBS: Array<
  Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number; featureGate?: string }
> = [
  // Daily 02:00 | nightly-memory-sweep | prune → distill --days 3 → extract-daily
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}nightly-distill`,
    sessionTarget: "isolated",
    name: "nightly-memory-sweep",
    schedule: { kind: "cron", expr: "0 2 * * *" },
    channel: "system",
    message:
      "Nightly memory maintenance. Run in order:\n1. openclaw hybrid-mem prune\n2. openclaw hybrid-mem distill --days 3\n3. openclaw hybrid-mem extract-daily\n4. openclaw hybrid-mem resolve-contradictions\n5. openclaw hybrid-mem enrich-entities --limit 200\nCheck if distill is enabled (config distill.enabled !== false) before steps 2 and 3. If disabled, skip steps 2 and 3. Check if graph is enabled (config graph.enabled === true) before step 5. If graph is disabled, skip step 5. Exit 0 if all steps skipped. Step 5 backfills PERSON/ORG extraction for facts missing mentions (uses LLM). Report counts.",
    isolated: true,
    modelTier: "default",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
  },
  // Daily 02:30 | self-correction-analysis | self-correction-run
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}self-correction-analysis`,
    sessionTarget: "isolated",
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
    sessionTarget: "isolated",
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
    sessionTarget: "isolated",
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
    sessionTarget: "isolated",
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
    sessionTarget: "isolated",
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
    sessionTarget: "isolated",
    name: "monthly-consolidation",
    schedule: { kind: "cron", expr: "0 5 1 * *" },
    channel: "system",
    message:
      "Run monthly consolidation:\n1. openclaw hybrid-mem consolidate --threshold 0.92\n2. openclaw hybrid-mem build-languages\n3. openclaw hybrid-mem backfill-decay\n4. openclaw hybrid-mem enrich-entities --limit 500\nCheck if graph is enabled (config graph.enabled === true) before step 4. If graph is disabled, skip step 4. Report what was merged, languages detected, and enrichment counts.",
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.monthly,
  },
  // Daily 02:45 | nightly-dream-cycle | dream-cycle (prune → consolidate → reflect)
  // Phase 2.7: Only install when nightlyCycle.enabled; off by default (Phase 1).
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`,
    sessionTarget: "isolated",
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
    sessionTarget: "isolated",
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

/**
 * When `agents.defaults.model.primary` is set, use it for maintenance cron `model` so agent-bound
 * runs match `resolveLiveSessionModelSelection` (OpenClaw #963 / hybrid-memory #963). Otherwise
 * use tier defaults from plugin LLM config.
 */
function resolveCronJobModel(
  tier: "nano" | "default" | "heavy",
  pluginConfig: CronModelConfig | undefined,
  agentPrimary: string | undefined,
): string {
  const trimmed = agentPrimary?.trim();
  if (trimmed) return trimmed;
  return getDefaultCronModel(pluginConfig, tier);
}

/** Resolve model for a cron job def and return a job record suitable for the store (has model, no modelTier).
 * Strips the top-level `channel` field (maintenance jobs don't need user delivery) and sets delivery.mode = "none"
 * so the job runner never tries to send a WhatsApp/channel notification for plugin-internal jobs.
 * If the def has minIntervalMs, prepends a guard prefix to the message to prevent re-runs on gateway restart (#304). */
function resolveCronJob(
  def: Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number },
  pluginConfig: CronModelConfig | undefined,
  agentPrimary: string | undefined,
): Record<string, unknown> {
  const { modelTier, channel: _channel, minIntervalMs, featureGate: _featureGate, ...rest } = def;
  const tier = modelTier ?? "default";
  const model = resolveCronJobModel(tier, pluginConfig, agentPrimary);
  // Prepend guard prefix to message if minIntervalMs is set (issue #304)
  if (minIntervalMs && typeof rest.message === "string") {
    const jobName = (typeof rest.name === "string" ? rest.name : "unknown").replace(/\s+/g, "-");
    rest.message = buildGuardPrefix(jobName, minIntervalMs) + rest.message;
  }
  const pluginJobId = rest.pluginJobId;
  const stableId = typeof pluginJobId === "string" && pluginJobId.trim().length > 0 ? pluginJobId.trim() : undefined;
  return { ...rest, ...(stableId ? { id: stableId } : {}), model, delivery: { mode: "none" as const } };
}

function hasIsolatedCronSessionTarget(job: Record<string, unknown>): boolean {
  if (job.sessionTarget === "isolated" || job.isolated === true) return true;
  const payload = job.payload as Record<string, unknown> | undefined;
  if (!payload) return false;
  return payload.sessionTarget === "isolated" || payload.isolated === true;
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
  const openclawConfigPath = join(openclawDir, "openclaw.json");
  const agentPrimary = readAgentsPrimaryModelFromOpenclawJsonPath(openclawConfigPath);
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
      const job = resolveCronJob(def, pluginConfig, agentPrimary) as Record<string, unknown>;
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
        if (!existing.id && typeof existing.pluginJobId === "string" && existing.pluginJobId.length > 0) {
          existing.id = existing.pluginJobId;
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        if (
          id.startsWith(PLUGIN_JOB_ID_PREFIX) &&
          hasIsolatedCronSessionTarget(existing) &&
          existing.sessionTarget !== "isolated"
        ) {
          existing.sessionTarget = "isolated";
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        if (
          id.startsWith(PLUGIN_JOB_ID_PREFIX) &&
          hasIsolatedCronSessionTarget(existing) &&
          Object.prototype.hasOwnProperty.call(existing, "sessionKey")
        ) {
          // Issue #977: plugin maintenance jobs must not pin an interactive session.
          // Omit sessionKey so OpenClaw uses isolated default session key: cron:<jobId>.
          existing.sessionKey = undefined;
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
        // Issue #963: keep stored job model aligned with agents.defaults.model.primary when set,
        // so agentTurn + agentId sessions do not throw LiveSessionModelSwitchError.
        if (agentPrimary?.trim()) {
          const tier = (def.modelTier ?? "default") as "nano" | "default" | "heavy";
          const desired = resolveCronJobModel(tier, pluginConfig, agentPrimary);
          const current = extractCronStoreJobModel(existing);
          if (current !== desired) {
            setCronStoreJobModelFields(existing, desired);
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
  if (jobsChanged) {
    const payload = JSON.stringify(store, null, 2);
    const tmpPath = `${cronStorePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, payload, "utf-8");
    renameSync(tmpPath, cronStorePath);
  }
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
 * Install plugin configuration and cron jobs.
 * `buildInstallDefaults()` includes `mode: "local"`; `deepMerge` only fills missing keys,
 * so an existing `plugins.entries[pluginId].config.mode` is never overwritten on re-install.
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

  const pluginRootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

  if (opts.dryRun) {
    const skillPreview = installHybridMemoryWorkspaceSkill({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: true,
    });
    const toolsPreview = applyHybridMemoryToolsMd({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: true,
    });
    return {
      ok: true,
      configPath,
      dryRun: true,
      written: false,
      configJson: after,
      pluginId: PLUGIN_ID,
      workspaceSkillPath: skillPreview.path,
      workspaceSkillError: skillPreview.error,
      workspaceToolsMdPath: toolsPreview.path,
      workspaceToolsMdError: toolsPreview.error,
      workspaceToolsMdUpdated: toolsPreview.updated,
    };
  }

  try {
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(join(openclawDir, "memory"), { recursive: true });
    writeFileSync(configPath, after, "utf-8");
    const skillInstall = installHybridMemoryWorkspaceSkill({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: false,
    });
    const toolsMdInstall = applyHybridMemoryToolsMd({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: false,
    });
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
    return {
      ok: true,
      configPath,
      dryRun: false,
      written: true,
      pluginId: PLUGIN_ID,
      workspaceSkillPath: skillInstall.path,
      workspaceSkillError: skillInstall.error,
      workspaceToolsMdPath: toolsMdInstall.path,
      workspaceToolsMdError: toolsMdInstall.error,
      workspaceToolsMdUpdated: toolsMdInstall.updated,
    };
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
  let mergedConfig: Record<string, unknown> = {};
  try {
    const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(cfgPath)) {
      mergedConfig = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runUpgradeForCli:read-config-for-skill" });
  }
  const skillAfterUpgrade = installHybridMemoryWorkspaceSkill({
    mergedOpenclawConfig: mergedConfig,
    pluginRootDir: extDir,
    dryRun: false,
  });
  if (skillAfterUpgrade.error) {
    logger?.warn?.(`memory-hybrid: could not refresh workspace skill: ${skillAfterUpgrade.error}`);
  } else {
    logger?.info?.(`memory-hybrid: workspace skill updated at ${skillAfterUpgrade.path}`);
  }
  const toolsAfterUpgrade = applyHybridMemoryToolsMd({
    mergedOpenclawConfig: mergedConfig,
    pluginRootDir: extDir,
    dryRun: false,
  });
  if (toolsAfterUpgrade.error) {
    logger?.warn?.(`memory-hybrid: could not refresh TOOLS.md block: ${toolsAfterUpgrade.error}`);
  } else if (toolsAfterUpgrade.updated) {
    logger?.info?.(`memory-hybrid: TOOLS.md hybrid block updated at ${toolsAfterUpgrade.path}`);
  }
  return {
    ok: true,
    version: installedVersion,
    pluginDir: extDir,
    workspaceSkillPath: skillAfterUpgrade.path,
    workspaceSkillError: skillAfterUpgrade.error,
    workspaceToolsMdPath: toolsAfterUpgrade.path,
    workspaceToolsMdError: toolsAfterUpgrade.error,
    workspaceToolsMdUpdated: toolsAfterUpgrade.updated,
  };
}
