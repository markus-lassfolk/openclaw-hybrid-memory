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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getEnv } from "../../utils/env-manager.js";
import { expandTilde } from "../../utils/path.js";
import { PLUGIN_ID } from "../../utils/constants.js";
import {
  type DetectedEmbeddingSetup,
  type EmbeddingSetupInspection,
  defaultModelForProvider,
  getPluginEntryConfig,
  hasUsableSecret,
  inspectExistingEmbeddingSetup,
  isPlaceholderSecret,
  normalizeEmbeddingProvider,
  readString,
} from "./config-merge.js";

export function detectRecommendedEmbeddingSetup(
  root: Record<string, unknown>,
  pluginRootDir: string,
): DetectedEmbeddingSetup {
  const existing = inspectExistingEmbeddingSetup(root);
  const existingProvider = normalizeEmbeddingProvider(existing.provider);
  if (existingProvider && existing.model) {
    return {
      provider: existingProvider,
      model: existing.model,
      source: "existing config",
      reason: existing.hasUsableApiKey
        ? "Embedding provider already configured."
        : "Embedding provider/model already configured; a key may still be required.",
    };
  }

  const openclawExtensionsDir = join(
    expandTilde(getEnv("OPENCLAW_HOME")?.trim() || join(homedir(), ".openclaw")),
    "extensions",
  );
  const onnxInstalled =
    existsSync(join(pluginRootDir, "node_modules", "onnxruntime-node")) ||
    existsSync(join(openclawExtensionsDir, "node_modules", "onnxruntime-node"));
  if (onnxInstalled) {
    return {
      provider: "onnx",
      model: "all-MiniLM-L6-v2",
      source: "local runtime",
      reason: "Detected onnxruntime-node, so a fully local embedding path is available.",
    };
  }

  const ollamaHost = readString(getEnv("OLLAMA_HOST"));
  const ollamaInstalled =
    existsSync(join(homedir(), ".ollama")) ||
    ollamaHost !== undefined ||
    spawnSync("ollama", ["--version"], { stdio: "ignore", timeout: 2_000 }).status === 0;
  if (ollamaInstalled) {
    return {
      provider: "ollama",
      model: "nomic-embed-text",
      source: ollamaHost ? "OLLAMA_HOST" : existsSync(join(homedir(), ".ollama")) ? "~/.ollama" : "ollama --version",
      reason: "Detected a local Ollama installation or endpoint hint.",
    };
  }

  const openAiEnv = hasUsableSecret(getEnv("OPENAI_API_KEY")) ? "OPENAI_API_KEY" : undefined;
  if (openAiEnv) {
    return {
      provider: "openai",
      model: "text-embedding-3-small",
      source: openAiEnv,
      reason: `Detected ${openAiEnv} in the environment.`,
      envKey: openAiEnv,
    };
  }

  const googleEnv = hasUsableSecret(getEnv("GOOGLE_API_KEY"))
    ? "GOOGLE_API_KEY"
    : hasUsableSecret(getEnv("GEMINI_API_KEY"))
      ? "GEMINI_API_KEY"
      : undefined;
  if (googleEnv) {
    return {
      provider: "google",
      model: "gemini-embedding-001",
      source: googleEnv,
      reason: `Detected ${googleEnv} in the environment.`,
      envKey: googleEnv,
    };
  }

  return {
    provider: "openai",
    model: "text-embedding-3-small",
    source: "fallback",
    reason: "No local embedding runtime detected; defaulting to the simplest hosted setup.",
  };
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

export function applyDetectedEmbeddingSetup(
  root: Record<string, unknown>,
  detection: DetectedEmbeddingSetup,
  existing: EmbeddingSetupInspection,
): { changed: boolean; notes: string[] } {
  const notes: string[] = [];
  const pluginConfig = ensureObject(ensureObject(ensureObject(root, "plugins"), "entries"), PLUGIN_ID);
  const config = ensureObject(pluginConfig, "config");
  const embedding = ensureObject(config, "embedding");
  let changed = false;

  const existingProvider = normalizeEmbeddingProvider(existing.provider);
  if (!existingProvider || isPlaceholderSecret(existing.provider)) {
    embedding.provider = detection.provider;
    changed = true;
  }
  const effectiveProvider = normalizeEmbeddingProvider(embedding.provider) ?? detection.provider;
  if (!existing.model) {
    embedding.model =
      effectiveProvider === detection.provider ? detection.model : defaultModelForProvider(effectiveProvider);
    changed = true;
  }

  const llm = config.llm as Record<string, unknown> | undefined;
  const llmProviders = llm?.providers as Record<string, unknown> | undefined;
  const openAiProvider = llmProviders?.openai as Record<string, unknown> | undefined;
  const azureFoundryProvider = llmProviders?.["azure-foundry"] as Record<string, unknown> | undefined;

  if (effectiveProvider === "openai" && !hasUsableSecret(embedding.apiKey)) {
    const hasProviderFallbackKey =
      hasUsableSecret(openAiProvider?.apiKey) || hasUsableSecret(azureFoundryProvider?.apiKey);
    if (!hasProviderFallbackKey) {
      embedding.apiKey = detection.envKey ? `env:${detection.envKey}` : "YOUR_OPENAI_API_KEY";
      changed = true;
      notes.push(
        detection.envKey
          ? `Will use ${detection.envKey} for hosted OpenAI-compatible embeddings.`
          : "Still needs an OpenAI-compatible embedding key.",
      );
    } else {
      if (isPlaceholderSecret(embedding.apiKey)) {
        embedding.apiKey = "";
        changed = true;
      }
      notes.push(
        'Embedding auth will use llm.providers.openai.apiKey or llm.providers["azure-foundry"].apiKey fallback.',
      );
    }
  }

  if (effectiveProvider === "google") {
    const llm = ensureObject(config, "llm");
    const providers = ensureObject(llm, "providers");
    const google = ensureObject(providers, "google");
    if (isPlaceholderSecret(embedding.apiKey)) {
      embedding.apiKey = "";
      changed = true;
    }
    if (!hasUsableSecret(google.apiKey)) {
      google.apiKey = `env:${detection.provider === "google" ? (detection.envKey ?? "GOOGLE_API_KEY") : "GOOGLE_API_KEY"}`;
      changed = true;
    }
    notes.push("Google embeddings still require a working llm.providers.google.apiKey.");
  }

  if (effectiveProvider === "ollama") {
    if (isPlaceholderSecret(embedding.apiKey)) {
      embedding.apiKey = "";
      changed = true;
    }
    notes.push("Ollama must be running locally before verify can pass.");
  }
  if (effectiveProvider === "onnx") {
    if (isPlaceholderSecret(embedding.apiKey)) {
      embedding.apiKey = "";
      changed = true;
    }
    notes.push("ONNX is fully local; no remote API key is required.");
  }

  return { changed, notes };
}

function getConfiguredDashboardPort(root: Record<string, unknown>): number {
  const pluginConfig = getPluginEntryConfig(root) ?? {};
  const dashboard = pluginConfig.dashboard as Record<string, unknown> | undefined;
  const raw = dashboard?.port;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1024 && raw <= 65535) return Math.floor(raw);
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535) return parsed;
  }
  return 7700;
}

export function getDashboardUrl(root: Record<string, unknown>): string {
  return `http://127.0.0.1:${getConfiguredDashboardPort(root)}/`;
}

/**
 * Install plugin configuration and cron jobs.
 * `buildInstallDefaults()` includes `mode: "local"`; `deepMerge` only fills missing keys,
 * so an existing `plugins.entries[pluginId].config.mode` is never overwritten on re-install.
 */
