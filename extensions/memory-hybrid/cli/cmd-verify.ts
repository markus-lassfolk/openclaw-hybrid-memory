import { getEnv } from "../utils/env-manager.js";
/**
 * CLI Verify Command Handler
 *
 * Contains runVerifyForCli and its private helper functions.
 * Checks infrastructure (SQLite, LanceDB, embeddings, LLM credentials,
 * cron jobs) and optionally applies fixes.
 *
 * Extracted from cli/handlers.ts to keep that file manageable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import type { CredentialType } from "../config.js";
import {
  getCronModelConfig,
  getLLMModelPreference,
  getLLMModelPreferenceUnfiltered,
  getProvidersWithKeys,
  isCompactVerbosity,
} from "../config.js";
import { resolveSecretRef } from "../config/parsers/core.js";
import { chatComplete } from "../services/chat.js";
import {
  AZURE_OPENAI_API_VERSION,
  type EmbeddingConfig,
  GOOGLE_EMBED_DEFAULT_DIMENSIONS,
  GOOGLE_EMBED_DEFAULT_MODEL,
  OPENAI_ONLY_EMBED_MODELS,
  createEmbeddingProvider,
} from "../services/embeddings.js";
import { capturePluginError } from "../services/error-reporter.js";
import { hasOAuthProfiles } from "../utils/auth.js";
import { formatOpenAiEmbeddingDisplayLabel } from "../services/embeddings/shared.js";
import { relativeTime } from "./shared.js";
import { createApimGatewayFetch, isAzureApiManagementGatewayUrl } from "../utils/apim-gateway-fetch.js";
import { PLUGIN_ID, getRestartPendingPath } from "../utils/constants.js";
import { ensureMaintenanceCronJobs, getPluginConfigFromFile } from "./cmd-install.js";

import type { HandlerContext } from "./handlers.js";
import type { VerifyCliSink } from "./types.js";

const VERIFY_FACT_COUNT_TTL_MS = 5 * 60_000;
let verifyFactCountCache: { path: string; n: number; at: number } | null = null;

function readApproxFactsRowCount(db: DatabaseSync): number | null {
  try {
    const row = db.prepare(`SELECT stat FROM sqlite_stat1 WHERE tbl = 'facts' LIMIT 1`).get() as
      | { stat: string | number }
      | undefined;
    if (row == null || row.stat === undefined || row.stat === null) return null;
    const statStr = String(row.stat).trim();
    const firstInt = statStr.split(/\s+/)[0];
    if (!firstInt) return null;
    const n = Number.parseInt(firstInt, 10);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

function getCachedFactCount(
  factsDb: { count: () => number; getRawDb: () => DatabaseSync },
  sqlitePath: string,
): number {
  const now = Date.now();
  if (
    verifyFactCountCache &&
    verifyFactCountCache.path === sqlitePath &&
    now - verifyFactCountCache.at < VERIFY_FACT_COUNT_TTL_MS
  ) {
    return verifyFactCountCache.n;
  }
  const approx = readApproxFactsRowCount(factsDb.getRawDb());
  const n = approx != null ? approx : factsDb.count();
  verifyFactCountCache = { path: sqlitePath, n, at: now };
  return n;
}

export async function runVerifyForCli(
  ctx: HandlerContext,
  opts: { fix: boolean; logFile?: string; testLlm?: boolean; reconcile?: boolean },
  sink: VerifyCliSink,
): Promise<void> {
  const { factsDb, vectorDb, embeddings, cfg, credentialsDb, resolvedSqlitePath, resolvedLancePath, openai } = ctx;
  const verbosity = cfg.verbosity ?? "normal";
  // In quiet mode: suppress ✅ / [OK] lines and section headers (─────); only pass through failures and summaries.
  const rawLog = sink.log;
  const log: typeof rawLog = isCompactVerbosity(verbosity)
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
  /** Always print tables (embedding + LLM) so they are never suppressed in quiet mode. */
  const tableLog = rawLog;
  const _err = sink.error ?? rawLog;
  const noEmoji = getEnv("HYBRID_MEM_NO_EMOJI") === "1";
  const OK = noEmoji ? "[OK]" : "✅";
  const FAIL = noEmoji ? "[FAIL]" : "❌";
  const PAUSE = noEmoji ? "[paused]" : "⏸️ ";
  const _ON = noEmoji ? "[on]" : "✅ on";
  const _OFF = noEmoji ? "[off]" : "❌ off";
  const issues: string[] = [];
  const fixes: string[] = [];
  let configOk = true;
  let sqliteOk = false;
  let lanceOk = false;
  let embeddingOk = false;
  const loadBlocking: string[] = [];

  log("\n───── Infrastructure ─────");

  if (
    cfg.embedding.provider === "openai" &&
    (!cfg.embedding.apiKey || cfg.embedding.apiKey === "YOUR_OPENAI_API_KEY" || cfg.embedding.apiKey.length < 10)
  ) {
    issues.push("embedding.apiKey is missing, placeholder, or too short");
    loadBlocking.push("embedding.apiKey is missing, placeholder, or too short");
    fixes.push(
      `LOAD-BLOCKING: Set plugins.entries["${PLUGIN_ID}"].config.embedding.apiKey to a valid OpenAI key (and embedding.model to "text-embedding-3-small"). Edit ~/.openclaw/openclaw.json or set OPENAI_API_KEY and use env:OPENAI_API_KEY in config.`,
    );
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
    const msg =
      cfg.embedding.provider === "openai"
        ? "Config: embedding.apiKey and model present"
        : "Config: embedding.model present";
    log(`${OK} ${msg}`);
  } else {
    log(`${FAIL} Config: issues found`);
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    if (loadBlocking.some((s) => s.includes("embedding"))) {
      log(
        `${WARN} Embedding: missing or invalid — retrieval and indexing will not work. Set embedding.apiKey and embedding.model in plugin config.`,
      );
    }
  }

  // Check for unsupported agents.defaults.pruning config (#105)
  try {
    if (existsSync(defaultConfigPath)) {
      const rawConfig = JSON.parse(readFileSync(defaultConfigPath, "utf-8")) as Record<string, unknown>;
      const agentsDefaults = (rawConfig.agents as Record<string, unknown>)?.defaults as
        | Record<string, unknown>
        | undefined;
      if (agentsDefaults != null && "pruning" in agentsDefaults) {
        const WARN = noEmoji ? "[WARN]" : "⚠️";
        log(`${WARN} Config: agents.defaults.pruning is set but not supported by OpenClaw core — it has no effect`);
        log(
          `  Fix: Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).`,
        );
        issues.push("agents.defaults.pruning is set but unsupported (has no effect)");
        fixes.push(
          'Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).',
        );
        if (opts.fix) {
          agentsDefaults.pruning = undefined;
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
    /bindings|better_sqlite3\.node|compiled against|ABI|NODE_MODULE_VERSION|@lancedb\/lancedb|Cannot find module/.test(
      msg,
    );
  let _sqliteBindingsFailed = false;
  let lanceBindingsFailed = false;

  try {
    const n = getCachedFactCount(factsDb, resolvedSqlitePath);
    sqliteOk = true;
    log(`${OK} SQLite: OK (${resolvedSqlitePath}, ${n} facts)`);
  } catch (e) {
    const msg = String(e);
    issues.push(`SQLite: ${msg}`);
    if (isBindingsError(msg)) {
      _sqliteBindingsFailed = true;
      fixes.push("node:sqlite is not available. Upgrade Node.js to >=22.12.0 or use a compatible version.");
    } else {
      fixes.push(
        `SQLite: Ensure path is writable and not corrupted. Path: ${resolvedSqlitePath}. If corrupted, back up and remove the file to recreate, or run from a process with write access.`,
      );
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
    } else if (msg.includes("VectorDB not initialized") || msg.includes("close() was called")) {
      fixes.push(
        "LanceDB connection was not ready (often transient after plugin load or reload). Re-run verify; the plugin will reconnect automatically. Not caused by reindexing.",
      );
    } else {
      fixes.push(
        `LanceDB: Ensure path is writable. Path: ${resolvedLancePath}. If corrupted, back up and remove the directory to recreate. Restart gateway after fix.`,
      );
    }
    log(`${FAIL} LanceDB: FAIL — ${msg}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:lancedb-check" });
  }

  // Raw plugin config (from file) for credential Source column
  const rawPluginConfigResult = getPluginConfigFromFile(defaultConfigPath);
  const rawPluginConfig = "error" in rawPluginConfigResult ? undefined : rawPluginConfigResult.config;
  function credentialSource(rawKey: unknown): string {
    if (typeof rawKey !== "string" || !rawKey.trim()) return "";
    const v = rawKey.trim();
    if (v.startsWith("env:")) return "env";
    if (v.startsWith("file:")) return "file";
    return "plugin";
  }
  function rawEmbeddingApiKey(): unknown {
    const emb = rawPluginConfig?.embedding as Record<string, unknown> | undefined;
    return emb?.apiKey;
  }
  function rawDistillApiKey(): unknown {
    const d = rawPluginConfig?.distill as Record<string, unknown> | undefined;
    return d?.apiKey;
  }
  function rawLlmProviderApiKey(provider: string): unknown {
    const prov = (rawPluginConfig?.llm as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
    const p = prov?.[provider] as Record<string, unknown> | undefined;
    return p?.apiKey;
  }
  function rawClaudeApiKey(): unknown {
    const c = rawPluginConfig?.claude as Record<string, unknown> | undefined;
    return c?.apiKey;
  }

  // ───── Embeddings Tests (Critical) ─────
  tableLog("\n───── Embeddings Tests (Critical) ─────");
  const hasOpenAiKey =
    typeof cfg.embedding.apiKey === "string" &&
    cfg.embedding.apiKey.length >= 10 &&
    cfg.embedding.apiKey !== "YOUR_OPENAI_API_KEY" &&
    cfg.embedding.apiKey !== "<OPENAI_API_KEY>";
  // Google key may be in embedding.googleApiKey (parsed from distill/llm) or only in raw config
  const cfgGoogleKey = (cfg.embedding as Record<string, unknown>).googleApiKey as string | undefined;
  const llmProviders = (rawPluginConfig?.llm as Record<string, unknown> | undefined)?.providers as
    | Record<string, unknown>
    | undefined;
  const rawGoogleKeyForHasKey =
    (rawPluginConfig?.distill as Record<string, unknown> | undefined)?.apiKey ??
    (llmProviders?.google as Record<string, unknown> | undefined)?.apiKey;
  const resolvedGoogleKeyForHasKey =
    typeof cfgGoogleKey === "string" && cfgGoogleKey.length >= 10
      ? cfgGoogleKey
      : typeof rawGoogleKeyForHasKey === "string" && rawGoogleKeyForHasKey.trim()
        ? resolveSecretRef(rawGoogleKeyForHasKey.trim())
        : undefined;
  const hasGoogleKey = Boolean(resolvedGoogleKeyForHasKey && resolvedGoogleKeyForHasKey.length >= 10);
  const embProvidersToShow: ("openai" | "ollama" | "onnx" | "google")[] =
    cfg.embedding.preferredProviders && cfg.embedding.preferredProviders.length > 0
      ? [...new Set(cfg.embedding.preferredProviders)]
      : [cfg.embedding.provider];
  const embTableRows: {
    label: string;
    oauth: boolean;
    api: string;
    source: string;
    success?: boolean;
    error?: string;
  }[] = [];
  for (const p of embProvidersToShow) {
    const oauth = false;
    const api =
      p === "openai" ? (hasOpenAiKey ? "True" : "False") : p === "google" ? (hasGoogleKey ? "True" : "False") : "Local";
    const source =
      p === "openai"
        ? hasOpenAiKey
          ? credentialSource(rawEmbeddingApiKey())
          : "—"
        : p === "google"
          ? hasGoogleKey
            ? (credentialSource(rawDistillApiKey()) !== "plugin"
                ? credentialSource(rawDistillApiKey())
                : credentialSource(rawLlmProviderApiKey("google"))) || "plugin"
            : "—"
          : "local";
    // For Google with an OpenAI-only model name, show the effective model we use (gemini-embedding-001)
    const embModel =
      cfg.embedding.model ||
      (p === "openai"
        ? "text-embedding-3-small"
        : p === "google"
          ? "text-embedding-004"
          : p === "ollama"
            ? "nomic-embed-text"
            : "all-MiniLM-L6-v2");
    const effectiveGoogleModel =
      p === "google" && embModel && OPENAI_ONLY_EMBED_MODELS.has(embModel) ? GOOGLE_EMBED_DEFAULT_MODEL : embModel;
    // Detect Azure / APIM / Foundry so the label is (Azure)OpenAI/… not OpenAI/…
    const embeddingEndpoint =
      typeof (cfg.embedding as Record<string, unknown>).endpoint === "string"
        ? ((cfg.embedding as Record<string, unknown>).endpoint as string)
        : "";
    const label =
      p === "openai"
        ? formatOpenAiEmbeddingDisplayLabel(embModel, embeddingEndpoint || undefined)
        : p === "google"
          ? `Google/${effectiveGoogleModel}`
          : p === "ollama"
            ? `Local/Ollama (${embModel})`
            : `Local/ONNX (${embModel})`;
    let success: boolean | undefined = undefined;
    let embError: string | undefined = undefined;
    if (!opts.testLlm && (api === "True" || api === "Local")) {
      embeddingOk = true;
    }
    if (opts.testLlm) {
      try {
        // For Google with an OpenAI-only model name, use gemini-embedding-001 and 768 dims (same as factory)
        const modelForTest =
          p === "google" && embModel && OPENAI_ONLY_EMBED_MODELS.has(embModel)
            ? GOOGLE_EMBED_DEFAULT_MODEL
            : cfg.embedding.model ||
              (p === "openai"
                ? "text-embedding-3-small"
                : p === "google"
                  ? "text-embedding-004"
                  : p === "ollama"
                    ? "nomic-embed-text"
                    : "all-MiniLM-L6-v2");
        const dimensionsForTest =
          p === "google" && embModel && OPENAI_ONLY_EMBED_MODELS.has(embModel)
            ? GOOGLE_EMBED_DEFAULT_DIMENSIONS
            : cfg.embedding.dimensions;
        // Use resolved Google key (from cfg or raw distill/llm) so test works when key is only in raw config
        const minimalEmbCfg: EmbeddingConfig = {
          provider: p,
          model: modelForTest,
          dimensions: dimensionsForTest,
          batchSize: cfg.embedding.batchSize ?? 32,
          ...(typeof cfg.embedding.deployment === "string" && cfg.embedding.deployment.trim()
            ? { deployment: cfg.embedding.deployment.trim() }
            : {}),
          ...(cfg.embedding.models?.length ? { models: cfg.embedding.models } : {}),
          ...(p === "openai" && {
            apiKey: cfg.embedding.apiKey,
            ...(typeof cfg.embedding.endpoint === "string" && cfg.embedding.endpoint.trim()
              ? { endpoint: cfg.embedding.endpoint.trim() }
              : {}),
          }),
          ...(p === "google" && {
            googleApiKey:
              resolvedGoogleKeyForHasKey ?? ((cfg.embedding as Record<string, unknown>).googleApiKey as string),
          }),
          ...(p === "ollama" && { endpoint: cfg.embedding.endpoint }),
        };
        const singleEmb = createEmbeddingProvider(minimalEmbCfg);
        await singleEmb.embed("verify test");
        success = true;
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:embedding-test", phase: p });
        success = false;
        embError = (e instanceof Error ? e.message : String(e)).slice(0, 120);
      }
      if (success) embeddingOk = true;
    }
    embTableRows.push({ label, oauth, api, source, success, error: embError });
  }
  const embCols = ["Model", "Credentials Available", "Source", ...(opts.testLlm ? ["Test Result"] : [])];
  const embW1 = Math.max(8, ...embTableRows.map((r) => r.label.length), 20);
  const embW2 = Math.max(20, 35);
  const embW3 = 8;
  const embW4 = opts.testLlm ? 12 : 0;
  tableLog(
    `  ${embCols[0].padEnd(embW1)}  ${embCols[1].padEnd(embW2)}  ${embCols[2].padEnd(embW3)}${opts.testLlm ? `  ${embCols[3]}` : ""}`,
  );
  tableLog(`  ${"-".repeat(embW1 + embW2 + embW3 + 4 + (opts.testLlm ? embW4 + 2 : 0))}`);
  for (const row of embTableRows) {
    const credStr = `OAuth:${row.oauth ? "True" : "False"} / API:${row.api}`;
    const line = `  ${row.label.padEnd(embW1)}  ${credStr.padEnd(embW2)}  ${row.source.padEnd(embW3)}${
      opts.testLlm ? `  ${row.success ? (noEmoji ? "Success" : "✅ Success") : noEmoji ? "Failed" : "❌ Failed"}` : ""
    }`;
    tableLog(line);
  }
  const failedEmbRows = opts.testLlm ? embTableRows.filter((r) => r.success === false && r.error) : [];
  if (failedEmbRows.length > 0) {
    tableLog("  Embedding test failures:");
    for (const row of failedEmbRows) {
      tableLog(`    ${row.label}: ${row.error}`);
    }
  }
  const anyEmbOk = opts.testLlm
    ? embTableRows.some((r) => r.success)
    : embTableRows.some((r) => r.api === "True" || r.api === "Local");
  if (!anyEmbOk && opts.testLlm) {
    issues.push("No supported providers with Embedding support available");
    loadBlocking.push("No supported providers with Embedding support available");
    const WARN = noEmoji ? "[WARNING]" : "⚠️";
    log(`\n${WARN} No supported providers with Embedding support available. Plugin disabled.`);
    fixes.push(
      "Configure at least one embedding provider: embedding.apiKey (OpenAI), llm.providers.google.apiKey or distill.apiKey (Google), or use Local/Ollama or Local/ONNX. See docs/LLM-AND-PROVIDERS.md.",
    );
  }
  tableLog(
    anyEmbOk
      ? "  Embeddings: OK — at least one provider has credentials."
      : "  Embeddings: no working provider — see fixes below if listed.",
  );

  // ───── LLM / models table: one row per model from llm.nano / llm.default / llm.heavy; auth + source ─────
  tableLog("\n───── LLM / Models (from llm.nano, llm.default, llm.heavy) ─────");
  const cronCfg = getCronModelConfig(cfg);
  const providersWithKeys = getProvidersWithKeys(cronCfg);
  const authOrder = (cfg as Record<string, unknown>).auth as { order?: Record<string, string[]> } | undefined;
  const gatewayPort = getEnv("OPENCLAW_GATEWAY_PORT");
  const gatewayToken = getEnv("OPENCLAW_GATEWAY_TOKEN");
  const gatewayAvailable = Boolean(
    gatewayPort && Number(gatewayPort) >= 1 && Number(gatewayPort) <= 65535 && gatewayToken,
  );
  const allModelsUnfiltered: string[] = [
    ...getLLMModelPreferenceUnfiltered(cronCfg, "nano"),
    ...getLLMModelPreferenceUnfiltered(cronCfg, "default"),
    ...getLLMModelPreferenceUnfiltered(cronCfg, "heavy"),
  ];
  const _allModelsFiltered: string[] = [
    ...getLLMModelPreference(cronCfg, "nano"),
    ...getLLMModelPreference(cronCfg, "default"),
    ...getLLMModelPreference(cronCfg, "heavy"),
  ];
  // Reference models always shown in verify so users see Opus, GPT-5.4, Codex, o3, etc. with auth/source
  const VERIFY_REFERENCE_MODELS: string[] = [
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5-20251001",
    "openai/gpt-5.4",
    "openai/gpt-4.1-mini",
    "openai/gpt-4.1-nano",
    "openai/o3",
    "openai/o1",
    "openai/gpt-5-codex",
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "minimax/MiniMax-M2.5",
  ];
  const providerFromModel = (m: string) => {
    if (m.includes("/")) {
      return m.split("/")[0].toLowerCase();
    }
    const bare = m.trim().toLowerCase();
    if (bare.startsWith("gemini-")) return "google";
    if (bare.startsWith("claude-")) return "anthropic";
    if (bare.startsWith("gpt-") || bare.match(/^o[0-9]/)) return "openai";
    return "openai";
  };
  const disabledSet = new Set((cfg.llm?.disabledProviders ?? []).map((p) => String(p).trim().toLowerCase()));
  const _defaultTestModel: Record<string, string> = {
    openai: "openai/gpt-4.1-nano",
    google: "google/gemini-2.5-flash-lite",
    anthropic: "anthropic/claude-haiku-4-5-20251001",
    ollama: "ollama/llama3.2",
    minimax: "minimax/minimax-01",
  };
  function llmCredentialSource(provider: string): string {
    if (gatewayAvailable && hasOAuthProfiles(authOrder?.order?.[provider], provider)) return "gateway";
    if (provider === "openai")
      return credentialSource(rawEmbeddingApiKey()) || credentialSource(rawLlmProviderApiKey("openai"));
    if (provider === "google")
      return credentialSource(rawDistillApiKey()) || credentialSource(rawLlmProviderApiKey("google"));
    if (provider === "anthropic")
      return credentialSource(rawClaudeApiKey()) || credentialSource(rawLlmProviderApiKey("anthropic"));
    return credentialSource(rawLlmProviderApiKey(provider)) || "plugin";
  }
  const gatewayBaseUrl =
    gatewayPort && Number(gatewayPort) >= 1 && Number(gatewayPort) <= 65535
      ? `http://127.0.0.1:${Number(gatewayPort)}/v1`
      : undefined;
  const VERIFY_LLM_BASE_URLS: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta/openai/",
    anthropic: "https://api.anthropic.com/v1",
    ollama: "http://127.0.0.1:11434/v1",
    minimax: "https://api.minimax.chat/v1",
  };
  function resolveKey(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    const trimmed = raw.trim();
    const resolved = trimmed.startsWith("env:") || trimmed.startsWith("file:") ? resolveSecretRef(trimmed) : trimmed;
    return typeof resolved === "string" && resolved.length >= 10 ? resolved : undefined;
  }
  function getDirectApiKey(provider: string): string | undefined {
    const prov = cronCfg.llm?.providers as Record<string, { apiKey?: string }> | undefined;
    if (provider === "openai") {
      // Prefer OPENAI_API_KEY so Azure (embedding) and OpenAI (chat) can use different keys.
      const fromProv = resolveKey(prov?.openai?.apiKey);
      if (fromProv) return fromProv;
      const fromEnv = getEnv("OPENAI_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
      return resolveKey(cronCfg.embedding?.apiKey);
    }
    if (provider === "google") {
      const fromProv = resolveKey(prov?.google?.apiKey ?? cronCfg.distill?.apiKey);
      if (fromProv) return fromProv;
      const fromEnv = getEnv("GOOGLE_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
      return undefined;
    }
    if (provider === "anthropic") {
      const fromProv = resolveKey(
        prov?.anthropic?.apiKey ?? (cronCfg.claude as { apiKey?: string } | undefined)?.apiKey,
      );
      if (fromProv) return fromProv;
      const fromEnv = getEnv("ANTHROPIC_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
      return undefined;
    }
    if (provider === "ollama") return "ollama";
    // Azure Foundry: use AZURE_OPENAI_API_KEY when llm.providers key is not set.
    if (
      (provider === "azure-foundry" || provider === "azure-foundry-responses") &&
      !resolveKey(prov?.[provider]?.apiKey)
    ) {
      const fromEnv = getEnv("AZURE_OPENAI_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
    }
    return resolveKey(prov?.[provider]?.apiKey);
  }
  function buildDirectClient(provider: string): OpenAI | undefined {
    const apiKey = getDirectApiKey(provider);
    if (!apiKey) return undefined;
    const provEntry = (cronCfg.llm?.providers as Record<string, { baseURL?: string; baseUrl?: string }> | undefined)?.[
      provider
    ];
    const baseURL =
      (typeof provEntry?.baseURL === "string" && provEntry.baseURL.trim() ? provEntry.baseURL.trim() : undefined) ??
      (typeof provEntry?.baseUrl === "string" && provEntry.baseUrl.trim() ? provEntry.baseUrl.trim() : undefined) ??
      VERIFY_LLM_BASE_URLS[provider];
    if (!baseURL) return undefined;
    const opts: {
      apiKey: string;
      baseURL: string;
      defaultHeaders?: Record<string, string>;
      defaultQuery?: Record<string, string>;
      fetch?: typeof globalThis.fetch;
    } = {
      apiKey,
      baseURL,
    };
    if (provider === "anthropic") opts.defaultHeaders = { "anthropic-version": "2023-06-01" };
    // Azure API Management rejects Bearer auth; apply same api-key + custom fetch as embeddings factory.
    if (
      (provider === "azure-foundry" || provider === "azure-foundry-responses") &&
      isAzureApiManagementGatewayUrl(baseURL)
    ) {
      opts.defaultHeaders = { ...(opts.defaultHeaders ?? {}), "api-key": apiKey };
      opts.fetch = createApimGatewayFetch(apiKey);
      const openAiV1Compat = /\/openai\/v1(?:\/|$)/i.test(baseURL);
      // APIM deployment-style paths need api-version (passed through to backend Azure OpenAI)
      if (!openAiV1Compat) {
        opts.defaultQuery = { "api-version": AZURE_OPENAI_API_VERSION };
      }
    }
    return new OpenAI(opts);
  }
  // One row per model: configured models + reference models (Opus, GPT-5.4, Codex, o3, etc.)
  const configModelSet = new Set(allModelsUnfiltered);
  const uniqueModels = [...new Set([...allModelsUnfiltered, ...VERIFY_REFERENCE_MODELS])];
  uniqueModels.sort((a, b) => providerFromModel(a).localeCompare(providerFromModel(b)) || a.localeCompare(b));
  const llmRows: {
    model: string;
    provider: string;
    hasOAuth: boolean;
    hasApi: boolean;
    enabled: boolean;
    source: string;
    inConfig: boolean;
    oauthResult?: boolean;
    apiResult?: boolean;
    oauthError?: string;
    apiError?: string;
    /** When set, direct API test was skipped (e.g. Responses API); show this in API column, do not treat as failed. */
    apiSkippedReason?: string;
  }[] = [];
  function shortError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.slice(0, 100).replace(/\s+/g, " ").trim();
  }
  /** Cache direct client per provider so we use the same client for each model of that provider. */
  const directClientCache = new Map<string, OpenAI | null>();
  function getDirectClient(provider: string): OpenAI | null {
    if (!directClientCache.has(provider)) {
      directClientCache.set(provider, buildDirectClient(provider) ?? null);
    }
    return directClientCache.get(provider)!;
  }
  for (const model of uniqueModels) {
    const provider = providerFromModel(model);
    const hasApi = providersWithKeys.includes(provider);
    const hasOAuth = gatewayAvailable && Boolean(hasOAuthProfiles(authOrder?.order?.[provider], provider));
    const enabled = !disabledSet.has(provider);
    let source = llmCredentialSource(provider);
    if (!source && gatewayAvailable && (hasOAuth || hasApi)) source = "gateway";
    if (!source) source = "—";
    const inConfig = configModelSet.has(model);
    let oauthResult: boolean | undefined = undefined;
    let apiResult: boolean | undefined = undefined;
    let oauthError: string | undefined = undefined;
    let apiError: string | undefined = undefined;
    let apiSkippedReason: string | undefined = undefined;
    // Test each model that has credentials (OAuth or API), so we report which work even if not yet in llm.nano/default/heavy.
    if (opts.testLlm && enabled && (hasOAuth || hasApi)) {
      const bareModel = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
      if (hasOAuth && gatewayBaseUrl && gatewayToken) {
        try {
          const oauthClient = new OpenAI({ apiKey: gatewayToken, baseURL: gatewayBaseUrl });
          await chatComplete({
            model,
            content: "Reply with exactly: OK",
            maxTokens: 10,
            openai: oauthClient,
          });
          oauthResult = true;
        } catch (e) {
          oauthError = shortError(e);
          capturePluginError(e as Error, {
            subsystem: "cli",
            operation: "runVerifyForCli:llm-test-oauth",
            phase: provider,
          });
          oauthResult = false;
        }
      }
      if (hasApi) {
        // Responses API–only models use responses.create(...), not chat.completions; skip direct test to avoid 400/404.
        // Azure Foundry: some deployments (e.g. gpt-5.4-pro) return 400 "The requested operation is unsupported" on chat.completions.
        const isResponsesOnlyModel =
          provider === "azure-foundry-responses" ||
          (provider === "azure-foundry" && bareModel === "gpt-5.4-pro") ||
          (provider === "openai" && (bareModel === "gpt-5-codex" || bareModel === "codex"));
        if (isResponsesOnlyModel) {
          apiResult = undefined;
          apiError = undefined;
          apiSkippedReason =
            provider === "azure-foundry" && bareModel === "gpt-5.4-pro"
              ? "N/A (unsupported on chat completions)"
              : "N/A (Responses API)";
        } else {
          const directClient = getDirectClient(provider);
          if (!directClient) {
            apiResult = false;
            apiError = "No direct client (missing apiKey or baseURL)";
          } else {
            try {
              await chatComplete({
                model: bareModel,
                content: "Reply with exactly: OK",
                maxTokens: 10,
                openai: directClient,
              });
              apiResult = true;
            } catch (e) {
              apiError = shortError(e);
              capturePluginError(e as Error, {
                subsystem: "cli",
                operation: "runVerifyForCli:llm-test-api",
                phase: provider,
              });
              apiResult = false;
            }
          }
        }
      }
    }
    llmRows.push({
      model,
      provider,
      hasOAuth,
      hasApi,
      enabled,
      source,
      inConfig,
      oauthResult,
      apiResult,
      oauthError,
      apiError,
      apiSkippedReason,
    });
  }
  if (llmRows.length === 0) {
    tableLog("  No LLM models configured (add llm.nano / llm.default / llm.heavy or API keys / OAuth).");
    tableLog("  LLMs: add model tiers or API keys in config. See docs/LLM-AND-PROVIDERS.md.");
    tableLog("");
    tableLog("  Summary: Configure LLM tiers or API keys to use memory and cron jobs.");
  } else {
    const llmCols = [
      "Model",
      "Provider",
      "Auth (OAuth / API key)",
      "Source",
      "In config",
      "Enabled",
      ...(opts.testLlm ? ["OAuth Result", "API Result"] : []),
    ];
    const llmW1 = Math.max(8, ...llmRows.map((r) => r.model.length), 28);
    const llmW2 = Math.max(6, ...llmRows.map((r) => r.provider.length), 10);
    const llmW3 = Math.max(22, 24);
    const llmW4 = 8;
    const llmW5 = 9;
    const llmW6 = 8;
    const llmW7 = opts.testLlm ? 14 : 0;
    const llmW8 = opts.testLlm ? 12 : 0;
    tableLog(
      `  ${llmCols[0].padEnd(llmW1)}  ${llmCols[1].padEnd(llmW2)}  ${llmCols[2].padEnd(llmW3)}  ${llmCols[3].padEnd(llmW4)}  ${llmCols[4].padEnd(llmW5)}  ${llmCols[5].padEnd(llmW6)}${opts.testLlm ? `  ${llmCols[6].padEnd(llmW7)}  ${llmCols[7]}` : ""}`,
    );
    const llmSepLen = llmW1 + llmW2 + llmW3 + llmW4 + llmW5 + llmW6 + 12 + (opts.testLlm ? llmW7 + llmW8 + 4 : 0);
    tableLog(`  ${"-".repeat(llmSepLen)}`);
    for (const row of llmRows) {
      const credStr = `OAuth:${row.hasOAuth ? "True" : "False"} / API:${row.hasApi ? "True" : "False"}`;
      const inConfigStr = row.inConfig ? (noEmoji ? "Yes" : "✅ Yes") : noEmoji ? "No" : "No";
      const enabledStr = row.enabled ? (noEmoji ? "Enabled" : "✅ Enabled") : noEmoji ? "Disabled" : "❌ Disabled";
      // When --test-llm: show Success/Failed if we ran the test; "Skipped" if enabled+inConfig but no creds to test; "—" if not in config
      const oauthStr =
        row.oauthResult === true
          ? noEmoji
            ? "Success"
            : "✅ Success"
          : row.oauthResult === false
            ? noEmoji
              ? "Failed"
              : "❌ Failed"
            : opts.testLlm && row.enabled && row.inConfig && !row.hasOAuth
              ? noEmoji
                ? "Skipped (no OAuth)"
                : "⏭️ Skipped"
              : "—";
      const apiStr = row.apiSkippedReason
        ? row.apiSkippedReason
        : row.apiResult === true
          ? noEmoji
            ? "Success"
            : "✅ Success"
          : row.apiResult === false
            ? noEmoji
              ? "Failed"
              : "❌ Failed"
            : opts.testLlm && row.enabled && row.inConfig && !row.hasApi
              ? noEmoji
                ? "Skipped (no key)"
                : "⏭️ Skipped"
              : "—";
      tableLog(
        `  ${row.model.padEnd(llmW1)}  ${row.provider.padEnd(llmW2)}  ${credStr.padEnd(llmW3)}  ${row.source.padEnd(llmW4)}  ${inConfigStr.padEnd(llmW5)}  ${enabledStr.padEnd(llmW6)}${opts.testLlm ? `  ${oauthStr.padEnd(llmW7)}  ${apiStr}` : ""}`,
      );
    }
    const failedRows = opts.testLlm ? llmRows.filter((r) => r.oauthError || r.apiError) : [];
    if (failedRows.length > 0) {
      tableLog("  Failed test details:");
      let has401Openai = false;
      for (const row of failedRows) {
        if (row.oauthError) tableLog(`    ${row.model} (OAuth): ${row.oauthError}`);
        if (row.apiError) {
          tableLog(`    ${row.model} (API): ${row.apiError}`);
          if (row.provider === "openai" && /401|incorrect api key/i.test(row.apiError)) has401Openai = true;
        }
      }
      if (has401Openai) {
        tableLog(
          "  Note: OpenAI: llm.providers.openai.apiKey or OPENAI_API_KEY. Google: llm.providers.google.apiKey or distill.apiKey or GOOGLE_API_KEY. Azure: llm.providers['azure-foundry'].apiKey or AZURE_OPENAI_API_KEY. See docs/LLM-AND-PROVIDERS.md.",
        );
      }
      tableLog("");
    }
    tableLog(
      "  (Source = where API key is set: plugin | env | file | gateway. In config = model in llm.nano/default/heavy. Enabled = provider not in llm.disabledProviders. Skipped = not tested (no API key or OAuth for this provider).)",
    );
    const llmProvidersWithCreds = new Set(llmRows.filter((r) => r.hasApi || r.hasOAuth).map((r) => r.provider)).size;
    const llmOk = llmProvidersWithCreds >= 1;
    if (llmOk) {
      tableLog(
        `  LLMs: OK — credentials available for ${llmProvidersWithCreds} provider(s). Source "—" or "gateway" = key from OpenClaw/env (fine).`,
      );
    } else {
      tableLog(
        "  LLMs: no credentials for any provider — set llm.providers.<provider>.apiKey in config or use gateway OAuth. See docs/LLM-AND-PROVIDERS.md.",
      );
    }
    tableLog("");
    if (anyEmbOk && llmOk) {
      tableLog(
        "  Summary: Ready. Embeddings and LLM are configured. Use memory and cron jobs as needed. Run 'openclaw hybrid-mem config' to toggle features.",
      );
    } else {
      tableLog("  Summary: Fix the issue(s) above (or in --- Fixes --- below) before using memory features.");
    }
  }

  const restartPending = existsSync(getRestartPendingPath());
  const modeLabel = cfg.mode
    ? cfg.mode === "custom"
      ? "Custom"
      : cfg.mode.charAt(0).toUpperCase() + cfg.mode.slice(1)
    : "Custom";
  log("\n───── Config ─────");
  log(`  Config source: ${defaultConfigPath} (plugins.entries["${PLUGIN_ID}"].config)`);
  log(`  Mode: ${modeLabel}${restartPending ? " (restart pending)" : ""}`);
  log(`  Run 'openclaw hybrid-mem config' to view or change settings.`);

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
          fixes.push(
            "Credentials vault: Wrong encryption key or corrupted DB. Set OPENCLAW_CRED_KEY to the key used when credentials were stored, or use a new vault path for plaintext. See docs/CREDENTIALS.md.",
          );
        } else {
          fixes.push(
            `Credentials vault: ${String(e)}. If this vault was created with encryption, set credentials.encryptionKey. See docs/CREDENTIALS.md.`,
          );
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
    log(
      "  If you use session distillation (extracting facts from old logs): after each run, run: openclaw hybrid-mem record-distill",
    );
    log(
      "  If you have a nightly distillation cron job: add a final step to that job to run openclaw hybrid-mem record-distill so this is recorded.",
    );
    log("  If you don't use it, ignore this.");
  }

  // Job name regex patterns for matching (use normalized name so "Weekly Reflection" etc. match)
  const cronStorePath = join(openclawDir, "cron", "jobs.json");
  const nightlyMemorySweepRe = /nightly[- ]?memory[- ]?sweep|memory distillation.*nightly|nightly.*memory.*distill/i;
  const weeklyReflectionRe = /weekly[- ]?reflection|memory reflection|pattern synthesis/i;
  const extractProceduresRe = /extract[- ]?procedures|weekly[- ]?extract[- ]?procedures|procedural memory/i;
  const selfCorrectionRe = /self[- ]?correction[- ]?analysis|self[- ]?correction\b/i;
  const weeklyDeepMaintenanceRe = /weekly[- ]?deep[- ]?maintenance|deep maintenance/i;
  const weeklyPersonaProposalsRe = /weekly[- ]?persona[- ]?proposals|persona proposals/i;
  const monthlyConsolidationRe = /monthly[- ]?consolidation/i;

  const knownJobSlugs = new Set([
    "nightly-memory-sweep",
    "weekly-reflection",
    "weekly-extract-procedures",
    "self-correction-analysis",
    "weekly-deep-maintenance",
    "monthly-consolidation",
    "weekly-persona-proposals",
  ]);

  /** Normalize job name to slug for matching: lowercase, spaces to single hyphen. */
  function nameToSlug(n: string): string {
    return n.toLowerCase().trim().replace(/\s+/g, "-").replace(/-+/g, "-");
  }

  // Helper function to map job names to canonical keys
  function getCanonicalJobKey(name: string, msg?: string): string | null {
    const nameLower = name.toLowerCase();
    const normalized = nameToSlug(name);
    if (
      nightlyMemorySweepRe.test(nameLower) ||
      (msg && /nightly memory distillation|memory distillation pipeline/i.test(msg))
    ) {
      return "nightly-memory-sweep";
    }
    if (weeklyReflectionRe.test(nameLower)) {
      return "weekly-reflection";
    }
    if (extractProceduresRe.test(nameLower)) {
      return "weekly-extract-procedures";
    }
    if (selfCorrectionRe.test(nameLower)) {
      return "self-correction-analysis";
    }
    if (weeklyDeepMaintenanceRe.test(nameLower)) {
      return "weekly-deep-maintenance";
    }
    if (weeklyPersonaProposalsRe.test(nameLower)) {
      return "weekly-persona-proposals";
    }
    if (monthlyConsolidationRe.test(nameLower)) {
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
      statusDetails = `  ${parts.join("  ")}`;
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
          const state = job.state as
            | { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastError?: string }
            | undefined;

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
    {
      key: "nightly-memory-sweep",
      description: "session distillation",
      docsPath: "docs/SESSION-DISTILLATION.md § Nightly Cron Setup",
    },
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
    for (const [_key, job] of unknownJobs) {
      formatJobStatus(job, job.name, "    ", log);
    }
  }

  log(
    "\nBackground jobs (when gateway is running): prune every 60min, auto-classify every 24h if enabled. No external cron required.",
  );

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

  let allOk = configOk && sqliteOk && lanceOk && embeddingOk && (!cfg.credentials.enabled || credentialsOk);

  // ───── Reconciliation Check ─────
  if (opts.reconcile) {
    log("\n───── Vector DB Reconciliation ─────");
    if (!sqliteOk || !lanceOk || !vectorDb.isLanceDbAvailable()) {
      log(`${FAIL} Reconciliation skipped — both SQLite and LanceDB must be healthy to reconcile.`);
      allOk = false;
    } else {
      try {
        const sqliteIds = new Set(factsDb.getAllIds());
        const vectorIds = await vectorDb.getAllIds();

        // Vector orphans: IDs in LanceDB that have no corresponding SQLite fact.
        const vectorOrphans = vectorIds.filter((id) => !sqliteIds.has(id));
        // SQLite orphans: active facts in SQLite with no vector in LanceDB.
        const vectorIdSet = new Set(vectorIds);
        const sqliteOrphans = Array.from(sqliteIds).filter((id) => !vectorIdSet.has(id));

        if (vectorOrphans.length === 0 && sqliteOrphans.length === 0) {
          log(
            `${OK} Reconciliation: SQLite and LanceDB are in sync (${sqliteIds.size} facts, ${vectorIds.length} vectors)`,
          );
        } else {
          allOk = false;
          if (vectorOrphans.length > 0) {
            log(`${FAIL} Vector orphans (in LanceDB but not SQLite): ${vectorOrphans.length}`);
            vectorOrphans.slice(0, 10).forEach((id) => log(`  - ${id}`));
            if (vectorOrphans.length > 10) log(`  … and ${vectorOrphans.length - 10} more`);
            if (opts.fix) {
              let deleted = 0;
              let failed = 0;
              for (const id of vectorOrphans) {
                try {
                  await vectorDb.delete(id);
                  deleted++;
                } catch {
                  failed++;
                }
              }
              log(`  → Deleted ${deleted} orphan vector(s) from LanceDB${failed > 0 ? ` (${failed} failed)` : ""}.`);
            } else {
              log(`  → Run with --fix to delete these orphan vectors from LanceDB.`);
            }
            issues.push(`${vectorOrphans.length} orphan vector(s) in LanceDB with no matching SQLite fact`);
          }
          if (sqliteOrphans.length > 0) {
            const WARN = noEmoji ? "[WARN]" : "⚠️";
            log(`${WARN} SQLite orphans (facts in SQLite with no vector): ${sqliteOrphans.length}`);
            sqliteOrphans.slice(0, 10).forEach((id) => log(`  - ${id}`));
            if (sqliteOrphans.length > 10) log(`  … and ${sqliteOrphans.length - 10} more`);
            log(`  → Re-run the plugin or use the re-index command to rebuild missing vectors.`);
            issues.push(`${sqliteOrphans.length} SQLite fact(s) without corresponding vectors in LanceDB`);
          }
        }
      } catch (e) {
        log(`${FAIL} Reconciliation: FAIL — ${String(e)}`);
        allOk = false;
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:reconcile" });
      }
    }
  }

  if (allOk) {
    log("\nAll checks passed.");
    if (restartPending) {
      process.exitCode = 2; // Scripting: 2 = restart pending (gateway restart recommended)
    }
    log(
      "Note: If you see 'plugins.allow is empty' above, it is from OpenClaw. Optional: set plugins.allow to [\"openclaw-hybrid-memory\"] in openclaw.json for an explicit allow-list.",
    );
    if (!allJobs.has("nightly-memory-sweep")) {
      log(
        "Optional: Set up nightly session distillation via OpenClaw's scheduled jobs or system cron. See docs/SESSION-DISTILLATION.md.",
      );
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
    log(
      `\nEdit config: ${defaultConfigPath} (or OPENCLAW_HOME/openclaw.json). Restart gateway after changing plugin config.`,
    );
  }

  if (opts.fix) {
    const applied: string[] = [];
    if (lanceBindingsFailed) {
      try {
        const { spawnSync } = await import("node:child_process");
        const pkgs = lanceBindingsFailed ? ["@lancedb/lancedb"] : [];
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
        if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object")
          entries[PLUGIN_ID] = { enabled: true, config: {} };
        const mh = entries[PLUGIN_ID] as Record<string, unknown>;
        if (!mh.config || typeof mh.config !== "object") mh.config = {};
        const cfgFix = mh.config as Record<string, unknown>;
        if (!cfgFix.embedding || typeof cfgFix.embedding !== "object") cfgFix.embedding = {};
        const emb = cfgFix.embedding as Record<string, unknown>;
        const curKey = emb.apiKey;
        const placeholder =
          typeof curKey !== "string" ||
          curKey.length < 10 ||
          curKey === "YOUR_OPENAI_API_KEY" ||
          curKey === "<OPENAI_API_KEY>";
        if (placeholder) {
          emb.apiKey = "YOUR_OPENAI_API_KEY";
          emb.model = emb.model || "text-embedding-3-small";
          changed = true;
          applied.push("Set embedding.apiKey and model (use your key or ${OPENAI_API_KEY} in config)");
        }
        const memoryDirPath = dirname(resolvedSqlitePath);
        if (!existsSync(memoryDirPath)) {
          mkdirSync(memoryDirPath, { recursive: true });
          applied.push(`Created memory directory: ${memoryDirPath}`);
        }

        // Add cron jobs (same logic as install)
        const cronDir = join(openclawDir, "cron");
        const cronStorePath = join(cronDir, "jobs.json");

        try {
          const scheduleOverrides: Record<string, string> = {};
          if (typeof cfg.nightlyCycle?.schedule === "string" && cfg.nightlyCycle.schedule.trim().length > 0) {
            scheduleOverrides["hybrid-mem:nightly-dream-cycle"] = cfg.nightlyCycle.schedule;
          }
          if (typeof cfg.sensorSweep?.schedule === "string" && cfg.sensorSweep.schedule.trim().length > 0) {
            scheduleOverrides["hybrid-mem:sensor-sweep"] = cfg.sensorSweep.schedule;
          }
          const { added, normalized } = ensureMaintenanceCronJobs(openclawDir, getCronModelConfig(cfg), {
            normalizeExisting: true,
            reEnableDisabled: false,
            scheduleOverrides: Object.keys(scheduleOverrides).length > 0 ? scheduleOverrides : undefined,
            featureGates: {
              "sensorSweep.enabled": cfg.sensorSweep?.enabled === true,
              "nightlyCycle.enabled": cfg.nightlyCycle?.enabled === true,
            },
          });
          added.forEach((name) => applied.push(`Added ${name} job to ${cronStorePath}`));
          normalized.forEach((name) => applied.push(`Normalized ${name} job (schedule/pluginJobId)`));
        } catch (e) {
          log(`Could not add optional jobs to cron store: ${String(e)}`);
          capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:add-cron-jobs" });
        }

        if (changed) {
          writeFileSync(defaultConfigPath, JSON.stringify(fixConfig, null, 2), "utf-8");
        }
        if (applied.length > 0) {
          log("\n--- Applied fixes ---");
          applied.forEach((a) => log(`  • ${a}`));
          if (changed) log(`Config written: ${defaultConfigPath}. Restart the gateway and run verify again.`);
        }
      } catch (e) {
        log(`\nCould not apply fixes to config: ${String(e)}`);
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
      log(
        "Config file not found. Run 'openclaw hybrid-mem install' to create it with full defaults, then set your API key and restart.",
      );
    }
  }

  if (opts.reconcile) {
    log("\n───── Vector / SQLite consistency (reconcile) ─────");
    try {
      await vectorDb.ensureInitialized();
      const vCount = await vectorDb.count();
      const embCount = factsDb.countCanonicalEmbeddings();
      log(`${OK} SQLite canonical embeddings (fact_embeddings): ${embCount}`);
      const lanceRowsOk = vectorDb.isLanceAvailable();
      log(`${lanceRowsOk ? OK : PAUSE} LanceDB row count: ${vCount} (lanceAvailable=${lanceRowsOk})`);
      if (lanceRowsOk && vCount !== embCount) {
        log(
          `${FAIL} Drift: fact_embeddings rows (${embCount}) != Lance rows (${vCount}). Consider re-embed or diagnostics.`,
        );
      }
    } catch (e) {
      log(`${FAIL} Reconcile check failed: ${e}`);
    }
  }
}
