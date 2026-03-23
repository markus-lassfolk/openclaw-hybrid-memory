/** @module init-databases — Provider routing, cost instrumentation, and database bootstrap. */
import { dirname, join } from "node:path";
import { existsSync, readFileSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { resolveSecretRef } from "../config/parsers/core.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { EventLog } from "../backends/event-log.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { HybridMemoryConfig, LLMProviderConfig, CredentialType, ResolvedGatewayAuthConfig } from "../config.js";
import { UnconfiguredProviderError } from "../services/chat.js";
import { hasOAuthProfiles } from "../utils/auth.js";
import {
  isOAuthInBackoff,
  recordOAuthFailure,
  DEFAULT_BACKOFF_MINUTES,
  DEFAULT_RESET_AFTER_HOURS,
} from "../utils/auth-failover.js";
import { setKeywordsPath } from "../utils/language-keywords.js";
import { setMemoryCategories, getMemoryCategories } from "../config.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "../services/credential-migration.js";
import { runEmbeddingMaintenance } from "../services/embedding-migration.js";
import { capturePluginError } from "../services/error-reporter.js";
import { getCurrentCostFeature } from "../services/cost-context.js";
import type { AliasDB } from "../services/retrieval-aliases.js";
import { invalidateClusterCache } from "../services/retrieval-orchestrator.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { ProvenanceService } from "../services/provenance.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { VerificationStore } from "../services/verification-store.js";
import { CostTracker } from "../backends/cost-tracker.js";
import type { ApitapStore } from "../backends/apitap-store.js";
import { isNanoModel, isHeavyModel, isLightModel } from "../utils/model-tier.js";
import { installCoreBootstrapServices, installOptionalBootstrapServices } from "../services/index.js";

/**
 * Provider prefixes that resolveClient() handles natively without explicit llm.providers config.
 * Keep in sync with the built-in provider cases in resolveClient() (setup/resolve-client.ts).
 * If resolveClient adds a new built-in provider, add it here too.
 */
const ROUTABLE_BUILTIN_PROVIDERS = new Set(["google", "openai", "anthropic", "ollama", "openrouter", "minimax"]);

/**
 * Extract gateway configuration from environment and plugin config.
 * Centralized to avoid duplicating this logic across buildMultiProviderOpenAI and initializeDatabases.
 */
function extractGatewayConfig(cfg: HybridMemoryConfig): {
  gatewayPortRaw: string | undefined;
  gatewayPort: number | undefined;
  gatewayAuthResolved: string | undefined;
  gatewayToken: string | undefined;
  gatewayBaseUrl: string | undefined;
} {
  const gatewayPortRaw = process.env.OPENCLAW_GATEWAY_PORT;
  const gatewayPort = gatewayPortRaw ? Number.parseInt(gatewayPortRaw, 10) : undefined;
  const gatewayAuthResolved = (cfg.gateway?.auth as ResolvedGatewayAuthConfig | undefined)?._resolvedToken;
  const gatewayToken = gatewayAuthResolved ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  const gatewayBaseUrl =
    gatewayPort && gatewayPort >= 1 && gatewayPort <= 65535 ? `http://127.0.0.1:${gatewayPort}/v1` : undefined;
  return {
    gatewayPortRaw,
    gatewayPort,
    gatewayAuthResolved,
    gatewayToken,
    gatewayBaseUrl,
  };
}

/** Known provider OpenAI-compatible base URLs. */
const GOOGLE_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
/** Default Ollama server base URL (without /v1 path). */
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
/** How long to cache an Ollama health-check result (positive or negative). */
const OLLAMA_HEALTH_CACHE_TTL_MS = 30_000;
/** Timeout for a single Ollama /api/tags health ping. */
const OLLAMA_HEALTH_TIMEOUT_MS = 2_000;

/**
 * Module-level health cache so repeated calls within the TTL window skip the network round-trip.
 * Shared across plugin reloads in the same process (intentional).
 */
const _ollamaHealthCache = new Map<string, { ok: boolean; ts: number }>();

/**
 * Probe an Ollama server via GET /api/tags (the Ollama health endpoint).
 * Returns true when Ollama is reachable and responsive, false otherwise.
 * Results are cached for OLLAMA_HEALTH_CACHE_TTL_MS to avoid hammering the endpoint.
 */
async function probeOllamaEndpoint(baseUrl: string): Promise<boolean> {
  const now = Date.now();
  const cached = _ollamaHealthCache.get(baseUrl);
  if (cached && now - cached.ts < OLLAMA_HEALTH_CACHE_TTL_MS) return cached.ok;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    const ok = resp.ok;
    _ollamaHealthCache.set(baseUrl, { ok, ts: now });
    return ok;
  } catch {
    _ollamaHealthCache.set(baseUrl, { ok: false, ts: now });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Infer a human-readable feature label for a chat completion call.
 * Checks AsyncLocalStorage first (precise, opt-in via withCostFeature),
 * then falls back to heuristic scanning of message content.
 */
function inferFeatureLabel(body: Record<string, unknown>, _model: string): string {
  // Precise label: caller wrapped in withCostFeature("label", () => ...)
  const explicit = getCurrentCostFeature();
  if (explicit) return explicit;

  // Heuristic: scan message content for known feature fingerprints.
  // Patterns are derived from the ACTUAL prompt templates in prompts/*.txt to ensure matches.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const content = messages
    .map((m: unknown) => String((m as Record<string, unknown>)?.content ?? ""))
    .join(" ")
    .toLowerCase();

  // ── Matches derived from actual prompt templates (prompts/*.txt first lines) ──

  // category-classify.txt / memory-classify.txt: "You are a memory classifier"
  if (content.includes("memory classifier") || content.includes("categorize each fact")) return "auto-classify";
  // category-discovery.txt: "assign a short category label"
  if (content.includes("assign a short category label")) return "auto-classify";

  // query-expansion / HyDE: "hypothetical document"
  if (content.includes("hypothetical document") || content.includes("hypothetical answer")) return "query-expansion";

  // reranking
  if (/\brerank/i.test(content)) return "reranking";

  // reflection.txt: "analyzing a user's interaction history to identify behavioral patterns"
  // reflection-meta.txt: "synthesizing behavioral patterns into higher-level meta-patterns"
  // reflection-rules.txt: "synthesizing behavioral patterns into actionable one-line rules"
  if (
    content.includes("identify behavioral patterns") ||
    content.includes("synthesizing behavioral patterns") ||
    content.includes("interaction history to identify")
  )
    return "reflection";

  // self-correction-analyze.txt: "You are a self-improvement analyst"
  // self-correction-rewrite-tools.txt: "You are an editor for a behavioral instructions file"
  if (
    content.includes("self-improvement analyst") ||
    content.includes("self-correction") ||
    content.includes("behavioral instructions file")
  )
    return "self-correction";

  // reinforcement-analyze.txt: "You are a positive-reinforcement analyst"
  if (content.includes("positive-reinforcement analyst") || content.includes("positive reinforcement analyst"))
    return "reinforcement-extract";

  // analyze-feedback-phrases.txt: "analyzing chat logs to discover how this specific user expresses"
  if (content.includes("implicit") && content.includes("feedback")) return "implicit-feedback";
  if (content.includes("discover how this specific user expresses")) return "implicit-feedback";

  // trajectory-analyze.txt: "You are a trajectory analyst"
  if (content.includes("trajectory analyst")) return "trajectory-analysis";

  // frustration detection: looks for frustration keywords in analysis context
  if (content.includes("frustration") && (content.includes("detect") || content.includes("analys")))
    return "frustration-detection";

  // cross-agent-generalize.txt: "identify which of these lessons are general enough"
  if (content.includes("cross-agent") || content.includes("lessons are general enough")) return "cross-agent-learning";

  // tool effectiveness
  if (content.includes("tool effectiveness") || content.includes("tool scoring")) return "tool-effectiveness";

  // distill-sessions.txt: "You are a fact extraction agent"
  // ingest-files.txt: also "You are a fact extraction agent"
  if (content.includes("fact extraction agent")) return "distill";

  // passive-observer.txt: "extracting facts, preferences, decisions"
  if (content.includes("extracting facts, preferences, decisions")) return "distill";

  // language keywords
  if (content.includes("language") && content.includes("keyword")) return "language-keywords";

  // consolidate.txt: "You are a memory consolidator"
  if (content.includes("memory consolidator") || content.includes("merge the following facts")) return "consolidation";

  // generate-proposals.txt: "generating persona file update proposals"
  if (
    content.includes("persona file update proposals") ||
    (content.includes("persona") && content.includes("proposal"))
  )
    return "persona-proposals";

  // continuous verification
  if (content.includes("continuous") && content.includes("verification")) return "continuous-verification";

  return "unknown";
}
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION_HEADER = "2023-06-01";

/** Built-in OpenAI-compatible base URL for MiniMax API (global endpoint). */
export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/**
 * Canonical MiniMax model name mapping (lowercase key → proper-case value).
 * Covers Ollama-style aliases (e.g. "minimax-m2.5:cloud") that users may configure
 * and that would otherwise produce a 404 from the MiniMax API (issue #400).
 */
const MINIMAX_MODEL_ALIASES: Record<string, string> = {
  "minimax-m2.5": "MiniMax-M2.5",
  "minimax-text-01": "MiniMax-Text-01",
};

/**
 * Canonicalize a bare MiniMax model name.
 * - Strips Ollama-style `:tag` suffixes (e.g. `:cloud`, `:latest`) which are invalid on the MiniMax API.
 * - Looks up the result in MINIMAX_MODEL_ALIASES to restore correct casing (e.g. "minimax-m2.5" → "MiniMax-M2.5").
 * - Falls back to the original bare name (without tag) if no alias matches.
 */
function canonicalizeMiniMaxModelId(bare: string): string {
  // Strip Ollama-style ":tag" suffix (e.g. "minimax-m2.5:cloud" → "minimax-m2.5")
  const withoutTag = bare.includes(":") ? bare.slice(0, bare.indexOf(":")) : bare;
  const canonical = MINIMAX_MODEL_ALIASES[withoutTag.toLowerCase()];
  return canonical ?? withoutTag;
}

/** OpenRouter OpenAI-compatible base URL. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Resolved API key with metadata about which configuration source provided it. */
export type ResolvedApiKey = { value?: string; source: string };

/**
 * Centralised API-key resolver for all built-in and custom providers.
 *
 * Resolves the API key for a named provider using a well-defined precedence chain.
 * Provider-specific exceptions are explicit and documented here, rather than scattered
 * across individual provider branches in `resolveClient`.
 *
 * Precedence table (highest → lowest):
 *
 * | Source                      | google | openai | anthropic | openrouter | minimax | ollama | custom |
 * |-----------------------------|:------:|:------:|:---------:|:----------:|:-------:|:------:|:------:|
 * | llm.providers.X.apiKey      |   ✓    |   ✓    |     ✓     |     ✓      |    ✓    |   ✓    |   ✓    |
 * | distill.apiKey (legacy)     |   ✓    |        |           |            |         |        |        |
 * | gatewayToken                |        |   ✓†   |           |            |         |        |        |
 * | embedding.apiKey            |        |   ✓†   |           |            |         |        |        |
 * | GOOGLE_API_KEY env          |   ✓    |        |           |            |         |        |        |
 * | OPENAI_API_KEY env          |        |   ✓*   |           |            |         |        |        |
 * | AZURE_OPENAI_API_KEY env    |        |        |           |            |         |        |   ✓‡   |
 * | ANTHROPIC_API_KEY env       |        |        |     ✓     |            |         |        |        |
 * | OPENROUTER_API_KEY env      |        |        |           |     ✓      |         |        |        |
 * | MINIMAX_API_KEY env         |        |        |           |            |    ✓    |        |        |
 * | <PREFIX>_API_KEY env        |        |        |           |            |         |        |   ✓    |
 * | "ollama" (no-op default)    |        |        |           |            |         |   ✓    |        |
 *
 * * openai: OPENAI_API_KEY is preferred over embedding.apiKey so Azure and OpenAI keys do not conflict.
 * † openai: `gatewayToken` and `embedding.apiKey` are skipped when `hasCustomExternalBaseURL` is true
 *   (security: never send internal gateway credentials to external endpoints).
 * ‡ azure-foundry / azure-foundry-responses: AZURE_OPENAI_API_KEY env when llm.providers.*.apiKey not set.
 *
 * @param prefix                       Lowercase provider prefix, e.g. "google", "openai".
 * @param providerCfg                  The llm.providers[prefix] config object, if present.
 * @param cfg                          Full plugin config.
 * @param resolveKey                   SecretRef resolver (env:VAR / file:// / ${VAR}).
 * @param opts.gatewayToken            Resolved gateway auth token (openai only).
 * @param opts.hasCustomExternalBaseURL  True when openai uses a non-gateway baseURL.
 * @param opts.env                     Process environment (injectable for tests; defaults to process.env).
 */
export function resolveProviderApiKey(
  prefix: string,
  providerCfg: LLMProviderConfig | undefined,
  cfg: HybridMemoryConfig,
  resolveKey: (key: string | undefined) => string | undefined,
  opts: {
    gatewayToken?: string;
    hasCustomExternalBaseURL?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): ResolvedApiKey {
  const { gatewayToken, hasCustomExternalBaseURL = false, env = process.env } = opts;

  // Highest priority: explicit per-provider key in llm.providers config (all providers).
  const fromProviderCfg = resolveKey(providerCfg?.apiKey);
  if (fromProviderCfg) return { value: fromProviderCfg, source: `llm.providers.${prefix}.apiKey` };

  if (prefix === "google") {
    // Legacy fallback: distill.apiKey doubles as the Google API key for distillation.
    const fromDistill = resolveKey(cfg.distill?.apiKey);
    if (fromDistill) return { value: fromDistill, source: "distill.apiKey" };
    const fromEnv = env.GOOGLE_API_KEY?.trim() || undefined;
    if (fromEnv) return { value: fromEnv, source: "GOOGLE_API_KEY" };
    return { source: "none" };
  }

  if (prefix === "openai") {
    // Prefer OPENAI_API_KEY over embedding.apiKey so Azure (embedding) and OpenAI (chat) can use different keys.
    const fromEnv = env.OPENAI_API_KEY?.trim() || undefined;
    if (fromEnv) return { value: fromEnv, source: "OPENAI_API_KEY" };
    // Security: never send gateway/embedding credentials to an arbitrary external endpoint.
    if (!hasCustomExternalBaseURL) {
      if (gatewayToken) return { value: gatewayToken, source: "gatewayToken" };
      const fromEmbedding = resolveKey(cfg.embedding?.apiKey);
      if (fromEmbedding) return { value: fromEmbedding, source: "embedding.apiKey" };
    }
    return { source: "none" };
  }

  // Azure Foundry (and Responses) use AZURE_OPENAI_API_KEY so it does not conflict with OPENAI_API_KEY.
  if (prefix === "azure-foundry" || prefix === "azure-foundry-responses") {
    const fromEnv = env.AZURE_OPENAI_API_KEY?.trim() || undefined;
    if (fromEnv) return { value: fromEnv, source: "AZURE_OPENAI_API_KEY" };
    return { source: "none" };
  }

  if (prefix === "anthropic") {
    const fromEnv = env.ANTHROPIC_API_KEY?.trim() || undefined;
    if (fromEnv) return { value: fromEnv, source: "ANTHROPIC_API_KEY" };
    return { source: "none" };
  }

  if (prefix === "openrouter") {
    const fromEnv = env.OPENROUTER_API_KEY?.trim() || undefined;
    if (fromEnv) return { value: fromEnv, source: "OPENROUTER_API_KEY" };
    return { source: "none" };
  }

  if (prefix === "minimax") {
    const fromEnv = env.MINIMAX_API_KEY?.trim() || undefined;
    if (fromEnv) return { value: fromEnv, source: "MINIMAX_API_KEY" };
    return { source: "none" };
  }

  if (prefix === "ollama") {
    // Ollama's OpenAI-compatible endpoint accepts any non-empty string as the API key.
    return { value: "ollama", source: "default" };
  }

  // Generic env fallback: <PREFIX>_API_KEY (covers any provider following this convention).
  // NOTE: the gateway token is intentionally excluded — it is scoped to the local gateway
  // and must never be sent to arbitrary external endpoints.
  const fromGenericEnv = env[`${prefix.toUpperCase()}_API_KEY`]?.trim();
  if (fromGenericEnv) return { value: fromGenericEnv, source: `${prefix.toUpperCase()}_API_KEY` };

  return { source: "none" };
}

/**
 * Builds a multi-provider OpenAI-compatible proxy that routes each model to the correct provider API.
 * All existing call sites use `openai.chat.completions.create({ model, ... })` unchanged — this
 * proxy intercepts those calls and selects the right API endpoint + key based on the model prefix.
 *
 * Routing:
 *  - `google/*`  → Google Gemini OpenAI-compat endpoint (distill.apiKey or llm.providers.google.apiKey)
 *  - `openai/*` or bare model (no `/`) → OpenAI (embedding.apiKey or llm.providers.openai.apiKey)
 *  - `ollama/*` → local Ollama server (http://127.0.0.1:11434/v1, or llm.providers.ollama.baseURL)
 *  - Other `provider/*` with explicit llm.providers config → custom endpoint
 *  - Unknown provider, no config → throws UnconfiguredProviderError
 */
function buildMultiProviderOpenAI(
  cfg: HybridMemoryConfig,
  api: ClawdbotPluginApi,
  costTracker: CostTracker | null,
  authBackoffStatePath?: string,
): OpenAI {
  const clientCache = new Map<string, OpenAI>();
  /** Resolve env:VAR / file:/path / ${VAR} SecretRef strings so all llm.providers keys work with SecretRef format (Issue #344).
   *  Delegates to the shared resolveSecretRef helper from config/parsers/core.ts to avoid duplicated logic. */
  const resolveApiKey = (key: string | undefined): string | undefined => {
    // Reject undefined, null, and whitespace-only strings before reaching resolveSecretRef (issues #10, #11).
    if (!key?.trim()) return undefined;
    return resolveSecretRef(key);
  };
  const { gatewayPortRaw, gatewayPort, gatewayAuthResolved, gatewayToken, gatewayBaseUrl } = extractGatewayConfig(cfg);
  // Fail closed: if gateway.auth.token is configured but cannot be resolved, throw rather than
  // silently falling back to OPENCLAW_GATEWAY_TOKEN — a stale env token would mask rollout mistakes.
  if (cfg.gateway?.auth?.token && !gatewayAuthResolved) {
    throw new Error(
      `memory-hybrid: gateway.auth.token is configured (SecretRef "${cfg.gateway.auth.token}") but could not be resolved. Ensure the referenced env var or file is accessible, or remove gateway.auth.token from the plugin config. Not falling back to OPENCLAW_GATEWAY_TOKEN to prevent silent auth misconfiguration.`,
    );
  }
  if (gatewayPortRaw && (!gatewayPort || gatewayPort < 1 || gatewayPort > 65535)) {
    api.logger.warn?.(
      `memory-hybrid: OPENCLAW_GATEWAY_PORT must be 1-65535 (got '${gatewayPortRaw}'); falling back to direct OpenAI.`,
    );
  }
  if (gatewayBaseUrl && !gatewayToken) {
    api.logger.warn?.(
      "memory-hybrid: OPENCLAW_GATEWAY_PORT set but no gateway auth token found; set gateway.auth.token (SecretRef) in plugin config or OPENCLAW_GATEWAY_TOKEN env var. Gateway calls may fail if auth is required.",
    );
  }

  function getOrCreate(key: string, factory: () => OpenAI): OpenAI {
    if (!clientCache.has(key)) clientCache.set(key, factory());
    return clientCache.get(key)!;
  }

  function defaultOpenAIClient(): OpenAI {
    if (gatewayBaseUrl) {
      const key = gatewayToken ?? cfg.embedding.apiKey;
      if (!key) throw new UnconfiguredProviderError("openai", "openai/*");
      return getOrCreate(
        `openai:gateway:${gatewayBaseUrl}`,
        () =>
          new OpenAI({
            apiKey: key,
            baseURL: gatewayBaseUrl,
          }),
      );
    }
    if (!cfg.embedding.apiKey) throw new UnconfiguredProviderError("openai", "openai/*");
    return getOrCreate("openai:default", () => new OpenAI({ apiKey: cfg.embedding.apiKey! }));
  }

  /**
   * Normalize bare model names (no "provider/" prefix) to "provider/model" so the correct API is used.
   * OpenClaw and some configs use bare names (e.g. gemini-3.1-pro-preview); without the prefix we
   * would route to the default OpenAI client and get 404.
   */
  function normalizeModelId(model: string): string {
    const trimmed = model.trim();
    if (trimmed.includes("/")) return trimmed;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("gemini-")) return `google/${trimmed}`;
    if (lower.startsWith("claude-")) return `anthropic/${trimmed}`;
    if (lower.startsWith("gpt-") || /^o[0-9]+/.test(lower)) return `openai/${trimmed}`;
    if (lower.startsWith("minimax-")) return `minimax/${canonicalizeMiniMaxModelId(trimmed)}`;
    return trimmed;
  }

  /**
   * Canonicalize model id for cost logging so pricing table lookup and reports use the correct provider.
   * Gateways may pass e.g. openai/gemini-3.1-pro-preview; we store google/gemini-3.1-pro-preview.
   */
  function canonicalModelIdForCost(providerSlashModel: string): string {
    const trimmed = providerSlashModel.trim();
    const slashIdx = trimmed.indexOf("/");
    const bare = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
    const lower = bare.toLowerCase();
    if (lower.startsWith("gemini-")) return `google/${bare}`;
    if (lower.startsWith("claude-")) return `anthropic/${bare}`;
    if (lower.startsWith("gpt-") || /^o[0-9]+/.test(lower)) return `openai/${bare}`;
    if (lower.startsWith("minimax-")) return `minimax/${canonicalizeMiniMaxModelId(bare)}`;
    return trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
  }

  /** The configured auth.order map from plugin config (issue #311). */
  const authOrder = cfg.auth?.order;
  const preferOAuthWhenBoth = cfg.auth?.preferOAuthWhenBoth !== false;
  const failoverOpts = authBackoffStatePath
    ? {
        statePath: authBackoffStatePath,
        backoffScheduleMinutes: cfg.auth?.backoffScheduleMinutes?.length
          ? cfg.auth.backoffScheduleMinutes
          : DEFAULT_BACKOFF_MINUTES,
        resetBackoffAfterHours: cfg.auth?.resetBackoffAfterHours ?? DEFAULT_RESET_AFTER_HOURS,
      }
    : undefined;

  function hasApiKeyForProvider(prefix: string): boolean {
    const providerCfg: LLMProviderConfig | undefined = (
      cfg.llm?.providers as Record<string, LLMProviderConfig | undefined> | undefined
    )?.[prefix];
    const hasCustomExternalBaseURL =
      prefix === "openai" && Boolean(providerCfg?.baseURL && providerCfg.baseURL !== gatewayBaseUrl);
    // Exclude gatewayToken from the check for OAuth routing decisions — we only want to detect
    // a real direct API key (llm.providers.X.apiKey, embedding.apiKey, or env var).
    const { value } = resolveProviderApiKey(prefix, providerCfg, cfg, resolveApiKey, {
      gatewayToken: undefined,
      hasCustomExternalBaseURL,
    });
    return Boolean(value && value.length >= 10);
  }

  function resolveClient(model: string): {
    client: OpenAI;
    bareModel: string;
    ollamaBaseUrl?: string;
    useFullModel?: boolean;
    authType?: "oauth";
  } {
    const normalized = normalizeModelId(model);
    const trimmed = normalized.trim();
    const slashIdx = trimmed.indexOf("/");

    if (slashIdx <= 0) {
      return { client: defaultOpenAIClient(), bareModel: trimmed };
    }

    const prefix = trimmed.slice(0, slashIdx).toLowerCase();
    const bareModel = trimmed.slice(slashIdx + 1);
    const providerCfg: LLMProviderConfig | undefined = (
      cfg.llm?.providers as Record<string, LLMProviderConfig | undefined> | undefined
    )?.[prefix];

    // OAuth + optional failover: when both OAuth and API key exist, prefer OAuth unless in backoff.
    if (hasOAuthProfiles(authOrder?.[prefix], prefix) && gatewayBaseUrl && gatewayToken) {
      const hasApi = hasApiKeyForProvider(prefix);
      const useOAuth = !hasApi || (preferOAuthWhenBoth && (!failoverOpts || !isOAuthInBackoff(prefix, failoverOpts)));
      if (useOAuth) {
        return {
          client: getOrCreate(
            `gateway:oauth:${gatewayBaseUrl}:${prefix}`,
            () => new OpenAI({ apiKey: gatewayToken, baseURL: gatewayBaseUrl }),
          ),
          bareModel,
          useFullModel: true,
          authType: "oauth",
        };
      }
      // Fall through to use API client (OAuth in backoff or preferOAuthWhenBoth false).
    }

    if (prefix === "google") {
      const { value: apiKey } = resolveProviderApiKey("google", providerCfg, cfg, resolveApiKey);
      if (!apiKey) throw new UnconfiguredProviderError("google", trimmed);
      const baseURL = providerCfg?.baseURL ?? GOOGLE_GEMINI_BASE_URL;
      return {
        client: getOrCreate(`google:${baseURL}`, () => new OpenAI({ apiKey, baseURL })),
        bareModel,
      };
    }

    if (prefix === "openai") {
      // Only use the gateway token when routing through the local gateway.
      // If a custom external baseURL is configured for the openai provider,
      // do NOT fall back to gatewayToken — that would send the internal gateway
      // token to an arbitrary external endpoint (security issue).
      const hasCustomExternalBaseURL = Boolean(providerCfg?.baseURL && providerCfg.baseURL !== gatewayBaseUrl);
      const { value: apiKey } = resolveProviderApiKey("openai", providerCfg, cfg, resolveApiKey, {
        gatewayToken,
        hasCustomExternalBaseURL,
      });
      if (!apiKey) throw new UnconfiguredProviderError("openai", trimmed);
      const baseURL = providerCfg?.baseURL ?? gatewayBaseUrl;
      const cacheKey = `openai:prefixed:${apiKey.slice(0, 8)}:${baseURL ?? "default"}`;
      return {
        client: getOrCreate(cacheKey, () => new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })),
        bareModel,
      };
    }

    if (prefix === "anthropic") {
      const { value: apiKey } = resolveProviderApiKey("anthropic", providerCfg, cfg, resolveApiKey);
      if (!apiKey) throw new UnconfiguredProviderError("anthropic", trimmed);
      const baseURL = providerCfg?.baseURL ?? ANTHROPIC_BASE_URL;
      // Anthropic's OpenAI-compatible endpoints require anthropic-version header
      return {
        client: getOrCreate(
          `anthropic:${baseURL}`,
          () =>
            new OpenAI({
              apiKey,
              baseURL,
              defaultHeaders: { "anthropic-version": ANTHROPIC_VERSION_HEADER },
            }),
        ),
        bareModel,
      };
    }

    if (prefix === "ollama") {
      // Ollama exposes an OpenAI-compatible API at /v1. No real API key is required.
      let baseURL = providerCfg?.baseURL ?? `${OLLAMA_DEFAULT_BASE_URL}/v1`;
      // Ensure baseURL ends with /v1 for OpenAI client
      if (!/\/v1\/?$/.test(baseURL)) {
        baseURL = `${baseURL.replace(/\/$/, "")}/v1`;
      }
      // Strip /v1 suffix for the health-check base URL
      const ollamaBaseUrl = baseURL.replace(/\/v1\/?$/, "");
      const { value: apiKey } = resolveProviderApiKey("ollama", providerCfg, cfg, resolveApiKey);
      const cacheKey = `ollama:${baseURL}`;
      return {
        client: getOrCreate(cacheKey, () => new OpenAI({ apiKey: apiKey ?? "ollama", baseURL })),
        bareModel,
        ollamaBaseUrl,
      };
    }

    if (prefix === "openrouter") {
      // OpenRouter exposes an OpenAI-compatible API at https://openrouter.ai/api/v1.
      // Model names are passed as-is after stripping the "openrouter/" prefix
      // (e.g. "openrouter/anthropic/claude-3.5-sonnet" → bareModel "anthropic/claude-3.5-sonnet").
      const { value: apiKey } = resolveProviderApiKey("openrouter", providerCfg, cfg, resolveApiKey);
      if (!apiKey) throw new UnconfiguredProviderError("openrouter", trimmed);
      const baseURL = providerCfg?.baseURL ?? OPENROUTER_BASE_URL;
      // Include apiKey prefix in cache key so key rotation takes effect without restart.
      // defaultHeaders follow OpenRouter's recommendations for attribution and rate-limit priority.
      const cacheKey = `openrouter:${baseURL}:${apiKey.slice(0, 8)}`;
      return {
        client: getOrCreate(
          cacheKey,
          () =>
            new OpenAI({
              apiKey,
              baseURL,
              defaultHeaders: {
                "HTTP-Referer": "https://github.com/markus-lassfolk/openclaw-hybrid-memory",
                "X-Title": "openclaw-hybrid-memory",
              },
            }),
        ),
        bareModel,
      };
    }

    if (prefix === "minimax") {
      // Use the built-in MiniMax API endpoint as default so callers never accidentally
      // fall through to the default OpenAI client (which returns 404 for MiniMax models).
      const { value: apiKey } = resolveProviderApiKey("minimax", providerCfg, cfg, resolveApiKey);
      if (!apiKey) throw new UnconfiguredProviderError("minimax", trimmed);
      const baseURL = providerCfg?.baseURL ?? MINIMAX_BASE_URL;
      // Canonicalize the bare model name: strip Ollama-style ":tag" suffixes and fix casing
      // so that e.g. "minimax-m2.5:cloud" → "MiniMax-M2.5" (issue #400).
      const canonicalBareModel = canonicalizeMiniMaxModelId(bareModel);
      return {
        client: getOrCreate(`minimax:${baseURL}`, () => new OpenAI({ apiKey, baseURL })),
        bareModel: canonicalBareModel,
      };
    }

    // For all remaining providers (custom configs and unknown providers), use the centralised
    // resolver which covers llm.providers[prefix].apiKey and the <PREFIX>_API_KEY env convention.
    // The gateway token is intentionally excluded — it is scoped to the local gateway and must
    // never be sent to arbitrary external endpoints.
    const { value: resolvedApiKey } = resolveProviderApiKey(prefix, providerCfg, cfg, resolveApiKey);
    if (providerCfg?.baseURL || resolvedApiKey) {
      // apiKey may be absent when the provider only needs a custom baseURL (some self-hosted servers)
      const apiKey = resolvedApiKey ?? "no-key";
      const baseURL = providerCfg?.baseURL;
      // Azure OpenAI / Foundry expect the key in the api-key header for reliable auth.
      const isAzure =
        typeof baseURL === "string" &&
        /\.openai\.azure\.com\/|\.cognitiveservices\.azure\.com\/|\.services\.ai\.azure\.com\//i.test(baseURL);
      const clientOpts: { apiKey: string; baseURL?: string; defaultHeaders?: Record<string, string> } = {
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      };
      if (isAzure && apiKey !== "no-key") clientOpts.defaultHeaders = { "api-key": apiKey };
      const cacheKey = `custom:${prefix}:${apiKey.slice(0, 8)}:${baseURL ?? "default"}`;
      return {
        client: getOrCreate(cacheKey, () => new OpenAI(clientOpts)),
        bareModel,
      };
    }

    // Unknown provider with no config — throw so callers can skip to the next model cleanly
    throw new UnconfiguredProviderError(prefix, trimmed);
  }

  /** o1, o3, o4-mini, o3-pro, etc. — reasoning models that reject temperature/top_p params */
  const isReasoningModel = (bare: string) => /^o[0-9]+(?:-[a-z]+)?$/.test(bare.toLowerCase());
  const requiresMaxCompletionTokens = (bare: string) => isReasoningModel(bare) || /^gpt-5/i.test(bare);

  /**
   * Newer OpenAI models (o-series, gpt-5+) use `max_completion_tokens` instead of `max_tokens`.
   * Reasoning models (o1, o3, o4-*) also reject temperature/top_p — strip those params.
   */
  function remapMaxTokensForOpenAI(body: Record<string, unknown>, bareModel: string): Record<string, unknown> {
    let result = body;
    if (requiresMaxCompletionTokens(bareModel) && "max_tokens" in result && !("max_completion_tokens" in result)) {
      const { max_tokens, ...rest } = result;
      result = { ...rest, max_completion_tokens: max_tokens };
    }
    if (isReasoningModel(bareModel)) {
      // Reasoning models only accept temperature=1 (the default); strip to avoid 400
      const { temperature, top_p, ...rest } = result as Record<string, unknown> & {
        temperature?: unknown;
        top_p?: unknown;
      };
      if (temperature !== undefined || top_p !== undefined) {
        api.logger.debug?.(`memory-hybrid: stripped temperature/top_p for reasoning model ${bareModel}`);
      }
      result = rest;
    }
    return result;
  }

  // Proxy that intercepts chat.completions.create and routes to the right provider client.
  // All other OpenAI methods (embeddings, etc.) are NOT proxied — embeddings use a separate client.
  // The proxy base is only accessed for non-chat methods (not used by this plugin directly).
  // Only create it with a real key when one is available; otherwise omit to avoid "unused" placeholder.
  const proxyBaseKey = cfg.embedding.apiKey ?? gatewayToken ?? "";
  const proxyBase: OpenAI = proxyBaseKey ? new OpenAI({ apiKey: proxyBaseKey }) : ({} as OpenAI);
  return new Proxy(proxyBase, {
    get(target, prop, receiver) {
      if (prop === "chat") {
        return {
          completions: {
            create(
              body: Parameters<OpenAI["chat"]["completions"]["create"]>[0],
              opts?: Parameters<OpenAI["chat"]["completions"]["create"]>[1],
            ) {
              const rawModel: string = (body as { model?: string }).model ?? "";
              const model = normalizeModelId(rawModel);
              const { client, bareModel, ollamaBaseUrl, useFullModel, authType } = resolveClient(model);
              const prefix = model.trim().split("/")[0]?.toLowerCase();
              const isOpenAI = prefix === "openai" || !model.includes("/");
              // When gateway-routed for non-OpenAI providers (auth.order OAuth), send the full "provider/model"
              // name so the gateway can route to the correct provider using the configured auth profile.
              const modelForRequest = useFullModel ? model.trim() : bareModel;
              const adjustedBody = isOpenAI
                ? remapMaxTokensForOpenAI({ ...(body as object), model: modelForRequest }, bareModel)
                : { ...(body as object), model: modelForRequest };
              const start = Date.now();
              // For Ollama models, probe the local server before attempting the call so we fall
              // through to the next tier model quickly instead of waiting for a TCP timeout.
              const makeCall = () =>
                client.chat.completions.create(
                  adjustedBody as unknown as Parameters<OpenAI["chat"]["completions"]["create"]>[0],
                  opts,
                );
              let promise: ReturnType<typeof makeCall> = ollamaBaseUrl
                ? ((async () => {
                    const available = await probeOllamaEndpoint(ollamaBaseUrl);
                    if (!available) {
                      const err = Object.assign(
                        new Error(`Ollama not available at ${ollamaBaseUrl} (ECONNREFUSED) — try next model`),
                        { code: "ECONNREFUSED" },
                      );
                      throw err;
                    }
                    return makeCall();
                  })() as ReturnType<typeof makeCall>)
                : makeCall();
              if (authType === "oauth" && failoverOpts) {
                promise = promise.catch((err: unknown) => {
                  recordOAuthFailure(prefix, failoverOpts);
                  throw err;
                }) as ReturnType<typeof makeCall>;
              }
              // Fire-and-forget cost tracking — never blocks or modifies the returned promise
              if (costTracker) {
                const feature = inferFeatureLabel(body as unknown as Record<string, unknown>, model);
                // Canonicalize so mis-prefixed names (e.g. openai/gemini-*) are stored with correct provider for pricing
                const normalizedModel = canonicalModelIdForCost(model.includes("/") ? model : `openai/${model.trim()}`);
                void (Promise.resolve(promise) as Promise<unknown>).then(
                  (resp: unknown) => {
                    try {
                      const durationMs = Date.now() - start;
                      const r = resp as {
                        usage?: {
                          prompt_tokens?: number;
                          completion_tokens?: number;
                        };
                      } | null;
                      costTracker.record({
                        feature,
                        model: normalizedModel,
                        inputTokens: r?.usage?.prompt_tokens ?? 0,
                        outputTokens: r?.usage?.completion_tokens ?? 0,
                        durationMs,
                        success: true,
                      });
                    } catch {
                      /* never let tracking break LLM calls */
                    }
                  },
                  () => {
                    try {
                      const durationMs = Date.now() - start;
                      // Estimate input tokens from request messages (actual count unavailable on failure)
                      const reqMessages = Array.isArray((body as unknown as Record<string, unknown>).messages)
                        ? ((body as unknown as Record<string, unknown>).messages as unknown[])
                        : [];
                      const estimatedInputTokens = Math.ceil(JSON.stringify(reqMessages).length / 4);
                      costTracker.record({
                        feature,
                        model: normalizedModel,
                        inputTokens: estimatedInputTokens,
                        outputTokens: 0,
                        durationMs,
                        success: false,
                      });
                    } catch {
                      /* never let tracking break LLM calls */
                    }
                  },
                );
              }
              return promise;
            },
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as OpenAI;
}

export interface HealthStatus {
  embeddingsOk: boolean;
  credentialsVaultOk: boolean;
  lastCheckTime: number;
}

export interface DatabaseContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  embeddingRegistry: EmbeddingRegistry;
  openai: OpenAI;
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  eventLog: EventLog | null;
  narrativesDb: NarrativesDB;
  aliasDb: AliasDB | null;
  issueStore: IssueStore;
  workflowStore: WorkflowStore;
  crystallizationStore: CrystallizationStore;
  toolProposalStore: ToolProposalStore;
  verificationStore: VerificationStore | null;
  provenanceService: ProvenanceService | null;
  costTracker: CostTracker | null;
  resolvedLancePath: string;
  resolvedSqlitePath: string;
  health: HealthStatus;
  initialized: Promise<void>;
  apitapStore: ApitapStore;
}

/**
 * Initializes all databases and services for the plugin.
 *
 * This includes:
 * - FactsDB (SQLite)
 * - VectorDB (LanceDB)
 * - Embeddings service
 * - OpenAI client
 * - CredentialsDB (optional)
 * - WriteAheadLog (optional)
 * - ProposalsDB (optional)
 * - Discovered categories loading
 * - Async verification checks
 */
export function initializeDatabases(cfg: HybridMemoryConfig, api: ClawdbotPluginApi): DatabaseContext {
  const resolvedLancePath = api.resolvePath(cfg.lanceDbPath);
  const resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
  setKeywordsPath(dirname(resolvedSqlitePath));

  const { factsDb, vectorDb, embeddings, embeddingRegistry } = installCoreBootstrapServices({
    cfg,
    api,
    resolvedSqlitePath,
    resolvedLancePath,
  });

  // Merge gateway provider keys into plugin llm.providers BEFORE auto-derivation so canRoute
  // can see all available providers (issue #487 fix).
  // Check three paths: models.providers (standard), llm.providers (legacy), providers (top-level).
  const gwConfig = api.config as Record<string, unknown> | undefined;
  const gwProviders =
    (gwConfig?.models as Record<string, unknown> | undefined)?.providers ??
    (gwConfig?.llm as Record<string, unknown> | undefined)?.providers ??
    (gwConfig?.providers as Record<string, unknown> | undefined);
  const mergedProviderNames: string[] = [];
  const mergedProviderOriginalNames = new Map<string, string>();
  if (!cfg.llm)
    (cfg as Record<string, unknown>).llm = {
      providers: {},
      default: [],
      heavy: [],
      nano: [],
    };
  const plm = cfg.llm as Record<string, unknown>;
  if (!plm.providers || typeof plm.providers !== "object") plm.providers = {};
  const prov = plm.providers as Record<string, Record<string, unknown>>;

  if (gwProviders && typeof gwProviders === "object" && !Array.isArray(gwProviders)) {
    for (const [name, gw] of Object.entries(gwProviders)) {
      if (!name || !gw || typeof gw !== "object") continue;
      const rawKey = (gw as Record<string, unknown>).apiKey ?? (gw as Record<string, unknown>).api_key;
      if (typeof rawKey !== "string" || !rawKey.trim()) continue;
      // Normalize provider name to lowercase to match canRoute's case-insensitive lookup (issue #487 fix).
      const normalizedName = name.toLowerCase();
      // Merge if: (a) no plugin entry exists, or (b) plugin entry has no apiKey — allows gateway key
      // to fill in when plugin config has a placeholder/empty key for this provider (issue #386).
      const pluginHasKey =
        typeof prov[normalizedName]?.apiKey === "string" && (prov[normalizedName].apiKey as string).trim().length > 0;
      if (!prov[normalizedName] || !pluginHasKey) {
        prov[normalizedName] = {
          ...prov[normalizedName],
          apiKey: rawKey.trim(),
          baseURL:
            prov[normalizedName]?.baseURL ??
            (gw as Record<string, unknown>).baseURL ??
            (gw as Record<string, unknown>).base_url ??
            (gw as Record<string, unknown>).baseUrl,
        };
        mergedProviderNames.push(normalizedName);
        mergedProviderOriginalNames.set(normalizedName, name);
        api.logger.info?.(
          `memory-hybrid: using gateway provider "${name}" for llm.providers (add ${normalizedName}/<model> to llm.default or llm.heavy to use)`,
        );
      } else {
        // Plugin already has a key for this provider; still merge baseURL from gateway if plugin has none
        // (OpenClaw config often uses camelCase baseUrl; plugin expects baseURL).
        const gwBase =
          (gw as Record<string, unknown>).baseURL ??
          (gw as Record<string, unknown>).base_url ??
          (gw as Record<string, unknown>).baseUrl;
        if (typeof gwBase === "string" && gwBase.trim() && !prov[normalizedName]?.baseURL) {
          prov[normalizedName] = { ...prov[normalizedName], baseURL: gwBase.trim() };
        }
        mergedProviderNames.push(normalizedName);
        mergedProviderOriginalNames.set(normalizedName, name);
      }
    }
  }

  // When llm.default/heavy are not explicitly configured, auto-derive from agents.defaults.model
  // (the same model list shown by `openclaw models list`). This makes the plugin zero-config for
  // model selection when the user has already set up their models in openclaw.json.
  // If the gateway list is heavy-only (e.g. only Opus), we prepend a cheap fallback so default/nano
  // tasks don't all use the expensive model (see cost issue: hundreds of tasks running as Opus).
  const RECOMMENDED_CHEAP_FALLBACK = [
    "openai/gpt-4.1-nano",
    "google/gemini-2.5-flash-lite",
    "anthropic/claude-3-5-haiku",
  ];
  if (
    (cfg.llm?.default ?? []).length === 0 &&
    (cfg.llm?.heavy ?? []).length === 0 &&
    (cfg.llm?.nano ?? []).length === 0
  ) {
    const agentModel = (api.config as Record<string, unknown>)?.agents as Record<string, unknown> | undefined;
    const agentDefaults = agentModel?.defaults as Record<string, unknown> | undefined;
    const modelCfg = agentDefaults?.model as Record<string, unknown> | undefined;
    const primary = typeof modelCfg?.primary === "string" ? modelCfg.primary : undefined;
    const fallbacks = Array.isArray(modelCfg?.fallbacks)
      ? (modelCfg.fallbacks as unknown[]).filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : [];
    // Models from agents.defaults.model with an unknown provider prefix (e.g. "Local/S", "custom/X")
    // would throw UnconfiguredProviderError when used, so filter them out here (issue #487).
    // Normalize provider keys to lowercase to match the lowercased prefix check at line 831 (issue #487 fix).
    const pluginProviders = Object.fromEntries(
      Object.entries((cfg.llm?.providers ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    // Extract gateway config for OAuth routing check (matches buildMultiProviderOpenAI logic)
    const { gatewayBaseUrl, gatewayToken } = extractGatewayConfig(cfg);
    // Normalize auth.order keys to lowercase so lookups match the lowercased prefix.
    const authOrder = cfg.auth?.order
      ? Object.fromEntries(Object.entries(cfg.auth.order).map(([k, v]) => [k.toLowerCase(), v]))
      : undefined;
    const canRoute = (m: string): boolean => {
      if (!m.includes("/")) return true; // bare name — normalizeModelId() may rewrite to a prefixed form (e.g. gemini-*, claude-*, MiniMax-*)
      const prefix = m.trim().split("/")[0].toLowerCase();
      // Check OAuth routing first (matches resolveClient logic at line 378)
      if (hasOAuthProfiles(authOrder?.[prefix], prefix) && gatewayBaseUrl && gatewayToken) return true;
      if (ROUTABLE_BUILTIN_PROVIDERS.has(prefix) || Object.hasOwn(pluginProviders, prefix)) return true;
      // Read-only env var check: safe even with user-supplied prefix since we only read env vars.
      // Mirrors resolveClient()'s <PREFIX>_API_KEY fallback (see resolveClient in setup/resolve-client.ts).
      const envKey = process.env[`${prefix.toUpperCase()}_API_KEY`];
      return Boolean(envKey?.trim());
    };
    const gatewayModels = [primary, ...fallbacks]
      .filter((m): m is string => Boolean(m))
      .filter((m) => {
        if (canRoute(m)) return true;
        const prefix = m.trim().split("/")[0];
        api.logger.warn?.(
          `memory-hybrid: skipping gateway model "${m}" from agents.defaults.model — ` +
            `provider "${prefix}" is not a known built-in and is not configured in llm.providers. ` +
            `To use this model configure llm.providers.${prefix.toLowerCase()} (apiKey and/or baseURL) in plugin config.`,
        );
        return false;
      });

    if (gatewayModels.length === 0 && [primary, ...fallbacks].some(Boolean)) {
      api.logger.warn?.(
        "memory-hybrid: all models from agents.defaults.model were filtered out (unknown provider prefixes). " +
          "No LLM tiers auto-configured. Set llm.default explicitly or add provider entries to llm.providers.",
      );
    }

    if (gatewayModels.length > 0) {
      // Deduplicate while preserving order
      const seen = new Set<string>();
      const uniqueModels = gatewayModels.filter((m) => {
        if (seen.has(m)) return false;
        seen.add(m);
        return true;
      });

      // Heuristic tier split based on model name keywords.
      // Nano:   nano, mini, haiku, lite, turbo-mini  — ultra-cheap for classify/HyDE/summarize
      // Heavy:  pro, opus, o3, o1, large, ultra, gpt-5  — capable/expensive models (incl. GPT-5.4, Codex)
      // Light:  flash, small                           — fast/cheap (but not nano-cheap)
      // Medium: everything else (sonnet, gpt-4o, etc.)
      // All ollama/* models are nano-tier (local = free, no API cost)
      const nano = uniqueModels.filter((m) => isNanoModel(m) && !isHeavyModel(m));
      const heavy = uniqueModels.filter((m) => isHeavyModel(m) && !isNanoModel(m));
      const light = uniqueModels.filter((m) => isLightModel(m) && !isNanoModel(m) && !isHeavyModel(m));
      const medium = uniqueModels.filter((m) => !isNanoModel(m) && !isLightModel(m) && !isHeavyModel(m));

      // default tier: agent order (primary then fallbacks) so reflection/general match what you set in openclaw.json
      const defaultIsHeavyOnly = uniqueModels.length > 0 && uniqueModels.every((m) => isHeavyModel(m));
      let defaultTier = [...uniqueModels];
      if (defaultIsHeavyOnly) {
        defaultTier = [...RECOMMENDED_CHEAP_FALLBACK, ...defaultTier];
        api.logger.info?.(
          "memory-hybrid: agents.defaults.model is heavy-only; prepending cheap fallback for default tier so maintenance tasks use a cheaper model first. Set llm.default / llm.nano explicitly in plugin config to override.",
        );
      }
      // heavy tier: capable first (heavy → medium → light) for distill/self-correction
      const heavyTier = [...heavy, ...medium, ...light];

      // nano: cheap first — never use Opus/heavy for classify/summarize. Use nano models if present; else when heavy-only use cheap fallback; else use light then medium from agent list.
      const nanoList =
        nano.length > 0
          ? [...nano, ...light, ...medium]
          : defaultIsHeavyOnly
            ? RECOMMENDED_CHEAP_FALLBACK
            : light.length > 0 || medium.length > 0
              ? [...light, ...medium]
              : [];

      cfg.llm = {
        ...(cfg.llm?.localAutoStart !== undefined ? { localAutoStart: cfg.llm.localAutoStart } : {}),
        ...(cfg.llm?.providers !== undefined ? { providers: cfg.llm.providers } : {}),
        ...(cfg.llm?.fallbackToDefault !== undefined ? { fallbackToDefault: cfg.llm.fallbackToDefault } : {}),
        ...(cfg.llm?.fallbackModel !== undefined ? { fallbackModel: cfg.llm.fallbackModel } : {}),
        default: defaultTier.length > 0 ? defaultTier : uniqueModels,
        heavy: heavyTier.length > 0 ? heavyTier : uniqueModels,
        ...(nanoList.length > 0 ? { nano: nanoList } : {}),
        _source: "gateway",
      };
      api.logger.info?.(
        `memory-hybrid: llm model tiers auto-derived from agents.defaults.model (default: ${(cfg.llm.default ?? []).slice(0, 3).join(", ")}${(cfg.llm.default ?? []).length > 3 ? "…" : ""}${nanoList.length > 0 ? `; nano: ${(cfg.llm.nano ?? []).slice(0, 2).join(", ")}` : ""})`,
      );
    }
  }
  // CostTracker — created early so proxy can instrument every chat.completions.create call (Issue #270).
  // Shares FactsDB's SQLite connection (same memory.db, avoids a second DB handle).
  // Gated on cfg.costTracking.enabled (default: true).
  const costTracker: CostTracker | null =
    cfg.costTracking?.enabled !== false ? new CostTracker(factsDb.getRawDb()) : null;
  if (costTracker) {
    api.logger.info("memory-hybrid: LLM cost tracker initialized");
  }

  // If Anthropic is in tier lists (e.g. from agents.defaults.model) but not yet in providers, use ANTHROPIC_API_KEY so verify --test-llm can test it.
  const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
  const heavyList = Array.isArray(cfg.llm?.heavy) ? cfg.llm.heavy : [];
  const hasAnthropicModel = (list: string[]) => list.some((m) => m.startsWith("anthropic/") || m.startsWith("claude-"));
  if (!prov.anthropic && (hasAnthropicModel(defaultList) || hasAnthropicModel(heavyList))) {
    const envKey = typeof process.env.ANTHROPIC_API_KEY === "string" ? process.env.ANTHROPIC_API_KEY.trim() : "";
    if (envKey.length >= 10) {
      prov.anthropic = { apiKey: envKey };
      mergedProviderNames.push("anthropic");
      api.logger.info?.(
        "memory-hybrid: using ANTHROPIC_API_KEY for llm.providers.anthropic (verify --test-llm will test Anthropic models)",
      );
    }
  }

  // If we merged providers, ensure at least one model from each is in the tier lists so they get tested and used as fallbacks.
  const hasModelFrom = (list: string[], prefix: string) =>
    list.some(
      (m) =>
        m.toLowerCase().startsWith(`${prefix}/`) ||
        (m.startsWith("claude-") && prefix === "anthropic") ||
        (m.startsWith("gemini-") && prefix === "google") ||
        (m.toLowerCase().startsWith("minimax-") && prefix === "minimax"),
    );
  if (cfg.llm && mergedProviderNames.length > 0) {
    const defaultList = Array.isArray(cfg.llm.default) ? [...cfg.llm.default] : [];
    const heavyList = Array.isArray(cfg.llm.heavy) ? [...cfg.llm.heavy] : [];
    const knownDefault: Record<string, string> = {
      anthropic: "anthropic/claude-sonnet-4-6",
      openai: "openai/gpt-4.1-mini",
      google: "google/gemini-2.5-flash",
      minimax: "minimax/MiniMax-Text-01",
    };
    let appended = false;
    for (const name of mergedProviderNames) {
      if (hasModelFrom(defaultList, name) && hasModelFrom(heavyList, name)) continue;
      // Prefer the actual model IDs from gateway config over the hardcoded knownDefault fallback.
      // This ensures that if the gateway has e.g. minimax.models: ["MiniMax-M2.5"], we use that
      // instead of the hardcoded "MiniMax-Text-01".
      let defaultModel: string | null = null;
      const originalName = mergedProviderOriginalNames.get(name) ?? name;
      if (gwProviders && typeof (gwProviders as Record<string, unknown>)[originalName] === "object") {
        const gw = (gwProviders as Record<string, unknown>)[originalName] as Record<string, unknown>;
        // Define chat-compatibility filter (used for both models[] and defaultModel/model fields).
        // Skip non-chat entries (embeddings, transcription, TTS, image generation) so that
        // chatCompleteWithRetry is never routed through an incompatible model.
        const NON_CHAT_TYPES = new Set([
          "embed",
          "embedding",
          "embeddings",
          "transcription",
          "speech-to-text",
          "text-to-speech",
          "tts",
          "image",
          "image-generation",
        ]);
        const NON_CHAT_ID_RE = /\bembed|whisper|\btts\b|dall-e|transcri|gpt-image|image-gen/i;
        const isChatEntry = (entry: unknown): boolean => {
          if (typeof entry === "object" && entry !== null) {
            const type = String((entry as Record<string, unknown>).type ?? "")
              .toLowerCase()
              .trim();
            if (type && NON_CHAT_TYPES.has(type)) return false;
            // If type is explicit and non-empty, trust it (unknown types → assume chat)
            if (type) return true;
            const id = String(
              (entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).name ?? "",
            ).toLowerCase();
            return !NON_CHAT_ID_RE.test(id);
          }
          if (typeof entry === "string") return !NON_CHAT_ID_RE.test(entry.toLowerCase());
          return false;
        };
        // Check models[] array first: iterate to find the first chat-compatible entry that
        // yields a non-empty trimmed model ID (skips entries with missing/empty id/name).
        if (Array.isArray(gw.models) && gw.models.length > 0) {
          for (const entry of gw.models) {
            if (!isChatEntry(entry)) continue;
            const modelId =
              typeof entry === "string"
                ? entry.trim()
                : String((entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).name ?? "").trim();
            if (modelId) {
              // Gateway may already use "provider/model" ids; avoid double prefix (e.g. azure-foundry/azure-foundry/model-router).
              defaultModel = modelId.includes("/") ? modelId : `${name}/${modelId}`;
              break;
            }
          }
        }
        // Fall back to singular defaultModel or model field (also filter non-chat models)
        if (!defaultModel) {
          const gwModel =
            typeof gw.defaultModel === "string" ? gw.defaultModel : typeof gw.model === "string" ? gw.model : null;
          const trimmed = gwModel?.trim();
          if (trimmed && isChatEntry(gwModel)) {
            defaultModel = trimmed.includes("/") ? trimmed : `${name}/${trimmed}`;
          }
        }
      }
      // Final fallback: use hardcoded knownDefault for well-known providers
      if (!defaultModel) defaultModel = knownDefault[name] ?? null;
      if (!defaultModel) continue;
      if (!hasModelFrom(defaultList, name)) {
        defaultList.push(defaultModel);
        appended = true;
      }
      const heavyModel = name === "anthropic" ? "anthropic/claude-opus-4-6" : defaultModel;
      if (!hasModelFrom(heavyList, name)) {
        heavyList.push(heavyModel);
        appended = true;
      }
    }
    if (appended) {
      (cfg.llm as Record<string, unknown>).default = defaultList;
      (cfg.llm as Record<string, unknown>).heavy = heavyList;
      api.logger.info?.(
        "memory-hybrid: appended gateway provider models to llm.default/heavy so they are tested and used as fallbacks.",
      );
    }
  }

  // Ollama auto-start: if any tier includes ollama/* models and localAutoStart is enabled,
  // attempt to launch `ollama serve` in the background when the server is not already running.
  if (cfg.llm?.localAutoStart) {
    const allModels = [...(cfg.llm.nano ?? []), ...(cfg.llm.default ?? []), ...(cfg.llm.heavy ?? [])];
    const hasOllamaModels = allModels.some((m) => m.split("/")[0]?.toLowerCase() === "ollama");
    if (hasOllamaModels) {
      void (async () => {
        try {
          const ollamaBase =
            (
              cfg.llm?.providers as Record<string, { baseURL?: string } | undefined> | undefined
            )?.ollama?.baseURL?.replace(/\/v1\/?$/, "") ?? OLLAMA_DEFAULT_BASE_URL;
          const running = await probeOllamaEndpoint(ollamaBase);
          if (!running) {
            api.logger.info("memory-hybrid: Ollama is not running — attempting auto-start (llm.localAutoStart: true)");
            const { spawn } = await import("node:child_process");
            const child = spawn("ollama", ["serve"], {
              detached: true,
              stdio: "ignore",
            });
            child.on("error", (err) => {
              api.logger.warn(`memory-hybrid: Ollama spawn error: ${err.message}`);
            });
            child.unref();
            // Allow Ollama ~2 s to bind its port before re-probing
            await new Promise<void>((r) => setTimeout(r, 2000));
            // Invalidate any cached "down" entry so the next probe goes to the network
            _ollamaHealthCache.delete(ollamaBase);
            const nowRunning = await probeOllamaEndpoint(ollamaBase);
            if (nowRunning) {
              api.logger.info("memory-hybrid: Ollama started successfully");
            } else {
              api.logger.warn(
                "memory-hybrid: Ollama auto-start attempted but server still not available — local model calls will fall back to cloud",
              );
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "ollama-auto-start",
            subsystem: "llm",
          });
          api.logger.warn(`memory-hybrid: Ollama auto-start failed: ${err}`);
        }
      })();
    }
  }

  // Chat/LLM client: multi-provider proxy that routes each model to the correct API.
  // google/* → Google Gemini OpenAI-compat API (uses distill.apiKey or llm.providers.google.apiKey)
  // openai/* or bare names → OpenAI API (uses embedding.apiKey or llm.providers.openai.apiKey)
  // ollama/* → local Ollama server (http://127.0.0.1:11434/v1 by default)
  // Other providers → require llm.providers.<provider>.apiKey + optionally baseURL
  const authBackoffStatePath = join(dirname(resolvedSqlitePath), ".auth-backoff.json");
  const openai = buildMultiProviderOpenAI(cfg, api, costTracker, authBackoffStatePath);

  const {
    credentialsDb,
    wal,
    proposalsDb,
    identityReflectionStore,
    personaStateStore,
    eventLog,
    aliasDb,
    issueStore,
    workflowStore,
    crystallizationStore,
    toolProposalStore,
    verificationStore,
    provenanceService,
    apitapStore,
  } = installOptionalBootstrapServices({
    cfg,
    api,
    factsDb,
    resolvedSqlitePath,
  });

  const narrativesPath = join(dirname(resolvedSqlitePath), "narratives.db");
  const narrativesDb = new NarrativesDB(narrativesPath);
  api.logger.info(`memory-hybrid: narratives store initialized (${narrativesPath})`);

  // Load previously discovered categories so they remain available after restart
  const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
  if (existsSync(discoveredPath)) {
    try {
      const loaded = JSON.parse(readFileSync(discoveredPath, "utf-8")) as string[];
      if (Array.isArray(loaded) && loaded.length > 0) {
        setMemoryCategories([...getMemoryCategories(), ...loaded]);
        api.logger.info(`memory-hybrid: loaded ${loaded.length} discovered categories`);
      }
    } catch (err) {
      api.logger.warn(`memory-hybrid: failed to load discovered categories: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "load-discovered-categories",
        subsystem: "config",
      });
    }
  }

  // Track embedding provider+model changes to trigger re-embedding (Issue #153).
  const currentEmbeddingMeta = {
    provider: cfg.embedding.provider,
    model: cfg.embedding.model,
  };
  let embeddingConfigChanged = false;
  try {
    const previousEmbeddingMeta = factsDb.getEmbeddingMeta();
    embeddingConfigChanged = Boolean(
      previousEmbeddingMeta &&
        (previousEmbeddingMeta.provider !== currentEmbeddingMeta.provider ||
          previousEmbeddingMeta.model !== currentEmbeddingMeta.model),
    );
    // When autoMigrate is enabled, still record the initial baseline on first run so future
    // changes can be detected. For subsequent runs with a config change, let runEmbeddingMaintenance
    // handle the meta update to avoid pre-updating before the migration service can detect the change.
    if (!cfg.embedding.autoMigrate && (!previousEmbeddingMeta || embeddingConfigChanged)) {
      factsDb.setEmbeddingMeta(currentEmbeddingMeta.provider, currentEmbeddingMeta.model);
    } else if (cfg.embedding.autoMigrate && !previousEmbeddingMeta && !embeddingConfigChanged) {
      factsDb.setEmbeddingMeta(currentEmbeddingMeta.provider, currentEmbeddingMeta.model);
    }
  } catch (err) {
    api.logger.warn(`memory-hybrid: failed to read embedding metadata (non-fatal): ${err}`);
  }

  // Health status tracking for verification checks
  const health: HealthStatus = {
    embeddingsOk: false,
    credentialsVaultOk: false,
    lastCheckTime: Date.now(),
  };

  // Prerequisite checks (async, don't block plugin start): verify keys and model access
  // Health status can be queried by tools to fail gracefully instead of throwing at runtime.
  const initialized = (async () => {
    if (wal) {
      try {
        await wal.init();
      } catch (e) {
        capturePluginError(e instanceof Error ? e : new Error(String(e)), {
          subsystem: "wal",
          operation: "init",
          phase: "initialization",
        });
        api.logger.warn(`memory-hybrid: WAL initialization failed: ${e}`);
      }
    }
    try {
      await embeddings.embed("verify");
      health.embeddingsOk = true;
      const effectiveProvider = embeddings.activeProvider ?? cfg.embedding.provider;
      api.logger.info(
        effectiveProvider !== cfg.embedding.provider
          ? `memory-hybrid: embedding check OK (provider=${effectiveProvider}, model=${embeddings.modelName} — using fallback; ${cfg.embedding.provider} unavailable)`
          : `memory-hybrid: embedding check OK (provider=${effectiveProvider}, model=${embeddings.modelName})`,
      );
    } catch (e) {
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "embeddings",
        operation: "init-verify",
        phase: "initialization",
        backend: cfg.embedding.provider,
      });
      const hint =
        cfg.embedding.provider === "ollama"
          ? `Ensure Ollama is running at ${cfg.embedding.endpoint ?? "http://localhost:11434"} and model '${cfg.embedding.model}' is pulled. Run 'openclaw hybrid-mem verify' for details.`
          : "Set a valid embedding.apiKey in plugin config and ensure the model is accessible. Run 'openclaw hybrid-mem verify' for details.";
      api.logger.error(
        `memory-hybrid: ⚠️  EMBEDDING CHECK FAILED (provider=${cfg.embedding.provider}) — ${String(e)}. ` +
          `Plugin will continue but semantic search will not work. ${hint}`,
      );
    }
    if (cfg.credentials.enabled && credentialsDb) {
      try {
        const items = credentialsDb.list();
        if (items.length > 0) {
          const first = items[0];
          credentialsDb.get(first.service, first.type as CredentialType);
        }
        health.credentialsVaultOk = true;
        api.logger.info("memory-hybrid: credentials vault check OK");
      } catch (e) {
        capturePluginError(e instanceof Error ? e : new Error(String(e)), {
          subsystem: "credentials",
          operation: "vault-verify",
          phase: "initialization",
          backend: "sqlite",
        });
        api.logger.error(
          `memory-hybrid: ⚠️  CREDENTIALS VAULT CHECK FAILED — ${String(e)}. Plugin will continue but credential storage will not work. Check OPENCLAW_CRED_KEY (or credentials.encryptionKey). Wrong key or corrupted DB. Run 'openclaw hybrid-mem verify' for details.`,
        );
      }
      // When vault is enabled: once per install, move existing credential facts into vault and redact from memory
      const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
      // Atomic flag creation to prevent race condition with multiple processes
      let shouldMigrate = false;
      try {
        const handle = await open(migrationFlagPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        try {
          await handle.writeFile("1", "utf8");
          shouldMigrate = true; // We won the race, proceed with migration
        } finally {
          await handle.close().catch(() => {
            /* ignore close errors */
          });
        }
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Another process already created the flag - skip migration
          shouldMigrate = false;
        } else {
          shouldMigrate = false;
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "credentials",
            operation: "migration-flag-create",
            phase: "initialization",
            backend: "sqlite",
          });
          api.logger.warn(`memory-hybrid: failed to create migration flag (skipping migration): ${err}`);
        }
      }
      if (shouldMigrate) {
        try {
          const result = await migrateCredentialsToVault({
            factsDb,
            vectorDb,
            embeddings,
            credentialsDb,
            aliasDb,
            migrationFlagPath,
            markDone: false, // Flag already created atomically above
          });
          if (result.migrated > 0) {
            api.logger.info(`memory-hybrid: migrated ${result.migrated} credential(s) from memory into vault`);
          }
          if (result.errors.length > 0) {
            api.logger.warn(
              `memory-hybrid: credential migration had ${result.errors.length} error(s): ${result.errors.join("; ")}`,
            );
          }
        } catch (e) {
          capturePluginError(e instanceof Error ? e : new Error(String(e)), {
            subsystem: "credentials",
            operation: "migration-to-vault",
            phase: "initialization",
            backend: "sqlite",
          });
          api.logger.warn(`memory-hybrid: credential migration failed: ${e}`);
        }
      }
    }
  })().catch((err: unknown) => {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "init",
      operation: "async-initialization",
      phase: "initialization",
    });
    api.logger.warn(`memory-hybrid: async initialization encountered an error: ${err}`);
  });

  // autoMigrate path: use the embedding-migration service when autoMigrate=true (Issue #153).
  // Runs asynchronously so it does not block plugin start.
  if (cfg.embedding.autoMigrate && embeddingConfigChanged) {
    void (async () => {
      try {
        await runEmbeddingMaintenance({
          factsDb,
          vectorDb,
          embeddings,
          currentProvider: cfg.embedding.provider,
          currentModel: cfg.embedding.model,
          autoMigrate: true,
          batchSize: cfg.embedding.batchSize,
          logger: {
            info: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
          },
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "autoMigrate-embedding",
          subsystem: "embeddings",
        });
        api.logger.warn(`memory-hybrid: autoMigrate embedding run failed: ${err}`);
      }
    })();
  }

  // Schema validation + re-embedding (Issue #128 + #153).
  // Runs asynchronously so it does not block plugin start.
  // vectorDb.count() triggers lazy initialization, after which wasRepaired is set.
  // Skip this block when autoMigrate is enabled and config changed — runEmbeddingMaintenance handles it.
  if ((cfg.vector.autoRepair || embeddingConfigChanged) && !(cfg.embedding.autoMigrate && embeddingConfigChanged)) {
    void (async () => {
      const reembedProgressPath = join(dirname(resolvedSqlitePath), ".reembed-progress.json");
      try {
        if (cfg.vector.autoRepair || embeddingConfigChanged) {
          await vectorDb.count(); // triggers doInitialize() → validateOrRepairSchema()
        }

        // Check if there's an incomplete re-embedding from a previous run
        let needsReembedding = embeddingConfigChanged || (cfg.vector.autoRepair && vectorDb.wasRepaired);
        let completedIds = new Set<string>();

        if (!needsReembedding && existsSync(reembedProgressPath)) {
          try {
            const progress = JSON.parse(readFileSync(reembedProgressPath, "utf-8")) as {
              completedIds: string[];
              total: number;
            };
            if (progress.completedIds.length < progress.total) {
              needsReembedding = true;
              completedIds = new Set(progress.completedIds);
              api.logger.info(
                `memory-hybrid: resuming incomplete re-embedding from previous run (${progress.completedIds.length}/${progress.total} completed)`,
              );
            }
          } catch {
            // Ignore invalid progress file
          }
        }

        if (needsReembedding) {
          const initialGeneration = vectorDb.getCloseGeneration();
          api.logger.info(
            embeddingConfigChanged
              ? `memory-hybrid: embedding config changed (${currentEmbeddingMeta.provider}/${currentEmbeddingMeta.model}) — re-embedding existing facts...`
              : vectorDb.wasRepaired
                ? "memory-hybrid: VectorDB was auto-repaired — re-embedding existing facts from SQLite..."
                : "memory-hybrid: resuming re-embedding after hot reload...",
          );
          const facts = factsDb.getAll({ includeSuperseded: false });
          let reembedded = completedIds.size;

          for (const fact of facts) {
            if (completedIds.has(fact.id)) {
              continue;
            }
            if (vectorDb.getCloseGeneration() !== initialGeneration) {
              // Save progress before aborting
              try {
                const progress = {
                  completedIds: Array.from(completedIds),
                  total: facts.length,
                };
                const { writeFileSync } = await import("node:fs");
                writeFileSync(reembedProgressPath, JSON.stringify(progress), "utf-8");
              } catch {
                // Ignore write errors
              }
              api.logger.info(
                `memory-hybrid: re-embedding aborted (VectorDB closed during hot reload) — ${reembedded}/${facts.length} facts re-embedded`,
              );
              return;
            }
            try {
              const vec = await embeddings.embed(fact.text);
              const isDuplicate = await vectorDb.hasDuplicate(vec);
              if (!isDuplicate) {
                await vectorDb.store({
                  id: fact.id,
                  text: fact.text,
                  vector: vec,
                  importance: fact.importance ?? 0.5,
                  category: fact.category,
                });
                factsDb.setEmbeddingModel(fact.id, embeddings.modelName);
              }
              completedIds.add(fact.id);
              reembedded++;
            } catch {
              // Skip individual failures — best-effort re-embedding
            }
          }

          // Clean up progress file on successful completion
          try {
            const { unlinkSync } = await import("node:fs");
            if (existsSync(reembedProgressPath)) {
              unlinkSync(reembedProgressPath);
            }
          } catch {
            // Ignore cleanup errors
          }

          api.logger.info(`memory-hybrid: re-embedded ${reembedded}/${facts.length} facts during re-embedding pass`);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "vector-reembed",
          subsystem: "vector",
        });
        api.logger.warn(`memory-hybrid: re-embedding failed: ${err}`);
      }
    })();
  }

  // Mark the VectorDB as a persistent long-lived singleton connection (#581).
  // This prevents fragile session refcounting from accidentally closing the shared
  // connection via removeSession() — the connection is only closed by close() (gateway shutdown).
  vectorDb.setPersistent();

  return {
    factsDb,
    vectorDb,
    embeddings,
    embeddingRegistry,
    openai,
    credentialsDb,
    wal,
    proposalsDb,
    identityReflectionStore,
    personaStateStore,
    eventLog,
    narrativesDb,
    aliasDb,
    issueStore,
    workflowStore,
    crystallizationStore,
    toolProposalStore,
    verificationStore,
    provenanceService,
    costTracker,
    resolvedLancePath,
    resolvedSqlitePath,
    health,
    initialized,
    apitapStore,
  };
}

/**
 * Closes old database instances before reinitializing.
 * Used when the plugin is reloaded (e.g., on SIGUSR1 signal).
 */
export function closeOldDatabases(context: {
  factsDb?: FactsDB | null;
  narrativesDb?: NarrativesDB | null;
  vectorDb?: VectorDB | null;
  credentialsDb?: CredentialsDB | null;
  proposalsDb?: ProposalsDB | null;
  identityReflectionStore?: import("../backends/identity-reflection-store.js").IdentityReflectionStore | null;
  personaStateStore?: import("../backends/persona-state-store.js").PersonaStateStore | null;
  eventLog?: EventLog | null;
  aliasDb?: AliasDB | null;
  eventBus?: import("../backends/event-bus.js").EventBus | null;
  issueStore?: IssueStore | null;
  workflowStore?: WorkflowStore | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  verificationStore?: VerificationStore | null;
  provenanceService?: ProvenanceService | null;
  learningsDb?: import("../backends/learnings-db.js").LearningsDB | null;
  apitapStore?: ApitapStore | null;
}): void {
  const {
    factsDb,
    narrativesDb,
    vectorDb,
    credentialsDb,
    proposalsDb,
    identityReflectionStore,
    personaStateStore,
    eventLog,
    aliasDb,
    eventBus,
    issueStore,
    workflowStore,
    crystallizationStore,
    toolProposalStore,
    verificationStore,
    provenanceService,
    learningsDb,
    apitapStore,
  } = context;

  invalidateClusterCache();

  if (typeof factsDb?.close === "function") {
    try {
      factsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "factsDb",
      });
    }
  }
  if (typeof vectorDb?.close === "function") {
    try {
      vectorDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "vectorDb",
      });
    }
  }
  if (credentialsDb) {
    try {
      credentialsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "credentialsDb",
      });
    }
  }
  if (narrativesDb) {
    try {
      narrativesDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "narrativesDb",
      });
    }
  }
  if (proposalsDb) {
    try {
      proposalsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "proposalsDb",
      });
    }
  }
  if (identityReflectionStore) {
    try {
      identityReflectionStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "identityReflectionStore",
      });
    }
  }
  if (personaStateStore) {
    try {
      personaStateStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "personaStateStore",
      });
    }
  }
  if (eventLog) {
    try {
      eventLog.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "eventLog",
      });
    }
  }
  if (aliasDb) {
    try {
      aliasDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "aliasDb",
      });
    }
  }
  if (eventBus) {
    try {
      eventBus.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "eventBus",
      });
    }
  }
  if (issueStore) {
    try {
      issueStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "issueStore",
      });
    }
  }
  if (workflowStore) {
    try {
      workflowStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "workflowStore",
      });
    }
  }
  if (crystallizationStore) {
    try {
      crystallizationStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "crystallizationStore",
      });
    }
  }
  if (toolProposalStore) {
    try {
      toolProposalStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "toolProposalStore",
      });
    }
  }
  if (verificationStore) {
    try {
      verificationStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "verificationStore",
      });
    }
  }
  if (provenanceService) {
    try {
      provenanceService.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "provenanceService",
      });
    }
  }
  if (learningsDb) {
    try {
      learningsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "learningsDb",
      });
    }
  }
  if (apitapStore) {
    try {
      apitapStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "apitapStore",
      });
    }
  }
}
