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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import OpenAI from "openai";

import { findPluginRoot } from "../utils/plugin-root.js";

import type { CredentialType } from "../config.js";
import {
  getCronModelConfig,
  getLLMModelPreference,
  getLLMModelPreferenceUnfiltered,
  getProvidersWithKeys,
  isCompactVerbosity,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { resolveSecretRef } from "../config/parsers/core.js";
import { getEffectiveModelLimits, loadAdaptiveModelLimits } from "../services/adaptive-model-limits.js";
import { chatComplete, distillBatchTokenLimit, distillMaxOutputTokens } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { readGuardTimestampMs } from "../services/cron-guard.js";
import { HYBRID_MEM_CRON_ENV_SANITIZER_MARKER } from "../services/cron-job-bash-harness.js";
import { reconcileAllCronRunLedgers } from "../services/cron-maintenance-reconciler.js";
import {
  collectRecentHmExitLedgerPaths,
  findDeprecatedHybridMemCronTokens,
  findDeprecatedTokensInHmExitContent,
} from "../services/deprecated-cron-commands.js";
import {
  type EmbeddingConfig,
  GOOGLE_EMBED_DEFAULT_DIMENSIONS,
  GOOGLE_EMBED_DEFAULT_MODEL,
  OPENAI_ONLY_EMBED_MODELS,
  createEmbeddingProvider,
} from "../services/embeddings.js";
import { formatOpenAiEmbeddingDisplayLabel } from "../services/embeddings/shared.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  analyzeCronJobsAgainstHeartbeatPatterns,
  extractCronJobMessageEntries,
  getHeartbeatMatchersForVerify,
} from "../services/goal-stewardship-verify-cron.js";
import { HYBRID_MEM_CRON_DEFAULT_JOB_STEPS } from "../services/hybrid-mem-cron-default-job-steps.js";
import { resolveWireApi } from "../services/model-capabilities.js";
import { callResponsesApi } from "../services/responses-adapter.js";
import { appendVectorLifecycleAuditEvent } from "../services/vector-lifecycle-audit.js";
import { hasOAuthProfiles } from "../utils/auth.js";
import { PLUGIN_ID, getRestartPendingPath } from "../utils/constants.js";
import { inferModelProviderPrefix } from "../utils/model-provider-family.js";
import { isHeavyModel } from "../utils/model-tier.js";
import {
  extractCronStoreJobModel,
  readEffectiveAgentChatPrimaryFromOpenclawJsonRoot,
} from "../utils/openclaw-agent-defaults.js";
import {
  ensureGoalStewardshipHeartbeatCronJob,
  ensureMaintenanceCronJobs,
  getPluginConfigFromFile,
} from "./cmd-install.js";
import { approxIntervalMs, relativeTime } from "./shared.js";
import { applyAzureFoundryVerifyDirectClientAuth } from "./verify-llm-azure-auth.js";

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
  opts: {
    fix: boolean;
    logFile?: string;
    testLlm?: boolean;
    reconcile?: boolean;
    reconcilePolicy?: "conservative" | "balanced" | "aggressive";
    reconcileMaxFixes?: number;
  },
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
  const WARN_LINE = noEmoji ? "[WARN]" : "⚠️";
  const _ON = noEmoji ? "[on]" : "✅ on";
  const _OFF = noEmoji ? "[off]" : "❌ off";
  const issues: string[] = [];
  const fixes: string[] = [];
  /** Non-blocking warnings: shown alongside "All checks passed" so signals like a missing heartbeat or overdue cron are not silently buried. */
  const warnings: string[] = [];
  let configOk = true;
  let sqliteOk = false;
  let lanceOk = false;
  let embeddingOk = false;
  /** False when probe vector length ≠ Lance expected dim or Lance schema invalid for vectors. */
  let embeddingAlignmentOk = true;
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

  const extDir = findPluginRoot(import.meta.url);
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
      fixes.push("node:sqlite is not available. Upgrade Node.js to >=22.16.0 or use a compatible version.");
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
    const degradedState =
      typeof (vectorDb as { getDegradedState?: unknown }).getDegradedState === "function"
        ? (
            vectorDb as {
              getDegradedState: () => { active: boolean; reason: string | null; sinceEpochMs: number | null };
            }
          ).getDegradedState()
        : { active: false, reason: null as string | null, sinceEpochMs: null as number | null };
    if (degradedState.active) {
      const WARN = noEmoji ? "[WARN]" : "⚠️";
      log(
        `${WARN} LanceDB degraded mode is active${degradedState.reason ? ` (reason=${degradedState.reason})` : ""}. Use 'openclaw hybrid-mem repair-vectors' after connectivity/config fixes.`,
      );
      warnings.push(
        `LanceDB degraded mode active${degradedState.reason ? ` (${degradedState.reason})` : ""}; vector retrieval may be unavailable`,
      );
    }
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

  // ───── Embedding ↔ Lance alignment (dimensions) ─────
  tableLog("\n───── Embedding ↔ vector store (dimensions) ─────");
  if (!sqliteOk || !lanceOk || !vectorDb.isLanceDbAvailable()) {
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    tableLog(
      `${WARN}  Skipped — SQLite and LanceDB must be healthy to compare embedding size vs index. Fix errors above, then re-run verify.`,
    );
  } else {
    try {
      await vectorDb.ensureInitialized();
      const providerDims = embeddings.dimensions;
      const lanceDims = vectorDb.getVectorDim();
      const configDims = cfg.embedding.dimensions;
      const schemaOk = vectorDb.isMemoriesVectorSchemaValid();
      tableLog(`  Active embedding provider: ${providerDims} dimensions (model: ${embeddings.modelName})`);
      tableLog(`  Config embedding.dimensions: ${configDims ?? "(default from model/catalog)"}`);
      tableLog(`  LanceDB (this process): expects ${lanceDims}-dim vectors`);
      if (configDims !== undefined && configDims !== providerDims) {
        const WARN = noEmoji ? "[WARN]" : "⚠️";
        tableLog(
          `${WARN}  Config embedding.dimensions (${configDims}) differs from runtime provider (${providerDims}) — runtime size is used for the index.`,
        );
      }
      if (!schemaOk) {
        embeddingAlignmentOk = false;
        log(
          `${FAIL} Lance memories table: schema not valid for vector search (missing vector column or on-disk dimension mismatch).`,
        );
        log(
          `  Fix: Set embedding.model / embedding.dimensions to match the table you need, enable vector.autoRepair=true to rebuild the empty table, or remove the LanceDB directory and restart. Then run: openclaw hybrid-mem re-index`,
        );
        issues.push("LanceDB memories table schema invalid for vectors (dimension mismatch or missing column)");
        fixes.push(
          "Align embedding.model and embedding.dimensions with your Lance table, or delete the LanceDB data directory and re-index. See plugin config vector.autoRepair.",
        );
      } else {
        const probeText = "openclaw hybrid-mem verify dimension probe";
        const probeVec = await embeddings.embed(probeText);
        const probeLen = probeVec.length;
        tableLog(`  Probe embedding: API returned ${probeLen}-dim vector`);
        if (probeLen !== providerDims) {
          const WARN = noEmoji ? "[WARN]" : "⚠️";
          tableLog(
            `${WARN}  Provider reports ${providerDims} dimensions but probe returned ${probeLen} — using probe length as truth for this run.`,
          );
        }
        if (probeLen === lanceDims) {
          log(`${OK} Embedding ↔ Lance: OK (${probeLen} dimensions; index matches API output)`);
        } else {
          embeddingAlignmentOk = false;
          log(
            `${FAIL} Embedding ↔ Lance: MISMATCH — API returned ${probeLen} dimensions but LanceDB expects ${lanceDims}-dim vectors. Semantic search will return no results until fixed.`,
          );
          log(
            `  What to do: (1) Set embedding.model to the model you want as primary (same output size as your index).`,
          );
          log(`  (2) Set embedding.dimensions to that size if it differs from the catalog default.`);
          log(
            `  (3) If you use a provider chain, set embedding.preferredProviders so only providers with the same vector size are listed (e.g. ["openai"] only).`,
          );
          log(
            `  (4) Run: openclaw hybrid-mem re-index — rebuilds vectors from SQLite with the current embedding config.`,
          );
          issues.push(
            `Embedding dimension mismatch: API probe ${probeLen} vs Lance index ${lanceDims} (provider.dimensions=${providerDims})`,
          );
          fixes.push(
            'Match embedding model/dimensions to the LanceDB vector width, then run `openclaw hybrid-mem re-index`. Prefer embedding.preferredProviders: ["openai"] if a Google key accidentally forced a different chain size.',
          );
        }
      }
    } catch (e) {
      embeddingAlignmentOk = false;
      const msg = e instanceof Error ? e.message : String(e);
      log(`${FAIL} Embedding ↔ Lance: check failed — ${msg}`);
      issues.push(`Embedding alignment probe failed: ${msg}`);
      fixes.push(
        "Ensure embedding credentials and model are valid, then re-run verify. If you changed embedding settings, run `openclaw hybrid-mem re-index` after fixing config.",
      );
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "cli",
        operation: "runVerifyForCli:embedding-alignment",
      });
    }
  }

  // ───── LLM / models table: one row per model from llm.nano / llm.maintenance / llm.default / llm.heavy; auth + source ─────
  tableLog("\n───── LLM / Models (from llm.nano, llm.maintenance, llm.default, llm.heavy) ─────");
  const cronCfg = getCronModelConfig(cfg);
  const providersWithKeys = getProvidersWithKeys(cronCfg);
  const authOrder = (cfg as Record<string, unknown>).auth as { order?: Record<string, string[]> } | undefined;
  const gatewayPort = getEnv("OPENCLAW_GATEWAY_PORT");
  const gatewayToken = getEnv("OPENCLAW_GATEWAY_TOKEN");
  const gatewayAvailable = Boolean(
    gatewayPort && Number(gatewayPort) >= 1 && Number(gatewayPort) <= 65535 && gatewayToken,
  );
  const tierNano = getLLMModelPreferenceUnfiltered(cronCfg, "nano");
  const tierMaintenance = getLLMModelPreferenceUnfiltered(cronCfg, "maintenance");
  const tierDefault = getLLMModelPreferenceUnfiltered(cronCfg, "default");
  const tierHeavy = getLLMModelPreferenceUnfiltered(cronCfg, "heavy");
  const nanoExplicitConfigured =
    Array.isArray(cronCfg.llm?.nano) && cronCfg.llm.nano.some((m) => typeof m === "string" && m.trim().length > 0);
  const maintenanceExplicitConfigured =
    Array.isArray(cronCfg.llm?.maintenance) &&
    cronCfg.llm.maintenance.some((m) => typeof m === "string" && m.trim().length > 0);
  const allModelsUnfiltered: string[] = [...tierNano, ...tierMaintenance, ...tierDefault, ...tierHeavy];
  function tiersForModel(model: string): string {
    const tags: string[] = [];
    if (tierNano.includes(model)) tags.push("nano");
    if (tierMaintenance.includes(model)) tags.push("maintenance");
    if (tierDefault.includes(model)) tags.push("default");
    if (tierHeavy.includes(model)) tags.push("heavy");
    if (tags.length === 0) return "—";
    return tags.join(", ");
  }
  const fmtTierList = (arr: string[]) => (arr.length > 0 ? arr.join(", ") : "(none)");
  tableLog("  Effective tier lists (first model in each tier wins when that tier is selected):");
  tableLog(
    `    nano:    ${fmtTierList(tierNano)}${nanoExplicitConfigured ? "" : "  — llm.nano unset; nano tier reuses the default list"}`,
  );
  tableLog(
    `    maintenance: ${fmtTierList(tierMaintenance)}${maintenanceExplicitConfigured ? "" : "  — llm.maintenance unset; maintenance tier reuses the default list"}`,
  );
  tableLog(`    default: ${fmtTierList(tierDefault)}`);
  tableLog(`    heavy:   ${fmtTierList(tierHeavy)}`);
  tableLog(
    `    First choice per tier: nano=${tierNano[0] ?? "—"} | maintenance=${tierMaintenance[0] ?? "—"} | default=${tierDefault[0] ?? "—"} | heavy=${tierHeavy[0] ?? "—"}`,
  );
  const distillMainTier = cfg.distill?.modelTier ?? "maintenance";
  // Show the actual effective tier after clamping (cmd-distill.ts clamps "heavy" to "maintenance")
  const effectiveDistillMainTier = distillMainTier === "heavy" ? "maintenance" : distillMainTier;
  const distillMainEffective = getLLMModelPreference(cronCfg, effectiveDistillMainTier)[0] ?? "—";
  tableLog(
    `    Distill main pass: distill.modelTier=${distillMainTier}${distillMainTier === "heavy" ? " (clamped to maintenance)" : ""} -> ${distillMainEffective}; --model overrides one run.`,
  );
  const dreamOverride =
    typeof cfg.nightlyCycle?.model === "string" && cfg.nightlyCycle.model.trim().length > 0
      ? cfg.nightlyCycle.model.trim()
      : null;
  const dreamEffective = dreamOverride ?? getLLMModelPreference(cronCfg, "maintenance")[0] ?? "—";
  const extractionTier = cfg.distill?.extractionModelTier ?? "nano";
  tableLog(
    dreamOverride
      ? `    Dream cycle + MEMORY_INDEX.md: nightlyCycle.model="${dreamOverride}" (overrides default tier for that pipeline).`
      : `    Dream cycle + MEMORY_INDEX.md: uses maintenance tier first choice (${tierMaintenance[0] ?? "—"}) unless nightlyCycle.model is set.`,
  );
  tableLog(
    "    Embeddings / re-index: embedding.model + embedding.* (not llm tiers). Chat LLM spend is separate from embedding API spend.",
  );

  const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
  const adaptiveStatePath =
    typeof ctx.resolvedSqlitePath === "string" && ctx.resolvedSqlitePath.length > 0
      ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
      : "";
  tableLog(
    `    Adaptive maintenance LLM sizing: ${adaptiveEnabled ? "enabled" : "disabled"} (state=${adaptiveStatePath}; applies to distill, reflect, extract-reinforcement, self-correction-run)`,
  );
  if (adaptiveEnabled && adaptiveStatePath && existsSync(adaptiveStatePath)) {
    try {
      const adaptiveState = loadAdaptiveModelLimits(adaptiveStatePath);
      const sampleModels = [
        distillMainEffective,
        dreamEffective,
        getLLMModelPreference(cronCfg, extractionTier)[0] ?? "—",
        tierHeavy[0] ?? "—",
      ].filter((m, i, arr) => m !== "—" && arr.indexOf(m) === i);
      for (const sampleModel of sampleModels) {
        const effective = getEffectiveModelLimits({
          state: adaptiveState,
          model: sampleModel,
          catalogBatchTokenLimit: distillBatchTokenLimit(sampleModel),
          catalogMaxOutputTokens: distillMaxOutputTokens(sampleModel),
        });
        tableLog(
          `      ${sampleModel}: batchTokenLimit=${effective.batchTokenLimit}, maxOutputTokens=${effective.maxOutputTokens}, source=${effective.source}`,
        );
      }
    } catch (err) {
      warnings.push(
        `adaptive maintenance LLM state could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Maintenance routing warnings: flag when maintenance-adjacent tasks are routed to heavy/expensive models unintentionally.
  // NOTE: cmd-distill.ts now clamps distill.modelTier=heavy to maintenance, so this check uses effectiveDistillMainTier.
  if (effectiveDistillMainTier !== "heavy" && distillMainEffective !== "—" && isHeavyModel(distillMainEffective)) {
    warnings.push(
      `distill.modelTier=${distillMainTier} routes the main distill pass to a heavy/expensive first-choice model (${distillMainEffective}); configure llm.maintenance with a cheap-first list or set distill.modelTier=nano`,
    );
  }
  if (distillMainTier === "heavy") {
    warnings.push(
      `distill.modelTier=heavy is not supported for the main distill pass (clamped to maintenance in cmd-distill.ts). Use --model to override for a single run if needed.`,
    );
  }
  const extractionFirst =
    getLLMModelPreference(cronCfg, extractionTier)[0] ?? getLLMModelPreference(cronCfg, "nano")[0] ?? "—";
  if (extractionTier !== "heavy" && extractionFirst !== "—" && isHeavyModel(extractionFirst)) {
    warnings.push(
      `distill.extractionModelTier=${extractionTier} routes session extraction to a heavy/expensive first-choice model (${extractionFirst}); set distill.extractionModelTier=nano or configure llm.maintenance and use distill.extractionModelTier=maintenance`,
    );
  }
  if (dreamEffective !== "—" && isHeavyModel(dreamEffective)) {
    warnings.push(
      `dream-cycle/MEMORY_INDEX routes to a heavy/expensive model (${dreamEffective}); set nightlyCycle.model to a cheaper model or configure llm.maintenance with a cheap-first list`,
    );
  }
  const _allModelsFiltered: string[] = [
    ...getLLMModelPreference(cronCfg, "nano"),
    ...getLLMModelPreference(cronCfg, "maintenance"),
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
      (provider === "azure-foundry" || provider === "azure-foundry-responses" || provider === "azure-foundry-direct") &&
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
    let baseURL =
      (typeof provEntry?.baseURL === "string" && provEntry.baseURL.trim() ? provEntry.baseURL.trim() : undefined) ??
      (typeof provEntry?.baseUrl === "string" && provEntry.baseUrl.trim() ? provEntry.baseUrl.trim() : undefined) ??
      VERIFY_LLM_BASE_URLS[provider];
    if (!baseURL) return undefined;
    // Anthropic's OpenAI-compatible chat endpoint requires /v1 suffix; normalize host-only baseURL (issue #950).
    if (provider === "anthropic") {
      baseURL = baseURL.replace(/\/+$/, "");
      if (!baseURL.endsWith("/v1")) {
        baseURL = baseURL + "/v1";
      }
    }
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
    applyAzureFoundryVerifyDirectClientAuth(opts, provider, apiKey);
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
    tiersLabel: string;
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
  /** Azure Responses rejects max_output_tokens below 16; chat probes still work with a small cap. */
  const VERIFY_LLM_PROBE_MAX_TOKENS = 64;
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
    const tiersLabel = tiersForModel(model);
    let oauthResult: boolean | undefined = undefined;
    let apiResult: boolean | undefined = undefined;
    let oauthError: string | undefined = undefined;
    let apiError: string | undefined = undefined;
    let apiSkippedReason: string | undefined = undefined;
    // Test each model that has credentials (OAuth or API), so we report which work even if not yet in llm.nano/maintenance/default/heavy.
    if (opts.testLlm && enabled && (hasOAuth || hasApi)) {
      const bareModel = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
      const wireApi = resolveWireApi(model);
      // Some Azure SKUs only expose Responses; others reject non-default temperature on chat — probe must match.
      const isResponsesOnlyModel =
        wireApi === "responses" ||
        (provider === "azure-foundry" && bareModel === "gpt-5.4-pro") ||
        (provider === "azure-foundry" && /^o3-pro$/i.test(bareModel)) ||
        (provider === "openai" && (bareModel === "gpt-5-codex" || bareModel === "codex"));

      if (hasOAuth && gatewayBaseUrl && gatewayToken) {
        try {
          const oauthClient = new OpenAI({ apiKey: gatewayToken, baseURL: gatewayBaseUrl });
          await chatComplete({
            model,
            content: "Reply with exactly: OK",
            maxTokens: VERIFY_LLM_PROBE_MAX_TOKENS,
            temperature: 1,
            openai: oauthClient,
            feature: CostFeature.verifyCliLlm,
            ...(isResponsesOnlyModel ? { wireApi: "responses" as const } : {}),
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
        if (isResponsesOnlyModel) {
          const directClient = getDirectClient(provider);
          if (!directClient) {
            apiResult = false;
            apiError = "No direct client (missing apiKey or baseURL)";
          } else {
            try {
              await callResponsesApi(directClient, {
                model: bareModel,
                content: "Reply with exactly: OK",
                maxTokens: VERIFY_LLM_PROBE_MAX_TOKENS,
                temperature: 1,
              });
              apiResult = true;
              apiSkippedReason = undefined;
            } catch (e) {
              const errMsg = shortError(e);
              if (errMsg.includes("does not expose responses.create") || /\b(404|405)\b/.test(errMsg)) {
                apiResult = undefined;
                apiError = undefined;
                apiSkippedReason = "N/A (Responses API not available on endpoint)";
              } else {
                apiError = errMsg;
                if (
                  /\b400\b/i.test(errMsg) &&
                  (provider === "azure-foundry" ||
                    provider === "azure-foundry-responses" ||
                    provider === "azure-foundry-direct") &&
                  errMsg.length < 160
                ) {
                  apiError = `${errMsg} — HTTP 400 with a minimal body often means the gateway rejected the route or request shape (wrong APIM product path vs resource URL, or policy). See docs/TROUBLESHOOTING.md (#949).`;
                }
                capturePluginError(e as Error, {
                  subsystem: "cli",
                  operation: "runVerifyForCli:llm-test-responses-api",
                  phase: provider,
                });
                apiResult = false;
              }
            }
          }
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
                maxTokens: VERIFY_LLM_PROBE_MAX_TOKENS,
                temperature: 1,
                openai: directClient,
                feature: CostFeature.verifyCliLlm,
              });
              apiResult = true;
            } catch (e) {
              apiError = shortError(e);
              if (
                apiError &&
                /\b400\b/i.test(apiError) &&
                (provider === "azure-foundry" ||
                  provider === "azure-foundry-responses" ||
                  provider === "azure-foundry-direct") &&
                apiError.length < 160
              ) {
                apiError = `${apiError} — HTTP 400 with a minimal body often means the gateway rejected the route or request shape (wrong APIM product path vs resource URL, or policy). See docs/TROUBLESHOOTING.md (#949).`;
              }
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
      tiersLabel,
      oauthResult,
      apiResult,
      oauthError,
      apiError,
      apiSkippedReason,
    });
  }
  if (llmRows.length === 0) {
    tableLog(
      "  No LLM models configured (add llm.nano / llm.maintenance / llm.default / llm.heavy or API keys / OAuth).",
    );
    tableLog("  LLMs: add model tiers or API keys in config. See docs/LLM-AND-PROVIDERS.md.");
    tableLog("");
    tableLog("  Summary: Configure LLM tiers or API keys to use memory and cron jobs.");
  } else {
    const llmCols = [
      "Model",
      "Provider",
      "Auth (OAuth / API key)",
      "Source",
      "Tier(s)",
      "Enabled",
      ...(opts.testLlm ? ["OAuth Result", "API Result"] : []),
    ];
    const llmW1 = Math.max(8, ...llmRows.map((r) => r.model.length), 28);
    const llmW2 = Math.max(6, ...llmRows.map((r) => r.provider.length), 10);
    const llmW3 = Math.max(22, 24);
    const llmW4 = 8;
    const llmW5 = Math.max(9, ...llmRows.map((r) => r.tiersLabel.length), 22);
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
      const tiersStr = row.tiersLabel;
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
        `  ${row.model.padEnd(llmW1)}  ${row.provider.padEnd(llmW2)}  ${credStr.padEnd(llmW3)}  ${row.source.padEnd(llmW4)}  ${tiersStr.padEnd(llmW5)}  ${enabledStr.padEnd(llmW6)}${opts.testLlm ? `  ${oauthStr.padEnd(llmW7)}  ${apiStr}` : ""}`,
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
      '  (Tier(s) = which tier lists include this model; "—" = reference row only, not in your llm.nano/maintenance/default/heavy. Source = key origin. Enabled = provider not in llm.disabledProviders. Skipped = not tested.)',
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
        const st = credentialsDb.getVaultStatus();
        const stateLabel = st.encryptedAtRest
          ? `encrypted (kdf_version=${st.kdfVersion})`
          : `plaintext (kdf_version=${st.kdfVersion})`;
        log(`\nCredentials (vault): OK (${items.length} stored) [${stateLabel}]`);
        log(
          `Credentials (vault): encryption_key_configured=${st.configuredKeyPresent ? "yes" : "no"}; migration_required=${
            st.migrationRequired ? "yes" : "no"
          }`,
        );
        if (st.migrationRequired) {
          const WARN = noEmoji ? "[WARN]" : "⚠️";
          log(
            `${WARN} Credentials (vault): encryption key is configured but ignored until the existing vault is encrypted at rest.`,
          );
          log("Fix: run `openclaw hybrid-mem credentials encrypt-vault --yes` (see docs/CREDENTIALS.md).");
        }
      } catch (e) {
        issues.push(`Credentials vault: ${String(e)}`);
        const hasKey = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
        if (hasKey) {
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

  // Goal stewardship — heartbeat patterns vs cron job messages (issue #1094)
  if (cfg.goalStewardship.enabled) {
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    const gs = cfg.goalStewardship;
    log("\n───── Goal stewardship (heartbeat) ─────");
    log(
      `${OK} Enabled — heartbeatStewardship: ${gs.heartbeatStewardship ? "on" : "off"} (plugin does not schedule LLM turns; OpenClaw/cron delivers messages)`,
    );
    const matchers = getHeartbeatMatchersForVerify(gs);
    const patternsPreview = (gs.heartbeatPatterns ?? []).slice(0, 3);
    const patternsTail =
      (gs.heartbeatPatterns?.length ?? 0) > patternsPreview.length
        ? `, … (${(gs.heartbeatPatterns?.length ?? 0) - patternsPreview.length} more)`
        : "";
    const patternsHint = patternsPreview.length > 0 ? `: ${patternsPreview.join(" | ")}${patternsTail}` : "";
    log(`  Heartbeat patterns compiled: ${matchers.length} matcher(s)${patternsHint}.`);
    log("  See docs/GOAL-STEWARDSHIP-OPERATOR.md (Heartbeat scheduling checklist).");
    try {
      if (!existsSync(cronStorePath)) {
        log(
          `${WARN} Cannot confirm heartbeat cron: ${cronStorePath} not found. Run \`openclaw hybrid-mem verify --fix\` to seed maintenance jobs, then add a small heartbeat job whose message matches one of the patterns above.`,
        );
      } else {
        const raw = readFileSync(cronStorePath, "utf-8");
        const store = JSON.parse(raw) as { jobs?: unknown[] };
        const entries = extractCronJobMessageEntries(store);
        const h = analyzeCronJobsAgainstHeartbeatPatterns(matchers, entries);
        const withText = entries.filter((e) => e.text.length > 0).length;
        if (entries.length === 0) {
          log(`${WARN} Cron store has no jobs — cannot confirm a heartbeat-shaped message will be delivered.`);
        } else if (withText === 0) {
          log(
            `${WARN} No job message text found in cron store (payload.message / message empty). Stewardship prepends only run when the agent sees a user message matching heartbeat patterns.`,
          );
        } else if (h.matchingJobIds.length === 0) {
          const enabledSample = entries
            .filter((e) => e.enabled && e.text.length > 0)
            .slice(0, 3)
            .map((e) => e.id);
          log(
            `${WARN} No enabled cron job message matches current heartbeat patterns (${withText} job(s) with text${
              h.disabledMatchingJobIds.length > 0 ? `; ${h.disabledMatchingJobIds.length} disabled job(s) match` : ""
            }).`,
          );
          if (enabledSample.length > 0) {
            log(`         Checked enabled jobs (sample): ${enabledSample.join(", ")}`);
          }
          log(
            "         Fix: either (a) add a small dedicated heartbeat job whose payload.message contains one of the patterns above (recommended), or (b) extend goalStewardship.heartbeatPatterns to match an existing job message. Maintenance jobs are intentionally not heartbeat-shaped.",
          );
          warnings.push("goal stewardship: no enabled cron job message matches heartbeat patterns");
        } else {
          log(`${OK} Cron jobs with heartbeat-matching message: ${h.matchingJobIds.join(", ")}`);
          if (h.disabledMatchingJobIds.length > 0) {
            log(`ℹ (Disabled jobs also matched — excluded from delivery: ${h.disabledMatchingJobIds.join(", ")})`);
          }
        }
      }
    } catch (e) {
      log(`${WARN} Cannot read or parse cron store for heartbeat check: ${e instanceof Error ? e.message : String(e)}`);
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "cli",
        operation: "runVerifyForCli:goal-stewardship-heartbeat",
      });
    }
  }

  const knownJobSlugs = new Set([
    "nightly-memory-sweep",
    "weekly-reflection",
    "weekly-extract-procedures",
    "self-correction-analysis",
    "weekly-deep-maintenance",
    "monthly-consolidation",
    "weekly-persona-proposals",
    "nightly-dream-cycle",
    "sensor-sweep",
  ]);
  const nightlyDreamCycleRe = /nightly[- ]?dream[- ]?cycle|dream[- ]?cycle/i;
  const sensorSweepRe = /sensor[- ]?sweep/i;

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
    if (nightlyDreamCycleRe.test(nameLower)) {
      return "nightly-dream-cycle";
    }
    if (sensorSweepRe.test(nameLower)) {
      return "sensor-sweep";
    }
    if (knownJobSlugs.has(normalized)) {
      return normalized;
    }
    if (name) {
      return name;
    }
    return null;
  }

  /** Prefer the newer of runner state and persistent guard file (state can lag after restart). */
  function effectiveCronLastRunMs(job: {
    state?: { lastRunAtMs?: number };
    lastRunGuardMs?: number | null;
  }): number | null {
    const stateMs = typeof job.state?.lastRunAtMs === "number" ? job.state.lastRunAtMs : null;
    const guardMs = typeof job.lastRunGuardMs === "number" ? job.lastRunGuardMs : null;
    if (stateMs != null && guardMs != null) return Math.max(stateMs, guardMs);
    return stateMs ?? guardMs;
  }

  // Helper function to format job status display
  function formatJobStatus(job: JobInfo, label: string, indent: string, log: (msg: string) => void): void {
    const isFeatureGated = job.featureGateDisabled === true;
    const statusIcon = job.enabled ? OK : isFeatureGated ? "○" : PAUSE;
    const statusText = job.enabled ? "enabled " : isFeatureGated ? "gated   " : "disabled";

    const parts: string[] = [];

    if (job.scheduleExpr) parts.push(job.scheduleExpr);

    const stateMs = typeof job.state?.lastRunAtMs === "number" ? job.state.lastRunAtMs : null;
    const lastMs = effectiveCronLastRunMs(job);
    if (lastMs != null) {
      if (stateMs != null && lastMs === stateMs) {
        parts.push(`last: ${relativeTime(lastMs)} (${job.state?.lastStatus ?? "unknown"})`);
      } else {
        parts.push(`last: ${relativeTime(lastMs)} (guard)`);
      }
    } else {
      parts.push("last: never");
    }

    if (job.state?.nextRunAtMs) {
      parts.push(`next: ${relativeTime(job.state.nextRunAtMs)}`);
    }
    const interval = approxIntervalMs(job.scheduleExpr ?? null);
    let stale = false;
    if (job.enabled && interval) {
      if (lastMs == null || Date.now() - lastMs > interval * 1.5) stale = true;
    }

    const note = isFeatureGated
      ? "  (disabled by feature gate; will re-enable when feature turns on)"
      : stale
        ? `  ${WARN_LINE} overdue`
        : "";

    log(`${indent}${statusIcon} ${label.padEnd(30)} ${statusText}  ${parts.join("  ")}${note}`);

    if (job.state?.lastError && job.state.lastStatus === "error") {
      const errorPreview = job.state.lastError.slice(0, 100);
      log(`${indent}   └─ error: ${errorPreview}${job.state.lastError.length > 100 ? "..." : ""}`);
    }
  }

  log("\nScheduled jobs (cron store at ~/.openclaw/cron/jobs.json):");

  interface JobInfo {
    name: string;
    pluginJobId?: string;
    message?: string;
    enabled: boolean;
    /** Set by ensureMaintenanceCronJobs when a feature gate disabled the job. */
    featureGateDisabled?: boolean;
    /** Cron expression (string or { expr }) so verify can show schedule + flag overdue. */
    scheduleExpr?: string | null;
    /** Lifted from `~/.openclaw/cron/guard/<job>.ms` when the runner has not written `state.lastRunAtMs` yet. */
    lastRunGuardMs?: number | null;
    /** Set when the job carries a `pluginJobId` starting with `hybrid-mem:` (treat the `Other` list as truly external). */
    isHybridMem?: boolean;
    deprecatedCronTokens?: string[];
    state?: {
      nextRunAtMs?: number;
      lastRunAtMs?: number;
      lastStatus?: string;
      lastError?: string;
    };
  }

  const allJobs = new Map<string, JobInfo>();

  function hybridMemCronMessageSanitizerStatus(message: string): "ok" | "partial" | "missing" {
    if (message.includes(HYBRID_MEM_CRON_ENV_SANITIZER_MARKER)) return "ok";
    const required = [
      "OPENCLAW_SKIP_HYBRID_MEMORY_CLI",
      "OPENCLAW_HOME",
      "OPENCLAW_CLI",
      "OPENCLAW_SERVICE_KIND",
      "OPENCLAW_SERVICE_MARKER",
    ];
    const present = required.filter((v) => message.includes(`-u ${v}`));
    if (present.length > 0 && present.length < required.length) return "partial";
    const mentionsHybridMem = /openclaw\s+hybrid-mem\b/.test(message);
    const hasAnyUnsets =
      message.includes("-u OPENCLAW_HOME") ||
      message.includes("-u OPENCLAW_CLI") ||
      message.includes("-u OPENCLAW_SERVICE_KIND") ||
      message.includes("-u OPENCLAW_SERVICE_MARKER");
    if (mentionsHybridMem && !hasAnyUnsets) return "missing";
    return "ok";
  }

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
          const featureGateDisabled = job.featureGateDisabled === true;
          const state = job.state as
            | { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastError?: string }
            | undefined;

          const payload = job.payload as Record<string, unknown> | undefined;
          const msg = String((payload?.message ?? job.message) || "");
          const sched = job.schedule as { expr?: string } | string | undefined;
          const scheduleExpr = typeof sched === "string" ? sched : typeof sched?.expr === "string" ? sched.expr : null;

          const pid = String(job.pluginJobId ?? "");
          const isHybridMem = pid.startsWith("hybrid-mem:");
          const guardName = name.replace(/\s+/g, "-");
          const lastRunGuardMs = isHybridMem ? readGuardTimestampMs(guardName, openclawDir) : null;

          const canonicalKey = getCanonicalJobKey(name, msg);
          if (canonicalKey) {
            const deprecatedCronTokens = findDeprecatedHybridMemCronTokens(msg).map((t) => t.token);
            allJobs.set(canonicalKey, {
              name,
              pluginJobId: pid || undefined,
              message: msg || undefined,
              enabled,
              featureGateDisabled,
              scheduleExpr,
              lastRunGuardMs,
              isHybridMem,
              deprecatedCronTokens: deprecatedCronTokens.length > 0 ? deprecatedCronTokens : undefined,
              state,
            });
          }
        }
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-job-state" });
    }
  }

  // Issue #1205: hybrid-mem cron jobs can fail in service/cron-like envs when OPENCLAW_HOME or service marker vars leak
  // into the execution shell, preventing plugin CLI metadata discovery ("Unknown command: openclaw hybrid-mem").
  const cronEnvLeakPartial: string[] = [];
  const cronEnvLeakMissing: string[] = [];
  for (const [key, job] of allJobs.entries()) {
    if (!job.isHybridMem || !job.message) continue;
    const status = hybridMemCronMessageSanitizerStatus(job.message);
    if (status === "partial") cronEnvLeakPartial.push(key);
    if (status === "missing") cronEnvLeakMissing.push(key);
  }
  if (cronEnvLeakPartial.length > 0 || cronEnvLeakMissing.length > 0) {
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    const list = [
      cronEnvLeakMissing.length > 0 ? `missing sanitizer: ${cronEnvLeakMissing.join(", ")}` : null,
      cronEnvLeakPartial.length > 0 ? `partial sanitizer: ${cronEnvLeakPartial.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    log(
      `\n${WARN} Cron payload env sanitizer (issue #1205): ${list}. Service/cron environments can leak OPENCLAW_HOME / service marker vars and make \`openclaw hybrid-mem\` unavailable. Fix: run \`openclaw hybrid-mem verify --fix\` to inject a robust sanitizer (unsets OPENCLAW_HOME, OPENCLAW_CLI, OPENCLAW_SERVICE_KIND, OPENCLAW_SERVICE_MARKER, OPENCLAW_SKIP_HYBRID_MEMORY_CLI).`,
    );
    warnings.push(
      `hybrid-mem cron payloads are missing/partial env sanitizer (issue #1205); run 'openclaw hybrid-mem verify --fix'`,
    );
    fixes.push(
      "Run 'openclaw hybrid-mem verify --fix' to update managed cron job messages with an env sanitizer for OPENCLAW_HOME/service markers.",
    );
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
    {
      key: "nightly-dream-cycle",
      description: "dream cycle",
      docsPath: null,
      featureEnabled: cfg.nightlyCycle?.enabled === true,
    },
    {
      key: "sensor-sweep",
      description: "sensor sweep",
      docsPath: null,
      featureEnabled: cfg.sensorSweep?.enabled === true,
    },
  ];

  for (const entry of jobsToDisplay) {
    const { key, description, docsPath } = entry;
    const featureEnabled = (entry as { featureEnabled?: boolean }).featureEnabled;
    const job = allJobs.get(key);

    if (!job) {
      if (featureEnabled === false) {
        log(`  ○ ${key.padEnd(30)} not installed (feature off in config)`);
        continue;
      }
      log(`  ${FAIL} ${key.padEnd(30)} missing`);
      const fixMsg = docsPath
        ? `Optional: Set up ${description} via jobs. See ${docsPath}. Run 'openclaw hybrid-mem verify --fix' to add.`
        : `Optional: Set up ${description} via jobs. Run 'openclaw hybrid-mem verify --fix' to add.`;
      fixes.push(fixMsg);
      continue;
    }

    formatJobStatus(job, key, "  ", log);
  }

  // Truly external jobs: those not in the hybrid-mem canonical list AND not pluginJobId hybrid-mem:*
  const knownKeys = new Set(jobsToDisplay.map((j) => j.key));
  const otherJobs = Array.from(allJobs.entries()).filter(([key, job]) => !knownKeys.has(key) && !job.isHybridMem);

  if (otherJobs.length > 0) {
    log("\n  Other custom jobs (not managed by hybrid-mem):");
    for (const [_key, job] of otherJobs) {
      formatJobStatus(job, job.name, "    ", log);
    }
  }

  // Warn if the stored cron messages or recent exit logs reference deprecated CLI commands/steps.
  const deprecatedCronJobs = Array.from(allJobs.values()).filter(
    (j) => (j.deprecatedCronTokens?.length ?? 0) > 0 && j.featureGateDisabled !== true,
  );
  if (deprecatedCronJobs.length > 0) {
    const affected = deprecatedCronJobs
      .slice(0, 5)
      .map((j) => `${j.pluginJobId ?? j.name} (${(j.deprecatedCronTokens ?? []).join(", ")})`)
      .join("; ");
    warnings.push(
      `cron store contains deprecated hybrid-mem command references: ${affected}${
        deprecatedCronJobs.length > 5 ? `; … (${deprecatedCronJobs.length - 5} more)` : ""
      }`,
    );
    log(
      `\n${WARN_LINE} Stale cron payload detected: job messages reference deprecated command(s)/step(s). Run \`openclaw hybrid-mem verify --fix\` to normalize managed job messages.`,
    );
  }

  // Also scan recent HM_EXIT logs (these can reveal stale commands even when the top-level cron payload looks correct).
  try {
    const logsRoot = join(openclawDir, "logs", "cron-hybrid-mem");
    if (existsSync(logsRoot)) {
      const cutoffMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
      const exitFiles = collectRecentHmExitLedgerPaths(logsRoot, cutoffMs);

      const exitHits: Array<{ file: string; hit: ReturnType<typeof findDeprecatedTokensInHmExitContent>[number] }> = [];
      for (const full of exitFiles) {
        try {
          const content = readFileSync(full, "utf-8");
          const hits = findDeprecatedTokensInHmExitContent(content);
          for (const hit of hits) {
            exitHits.push({ file: full, hit });
            if (exitHits.length >= 5) break;
          }
        } catch {
          /* skip unreadable or partial files */
        }
        if (exitHits.length >= 5) break;
      }

      if (exitHits.length > 0) {
        const sample = exitHits
          .map((h) => `${h.hit.token.token} in ${h.file}${h.hit.iso ? ` @ ${h.hit.iso}` : ""}`)
          .slice(0, 3)
          .join("; ");
        warnings.push(`recent cron-hybrid-mem exit logs reference deprecated step(s): ${sample}`);
        log(
          `${WARN_LINE} Recent maintenance logs reference deprecated command(s)/step(s). This can happen even when cron jobs appear updated. Normalize with \`openclaw hybrid-mem verify --fix\`.`,
        );
      }
    }
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:scan-cron-exit-logs" });
  }

  // Issue #965 — isolated hybrid-mem cron runs must not request a different provider family than
  // agents.defaults.model.primary or OpenClaw may throw LiveSessionModelSwitchError.
  try {
    if (existsSync(defaultConfigPath) && existsSync(cronStorePath)) {
      const root = JSON.parse(readFileSync(defaultConfigPath, "utf-8")) as Record<string, unknown>;
      const agentPrimary = readEffectiveAgentChatPrimaryFromOpenclawJsonRoot(root);
      if (agentPrimary) {
        const agentFam = inferModelProviderPrefix(agentPrimary);
        const rawStore = readFileSync(cronStorePath, "utf-8");
        const store = JSON.parse(rawStore) as { jobs?: unknown[] };
        const jobs = Array.isArray(store.jobs) ? store.jobs : [];
        const WARN = noEmoji ? "[WARN]" : "⚠️";
        for (const j of jobs) {
          if (typeof j !== "object" || j === null) continue;
          const job = j as Record<string, unknown>;
          const pid = String(job.pluginJobId ?? job.id ?? "");
          if (!pid.startsWith("hybrid-mem:")) continue;
          const jobModel = extractCronStoreJobModel(job);
          if (!jobModel) continue;
          const jobFam = inferModelProviderPrefix(jobModel);
          if (jobFam && agentFam && jobFam !== agentFam) {
            log(
              `\n${WARN} Cron vs agent model (issues #963, #965): ${pid} uses "${jobModel}" (${jobFam}) but effective chat primary (agents.list id=main, else agents.defaults.model.primary) is "${agentPrimary}" (${agentFam}). Isolated jobs can fail with LiveSessionModelSwitchError. Align provider families, or run \`openclaw hybrid-mem verify --fix\` after changing the agent default to refresh job models. See docs/SESSION-DISTILLATION.md (Maintenance cron session isolation and model alignment).`,
            );
          }
        }
        const llm = cfg.llm as { _source?: string; default?: string[] } | undefined;
        if (
          llm &&
          llm._source !== "gateway" &&
          Array.isArray(llm.default) &&
          llm.default.length > 0 &&
          typeof llm.default[0] === "string"
        ) {
          const first = llm.default[0];
          if (inferModelProviderPrefix(first) !== agentFam) {
            log(
              `\n${WARN} Plugin llm.default[0] ("${first}") differs from effective chat primary ("${agentPrimary}") by provider family. Consider aligning them so maintenance and chat use consistent routing.`,
            );
          }
        }
      }
    }
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:cron-model-alignment" });
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

  let allOk =
    configOk &&
    sqliteOk &&
    lanceOk &&
    embeddingOk &&
    embeddingAlignmentOk &&
    (!cfg.credentials.enabled || credentialsOk);

  // ───── Reconciliation Check ─────
  if (opts.reconcile) {
    log("\n───── Vector DB Reconciliation ─────");
    if (!sqliteOk || !lanceOk || !vectorDb.isLanceDbAvailable()) {
      log(`${FAIL} Reconciliation skipped — both SQLite and LanceDB must be healthy to reconcile.`);
      allOk = false;
    } else {
      try {
        const reconcilePolicy = opts.reconcilePolicy ?? "balanced";
        const reconcileMaxFixes = Math.max(0, Math.min(5000, opts.reconcileMaxFixes ?? 200));
        const sqliteOrphanRebuildBudget =
          reconcilePolicy === "conservative"
            ? 0
            : reconcilePolicy === "balanced"
              ? reconcileMaxFixes
              : Math.max(reconcileMaxFixes, 2000);
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
            if (opts.fix && sqliteOrphanRebuildBudget > 0) {
              let rebuilt = 0;
              let failed = 0;
              for (const id of sqliteOrphans.slice(0, sqliteOrphanRebuildBudget)) {
                try {
                  const fact = factsDb.getById(id);
                  if (!fact) {
                    failed++;
                    continue;
                  }
                  const vec = await embeddings.embed(fact.text);
                  await vectorDb.store({
                    id: fact.id,
                    text: fact.text,
                    vector: vec,
                    importance: fact.importance ?? 0.5,
                    category: fact.category,
                  });
                  rebuilt++;
                } catch {
                  failed++;
                }
              }
              log(
                `  → Rebuild policy=${reconcilePolicy}: rebuilt ${rebuilt}/${Math.min(sqliteOrphans.length, sqliteOrphanRebuildBudget)} SQLite orphan vector(s)${failed > 0 ? ` (${failed} failed)` : ""}.`,
              );
              if (sqliteOrphans.length > sqliteOrphanRebuildBudget) {
                log(
                  `  → Skipped ${sqliteOrphans.length - sqliteOrphanRebuildBudget} SQLite orphan(s) due to --reconcile-max-fixes budget.`,
                );
              }
            } else if (opts.fix && sqliteOrphanRebuildBudget === 0) {
              log(
                `  → Policy=${reconcilePolicy}: SQLite-orphan auto-rebuild disabled; use re-index for full recovery.`,
              );
            } else {
              log(`  → Re-run the plugin or use the re-index command to rebuild missing vectors.`);
            }
            issues.push(`${sqliteOrphans.length} SQLite fact(s) without corresponding vectors in LanceDB`);
          }
        }
        if (resolvedSqlitePath) {
          appendVectorLifecycleAuditEvent(resolvedSqlitePath, {
            event: "reconcile_completed",
            ts: new Date().toISOString(),
            details: {
              fix: opts.fix,
              reconcilePolicy,
              reconcileMaxFixes,
              vectorOrphans: vectorOrphans.length,
              sqliteOrphans: sqliteOrphans.length,
            },
          });
        }
      } catch (e) {
        log(`${FAIL} Reconciliation: FAIL — ${String(e)}`);
        allOk = false;
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:reconcile" });
      }
    }
  }

  // ───── Cron Ledger Reconciliation (explicit --reconcile only; optional --fix to write) ─────
  if (opts.reconcile) {
    log("\n───── Cron Maintenance Ledger Reconciliation ─────");
    try {
      const cronRunsDir = join(openclawDir, "cron", "runs");
      const logDir = join(openclawDir, "logs", "cron-hybrid-mem");

      if (!existsSync(cronRunsDir)) {
        log(`${PAUSE} Cron runs directory not found: ${cronRunsDir}`);
      } else if (!existsSync(logDir)) {
        log(`${PAUSE} Log directory not found: ${logDir}`);
      } else {
        const result = reconcileAllCronRunLedgers(cronRunsDir, logDir, HYBRID_MEM_CRON_DEFAULT_JOB_STEPS, !opts.fix);

        if (result.examined === 0) {
          log(`${PAUSE} No cron runs found to examine`);
        } else if (result.falseOk === 0) {
          log(`${OK} All ${result.examined} examined run(s) correctly recorded`);
        } else {
          log(`${FAIL} Found ${result.falseOk} false-OK run(s) out of ${result.examined} examined`);
          if (opts.fix) {
            log(`  → Corrected ${result.corrected} ledger entr${result.corrected === 1 ? "y" : "ies"}`);
            fixes.push(
              `Corrected ${result.corrected} false-OK cron run ledger entr${result.corrected === 1 ? "y" : "ies"}`,
            );
          } else {
            log(`  → Run with --fix to correct ledger entries`);
            issues.push(`${result.falseOk} cron run(s) incorrectly recorded as OK despite validation failures`);
            allOk = false;
          }

          if (result.corrections.length > 0 && result.corrections.length <= 5) {
            for (const correction of result.corrections) {
              log(
                `  • ${correction.jobId} @ ${new Date(correction.timestamp).toISOString()}: ${correction.validationResult.error || "validation failed"}`,
              );
            }
          } else if (result.corrections.length > 5) {
            log(
              `  • ${result.corrections.length} corrections (run 'openclaw hybrid-mem reconcile-cron-ledgers' for details)`,
            );
          }
        }
      }
    } catch (e) {
      log(`${FAIL} Cron ledger reconciliation check failed: ${e}`);
      allOk = false;
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:reconcile-cron-ledgers" });
    }
  }

  // Surface overdue / never-run cron jobs as warnings so the summary mentions them even when health checks pass.
  for (const [key, job] of allJobs) {
    if (!job.enabled) continue;
    const lastMs = effectiveCronLastRunMs(job);
    const interval = approxIntervalMs(job.scheduleExpr ?? null);
    if (interval && (lastMs == null || Date.now() - lastMs > interval * 1.5)) {
      warnings.push(
        `cron job ${key} is overdue: last=${lastMs ? new Date(lastMs).toISOString() : "never"}, schedule=${job.scheduleExpr ?? "?"}`,
      );
    }
  }

  if (allOk) {
    if (warnings.length === 0) {
      log("\nAll checks passed.");
    } else {
      log(`\nAll critical checks passed, but ${warnings.length} warning(s):`);
      for (const w of warnings) log(`  ${WARN_LINE} ${w}`);
      log(
        "  Tip: re-run after the next scheduled window. If 'last: never' persists, confirm the OpenClaw gateway is running and that ~/.openclaw/cron/guard/<job>.ms is being written.",
      );
    }
    if (restartPending) {
      process.exitCode = 2;
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
            digestWeeklyDelivery: cfg.digest.weekly.delivery,
          });
          added.forEach((name) => applied.push(`Added ${name} job to ${cronStorePath}`));
          normalized.forEach((name) => applied.push(`Normalized ${name} job (schedule/pluginJobId)`));
          if (cfg.goalStewardship.enabled && cfg.goalStewardship.heartbeatStewardship) {
            const heartbeat = ensureGoalStewardshipHeartbeatCronJob(openclawDir, {
              heartbeatPatterns: cfg.goalStewardship.heartbeatPatterns,
            });
            if (heartbeat.added) {
              applied.push(`Added goal-stewardship-heartbeat job to ${cronStorePath}`);
            }
            if (heartbeat.normalized) {
              applied.push("Normalized goal-stewardship-heartbeat job (schedule/sessionTarget/delivery/payload)");
            }
            if (heartbeat.skippedReason) {
              const WARN = noEmoji ? "[WARN]" : "⚠️";
              log(`${WARN} Goal stewardship heartbeat installer skipped: ${heartbeat.skippedReason}`);
            }
          }
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
