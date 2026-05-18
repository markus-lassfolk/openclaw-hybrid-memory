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

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as pathResolve, relative } from "node:path";

import { getEnv } from "../utils/env-manager.js";
import { expandTilde } from "../utils/path.js";
import { findPluginRoot } from "../utils/plugin-root.js";

import type { DigestWeeklyDeliveryConfig, HybridMemoryConfig } from "../config.js";
import { type CronModelConfig, getCronModelConfig, getDefaultCronModel } from "../config.js";
import { parseDigestWeeklyDeliveryOnly } from "../config/parsers/features.js";
import { buildGuardPrefix } from "../services/cron-guard.js";
import {
  HYBRID_MEM_CRON_ENV_SANITIZER_MARKER,
  buildHybridMemCronTaskMessage,
  hybridMemCronEnvSanitizerBashLines,
} from "../services/cron-job-bash-harness.js";
import { findDeprecatedHybridMemCronTokens } from "../services/deprecated-cron-commands.js";
import { capturePluginError } from "../services/error-reporter.js";
import { compileHeartbeatMatchers } from "../services/goal-stewardship-heartbeat.js";
import { type PreFilterConfig, preFilterSessions } from "../services/session-pre-filter.js";
import { ensureWorkspaceBootstrap } from "../setup/workspace-bootstrap.js";
import { resetAllBackoff } from "../utils/auth-failover.js";
import { DEFAULT_COMPACTION_MODEL } from "../utils/compaction-model-watchdog.js";
import { PLUGIN_ID } from "../utils/constants.js";
import {
  extractCronStoreJobModel,
  readAgentsPrimaryModelFromOpenclawJsonPath,
  setCronStoreJobModelFields,
} from "../utils/openclaw-agent-defaults.js";
import type { HandlerContext } from "./handlers.js";
import type { InstallCliResult, UninstallCliResult, UpgradeCliResult } from "./types.js";

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
          // Keep compaction on a cheap model by default; do not inherit agent primary.
          model: DEFAULT_COMPACTION_MODEL,
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

type EmbeddingSetupInspection = {
  provider?: string;
  model?: string;
  hasUsableApiKey: boolean;
};

type DetectedEmbeddingSetup = {
  provider: "onnx" | "ollama" | "openai" | "google";
  model: string;
  source: string;
  reason: string;
  envKey?: string;
};

type EmbeddingProviderName = DetectedEmbeddingSetup["provider"];

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeEmbeddingProvider(value: unknown): EmbeddingProviderName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "onnx" || normalized === "ollama" || normalized === "openai" || normalized === "google") {
    return normalized;
  }
  return undefined;
}

function defaultModelForProvider(provider: EmbeddingProviderName): string {
  if (provider === "google") return "gemini-embedding-001";
  if (provider === "ollama") return "nomic-embed-text";
  if (provider === "onnx") return "all-MiniLM-L6-v2";
  return "text-embedding-3-small";
}

function isOpenClawSecretRefObject(
  raw: unknown,
): raw is { source: "env" | "file" | "exec"; provider: string; id: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const source = record.source;
  return (
    (source === "env" || source === "file" || source === "exec") &&
    typeof record.provider === "string" &&
    record.provider.trim().length > 0 &&
    typeof record.id === "string" &&
    record.id.trim().length > 0
  );
}

function isPlaceholderSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  return (
    lower === "your_openai_api_key" ||
    lower === "<openai_api_key>" ||
    lower === "your_api_key_here" ||
    lower === "<your_key_here>" ||
    lower === "<your_api_key_here>" ||
    compact === "..." ||
    /^sk-[a-z0-9_-]*\.\.\.$/.test(compact) ||
    (/key/.test(lower) && /(your|placeholder|example|replace)/.test(lower))
  );
}

function hasUsableSecret(value: unknown): boolean {
  if (isOpenClawSecretRefObject(value)) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || isPlaceholderSecret(trimmed)) return false;
  if (trimmed.startsWith("env:")) return trimmed.slice(4).trim().length > 0;
  if (trimmed.startsWith("file:")) return trimmed.slice(5).trim().length > 0;
  if (trimmed.includes("${")) return true;
  return trimmed.length >= 10;
}

function inspectExistingEmbeddingSetup(root: Record<string, unknown>): EmbeddingSetupInspection {
  const pluginConfig = getPluginEntryConfig(root) ?? {};
  const embedding = (pluginConfig.embedding as Record<string, unknown> | undefined) ?? {};
  const provider = readString(embedding.provider);
  const model = readString(embedding.model);
  const apiKey = embedding.apiKey;
  const llm = pluginConfig.llm as Record<string, unknown> | undefined;
  const llmProviders = llm?.providers as Record<string, unknown> | undefined;
  const googleProvider = llmProviders?.google as Record<string, unknown> | undefined;
  const openAiProvider = llmProviders?.openai as Record<string, unknown> | undefined;
  const azureFoundryProvider = llmProviders?.["azure-foundry"] as Record<string, unknown> | undefined;
  return {
    provider,
    model,
    hasUsableApiKey:
      hasUsableSecret(apiKey) ||
      hasUsableSecret(googleProvider?.apiKey) ||
      hasUsableSecret(openAiProvider?.apiKey) ||
      hasUsableSecret(azureFoundryProvider?.apiKey),
  };
}

