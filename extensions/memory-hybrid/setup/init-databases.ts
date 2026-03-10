/** @module init-databases — Provider routing, cost instrumentation, and database bootstrap. */
import { dirname, join } from "node:path";
import { existsSync, readFileSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import { CredentialsDB } from "../backends/credentials-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { EventLog } from "../backends/event-log.js";
import { WriteAheadLog } from "../backends/wal.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../services/embeddings.js";
import { buildEmbeddingRegistry, type EmbeddingRegistry } from "../services/embedding-registry.js";
import { type HybridMemoryConfig, type LLMProviderConfig, type CredentialType, type EmbeddingModelConfig } from "../config.js";
import { UnconfiguredProviderError } from "../services/chat.js";
import { setKeywordsPath } from "../utils/language-keywords.js";
import { setMemoryCategories, getMemoryCategories } from "../config.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "../services/credential-migration.js";
import { runEmbeddingMaintenance } from "../services/embedding-migration.js";
import { capturePluginError } from "../services/error-reporter.js";
import { getCurrentCostFeature } from "../services/cost-context.js";
import { AliasDB } from "../services/retrieval-aliases.js";
import { invalidateClusterCache } from "../services/retrieval-orchestrator.js";
import { IssueStore } from "../backends/issue-store.js";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProvenanceService } from "../services/provenance.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import { VerificationStore } from "../services/verification-store.js";
import { CostTracker } from "../backends/cost-tracker.js";

/** Known provider OpenAI-compatible base URLs. */
const GOOGLE_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

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
  if (content.includes("identify behavioral patterns") || content.includes("synthesizing behavioral patterns") || content.includes("interaction history to identify")) return "reflection";

  // self-correction-analyze.txt: "You are a self-improvement analyst"
  // self-correction-rewrite-tools.txt: "You are an editor for a behavioral instructions file"
  if (content.includes("self-improvement analyst") || content.includes("self-correction") || content.includes("behavioral instructions file")) return "self-correction";

  // reinforcement-analyze.txt: "You are a positive-reinforcement analyst"
  if (content.includes("positive-reinforcement analyst") || content.includes("positive reinforcement analyst")) return "reinforcement-extract";

  // analyze-feedback-phrases.txt: "analyzing chat logs to discover how this specific user expresses"
  if (content.includes("implicit") && content.includes("feedback")) return "implicit-feedback";
  if (content.includes("discover how this specific user expresses")) return "implicit-feedback";

  // trajectory-analyze.txt: "You are a trajectory analyst"
  if (content.includes("trajectory analyst")) return "trajectory-analysis";

  // frustration detection: looks for frustration keywords in analysis context
  if (content.includes("frustration") && (content.includes("detect") || content.includes("analys"))) return "frustration-detection";

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

  // memory-to-skills-synthesize.txt: "synthesizing a reusable skill"
  if (content.includes("synthesizing a reusable skill") || content.includes("memory.to.skills")) return "memory-to-skills";

  // generate-proposals.txt: "generating persona file update proposals"
  if (content.includes("persona file update proposals") || (content.includes("persona") && content.includes("proposal"))) return "persona-proposals";

  // continuous verification
  if (content.includes("continuous") && content.includes("verification")) return "continuous-verification";

  return "unknown";
}
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION_HEADER = "2023-06-01";

/**
 * Builds a multi-provider OpenAI-compatible proxy that routes each model to the correct provider API.
 * All existing call sites use `openai.chat.completions.create({ model, ... })` unchanged — this
 * proxy intercepts those calls and selects the right API endpoint + key based on the model prefix.
 *
 * Routing:
 *  - `google/*`  → Google Gemini OpenAI-compat endpoint (distill.apiKey or llm.providers.google.apiKey)
 *  - `openai/*` or bare model (no `/`) → OpenAI (embedding.apiKey or llm.providers.openai.apiKey)
 *  - Other `provider/*` with explicit llm.providers config → custom endpoint
 *  - Unknown provider, no config → throws UnconfiguredProviderError
 */
function buildMultiProviderOpenAI(cfg: HybridMemoryConfig, api: ClawdbotPluginApi, costTracker: CostTracker | null): OpenAI {
  const clientCache = new Map<string, OpenAI>();
  /** Resolve env:VAR to process.env[VAR] so gateway-stored keys work when merged into llm.providers */
  const resolveApiKey = (key: string | undefined): string | undefined => {
    if (typeof key !== "string" || !key.trim()) return undefined;
    const k = key.trim();
    if (k.startsWith("env:")) {
      const v = process.env[k.slice(4).trim()];
      return v ?? undefined;
    }
    return k;
  };
  const gatewayPortRaw = process.env.OPENCLAW_GATEWAY_PORT;
  const gatewayPort = gatewayPortRaw ? Number.parseInt(gatewayPortRaw, 10) : undefined;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const gatewayBaseUrl = gatewayPort && gatewayPort >= 1 && gatewayPort <= 65535
    ? `http://127.0.0.1:${gatewayPort}/v1`
    : undefined;
  if (gatewayPortRaw && (!gatewayPort || gatewayPort < 1 || gatewayPort > 65535)) {
    api.logger.warn?.(`memory-hybrid: OPENCLAW_GATEWAY_PORT must be 1-65535 (got '${gatewayPortRaw}'); falling back to direct OpenAI.`);
  }
  if (gatewayBaseUrl && !gatewayToken) {
    api.logger.warn?.("memory-hybrid: OPENCLAW_GATEWAY_PORT set but OPENCLAW_GATEWAY_TOKEN is missing; gateway calls may fail if the gateway requires auth.");
  }

  function getOrCreate(key: string, factory: () => OpenAI): OpenAI {
    if (!clientCache.has(key)) clientCache.set(key, factory());
    return clientCache.get(key)!;
  }

  function defaultOpenAIClient(): OpenAI {
    if (gatewayBaseUrl) {
      const key = gatewayToken ?? cfg.embedding.apiKey;
      if (!key) throw new UnconfiguredProviderError("openai", "openai/*");
      return getOrCreate(`openai:gateway:${gatewayBaseUrl}`, () => new OpenAI({
        apiKey: key,
        baseURL: gatewayBaseUrl,
      }));
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
    return trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
  }

  function resolveClient(model: string): { client: OpenAI; bareModel: string } {
    const normalized = normalizeModelId(model);
    const trimmed = normalized.trim();
    const slashIdx = trimmed.indexOf("/");

    if (slashIdx <= 0) {
      // Still bare — use default OpenAI client
      return { client: defaultOpenAIClient(), bareModel: trimmed };
    }

    const prefix = trimmed.slice(0, slashIdx).toLowerCase();
    const bareModel = trimmed.slice(slashIdx + 1);
    const providerCfg: LLMProviderConfig | undefined = (cfg.llm?.providers as Record<string, LLMProviderConfig | undefined> | undefined)?.[prefix];

    if (prefix === "google") {
      const apiKey = resolveApiKey(providerCfg?.apiKey ?? cfg.distill?.apiKey)
        ?? (process.env.GOOGLE_API_KEY?.trim() || undefined);
      if (!apiKey) throw new UnconfiguredProviderError("google", trimmed);
      const baseURL = providerCfg?.baseURL ?? GOOGLE_GEMINI_BASE_URL;
      return { client: getOrCreate(`google:${baseURL}`, () => new OpenAI({ apiKey, baseURL })), bareModel };
    }

    if (prefix === "openai") {
      const apiKey = resolveApiKey(providerCfg?.apiKey ?? gatewayToken ?? cfg.embedding.apiKey)
        ?? (process.env.OPENAI_API_KEY?.trim() || undefined);
      if (!apiKey) throw new UnconfiguredProviderError("openai", trimmed);
      const baseURL = providerCfg?.baseURL ?? gatewayBaseUrl;
      const cacheKey = `openai:prefixed:${apiKey.slice(0, 8)}:${baseURL ?? "default"}`;
      return { client: getOrCreate(cacheKey, () => new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })), bareModel };
    }

    if (prefix === "anthropic") {
      const apiKey = resolveApiKey(providerCfg?.apiKey)
        ?? (process.env.ANTHROPIC_API_KEY?.trim() || undefined);
      if (!apiKey) throw new UnconfiguredProviderError("anthropic", trimmed);
      const baseURL = providerCfg?.baseURL ?? ANTHROPIC_BASE_URL;
      // Anthropic's OpenAI-compatible endpoints require anthropic-version header
      return {
        client: getOrCreate(`anthropic:${baseURL}`, () => new OpenAI({
          apiKey,
          baseURL,
          defaultHeaders: { "anthropic-version": ANTHROPIC_VERSION_HEADER },
        })),
        bareModel,
      };
    }

    if (providerCfg?.apiKey || providerCfg?.baseURL) {
      // apiKey may be absent when the provider only needs a custom baseURL (some self-hosted servers)
      const apiKey = resolveApiKey(providerCfg.apiKey) ?? "no-key";
      const baseURL = providerCfg.baseURL;
      const cacheKey = `custom:${prefix}:${apiKey.slice(0, 8)}:${baseURL ?? "default"}`;
      return { client: getOrCreate(cacheKey, () => new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })), bareModel };
    }

    // Before giving up, try provider-specific env var pattern (but NOT the gateway token —
    // that's scoped to the local gateway only and must never be sent to external endpoints).
    // Covers any provider following the <PREFIX>_API_KEY convention.
    const envFallbackKey = process.env[`${prefix.toUpperCase()}_API_KEY`]?.trim();
    if (envFallbackKey) {
      const baseURL = providerCfg?.baseURL;
      const cacheKey = `custom:${prefix}:${envFallbackKey.slice(0, 8)}:${baseURL ?? "default"}`;
      return { client: getOrCreate(cacheKey, () => new OpenAI({ apiKey: envFallbackKey, ...(baseURL ? { baseURL } : {}) })), bareModel };
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
      const { temperature, top_p, ...rest } = result as Record<string, unknown> & { temperature?: unknown; top_p?: unknown };
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
            create(body: Parameters<OpenAI["chat"]["completions"]["create"]>[0], opts?: Parameters<OpenAI["chat"]["completions"]["create"]>[1]) {
              const rawModel: string = (body as { model?: string }).model ?? "";
              const model = normalizeModelId(rawModel);
              const { client, bareModel } = resolveClient(model);
              const prefix = model.trim().split("/")[0]?.toLowerCase();
              const isOpenAI = prefix === "openai" || !model.includes("/");
              const adjustedBody = isOpenAI
                ? remapMaxTokensForOpenAI({ ...(body as object), model: bareModel }, bareModel)
                : { ...(body as object), model: bareModel };
              const start = Date.now();
              const promise = client.chat.completions.create(adjustedBody as unknown as Parameters<OpenAI["chat"]["completions"]["create"]>[0], opts);
              // Fire-and-forget cost tracking — never blocks or modifies the returned promise
              if (costTracker) {
                const feature = inferFeatureLabel(body as unknown as Record<string, unknown>, model);
                // Canonicalize so mis-prefixed names (e.g. openai/gemini-*) are stored with correct provider for pricing
                const normalizedModel = canonicalModelIdForCost(model.includes("/") ? model : `openai/${model.trim()}`);
                void (Promise.resolve(promise) as Promise<unknown>).then(
                  (resp: unknown) => {
                    try {
                      const durationMs = Date.now() - start;
                      const r = resp as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
                      costTracker.record({
                        feature,
                        model: normalizedModel,
                        inputTokens: r?.usage?.prompt_tokens ?? 0,
                        outputTokens: r?.usage?.completion_tokens ?? 0,
                        durationMs,
                        success: true,
                      });
                    } catch { /* never let tracking break LLM calls */ }
                  },
                  () => {
                    try {
                      const durationMs = Date.now() - start;
                      // Estimate input tokens from request messages (actual count unavailable on failure)
                      const reqMessages = Array.isArray((body as unknown as Record<string, unknown>).messages)
                        ? (body as unknown as Record<string, unknown>).messages as unknown[]
                        : [];
                      const estimatedInputTokens = Math.ceil(JSON.stringify(reqMessages).length / 4);
                      costTracker.record({ feature, model: normalizedModel, inputTokens: estimatedInputTokens, outputTokens: 0, durationMs, success: false });
                    } catch { /* never let tracking break LLM calls */ }
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
export function initializeDatabases(
  cfg: HybridMemoryConfig,
  api: ClawdbotPluginApi,
): DatabaseContext {
  const resolvedLancePath = api.resolvePath(cfg.lanceDbPath);
  const resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
  setKeywordsPath(dirname(resolvedSqlitePath));

  const factsDb = new FactsDB(resolvedSqlitePath, { fuzzyDedupe: cfg.store.fuzzyDedupe });
  const vectorDim = cfg.embedding.dimensions;
  const vectorDb = new VectorDB(resolvedLancePath, vectorDim, cfg.vector.autoRepair);
  vectorDb.setLogger(api.logger);
  // Create embedding provider from config (supports openai, ollama, onnx, google; chain/failover when preferredProviders set)
  const embeddings = createEmbeddingProvider(cfg.embedding, (err) => {
    api.logger.warn(
      `memory-hybrid: ${cfg.embedding.provider} embedding unavailable (${err}), switching to OpenAI fallback`,
    );
  });
  const embeddingRegistry = buildEmbeddingRegistry(
    embeddings,
    cfg.embedding.model,
    resolveEmbeddingRegistryModels(cfg.embedding),
  );

  // When llm.default/heavy are not explicitly configured, auto-derive from agents.defaults.model
  // (the same model list shown by `openclaw models list`). This makes the plugin zero-config for
  // model selection when the user has already set up their models in openclaw.json.
  // If the gateway list is heavy-only (e.g. only Opus), we prepend a cheap fallback so default/nano
  // tasks don't all use the expensive model (see cost issue: hundreds of tasks running as Opus).
  const RECOMMENDED_CHEAP_FALLBACK = ["openai/gpt-4.1-nano", "google/gemini-2.0-flash-lite", "anthropic/claude-3-5-haiku"];
  if (!cfg.llm) {
    const agentModel = (api.config as Record<string, unknown>)?.agents as Record<string, unknown> | undefined;
    const agentDefaults = agentModel?.defaults as Record<string, unknown> | undefined;
    const modelCfg = agentDefaults?.model as Record<string, unknown> | undefined;
    const primary = typeof modelCfg?.primary === "string" ? modelCfg.primary : undefined;
    const fallbacks = Array.isArray(modelCfg?.fallbacks)
      ? (modelCfg.fallbacks as unknown[]).filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : [];
    const gatewayModels = [primary, ...fallbacks].filter((m): m is string => Boolean(m));

    if (gatewayModels.length > 0) {
      // Deduplicate while preserving order
      const seen = new Set<string>();
      const uniqueModels = gatewayModels.filter(m => { if (seen.has(m)) return false; seen.add(m); return true; });

      // Heuristic tier split based on model name keywords.
      // Nano:   nano, mini, haiku, lite, turbo-mini  — ultra-cheap for classify/HyDE/summarize
      // Heavy:  pro, opus, o3, o1, large, ultra, gpt-5  — capable/expensive models (incl. GPT-5.4, Codex)
      // Light:  flash, small                           — fast/cheap (but not nano-cheap)
      // Medium: everything else (sonnet, gpt-4o, etc.)
      const isNano  = (m: string) => /nano|\bmini\b|haiku|\blite\b|\bturbo-mini\b/.test((m.split("/").pop() ?? m).toLowerCase());
      const isHeavy = (m: string) => /\bpro\b|opus|\bo3\b|\bo1\b|\blarge\b|ultra|heavy|gpt-5/.test((m.split("/").pop() ?? m).toLowerCase());
      const isLight = (m: string) => /flash|\bsmall\b/.test((m.split("/").pop() ?? m).toLowerCase());
      const nano    = uniqueModels.filter(m => isNano(m) && !isHeavy(m));
      const heavy   = uniqueModels.filter(m => isHeavy(m) && !isNano(m));
      const light   = uniqueModels.filter(m => isLight(m) && !isNano(m) && !isHeavy(m));
      const medium  = uniqueModels.filter(m => !isNano(m) && !isLight(m) && !isHeavy(m));

      // default tier: agent order (primary then fallbacks) so reflection/general match what you set in openclaw.json
      const defaultIsHeavyOnly = uniqueModels.length > 0 && uniqueModels.every(m => isHeavy(m));
      let defaultTier = [...uniqueModels];
      if (defaultIsHeavyOnly) {
        defaultTier = [...RECOMMENDED_CHEAP_FALLBACK, ...defaultTier];
        api.logger.info?.(`memory-hybrid: agents.defaults.model is heavy-only; prepending cheap fallback for default tier so maintenance tasks use a cheaper model first. Set llm.default / llm.nano explicitly in plugin config to override.`);
      }
      // heavy tier: capable first (heavy → medium → light) for distill/self-correction
      const heavyTier = [...heavy, ...medium, ...light];

      // nano: cheap first — never use Opus/heavy for classify/summarize. Use nano models if present; else when heavy-only use cheap fallback; else use light then medium from agent list.
      const nanoList = nano.length > 0
        ? [...nano, ...light, ...medium]
        : defaultIsHeavyOnly
          ? RECOMMENDED_CHEAP_FALLBACK
          : light.length > 0 || medium.length > 0
            ? [...light, ...medium]
            : [];

      cfg.llm = {
        default: defaultTier.length > 0 ? defaultTier : uniqueModels,
        heavy: heavyTier.length > 0 ? heavyTier : uniqueModels,
        ...(nanoList.length > 0 ? { nano: nanoList } : {}),
        _source: "gateway",
      };
      api.logger.info?.(`memory-hybrid: llm model tiers auto-derived from agents.defaults.model (default: ${cfg.llm.default.slice(0, 3).join(", ")}${cfg.llm.default.length > 3 ? "…" : ""}${nanoList.length > 0 ? `; nano: ${(cfg.llm.nano ?? []).slice(0, 2).join(", ")}` : ""})`);
    }
  }
  // CostTracker — created early so proxy can instrument every chat.completions.create call (Issue #270).
  // Shares FactsDB's SQLite connection (same memory.db, avoids a second DB handle).
  // Gated on cfg.costTracking.enabled (default: true).
  const costTracker: CostTracker | null = cfg.costTracking?.enabled !== false
    ? new CostTracker(factsDb.getRawDb())
    : null;
  if (costTracker) {
    api.logger.info("memory-hybrid: LLM cost tracker initialized");
  }

  // Merge gateway provider keys into plugin llm.providers so the plugin can use all keys the gateway has
  // (e.g. Minimax, Anthropic, etc.) without duplicating them in plugin config.
  const gwConfig = api.config as Record<string, unknown> | undefined;
  const gwProviders = (gwConfig?.models as Record<string, unknown> | undefined)?.providers
    ?? (gwConfig?.llm as Record<string, unknown> | undefined)?.providers;
  const mergedProviderNames: string[] = [];
  if (!cfg.llm) (cfg as Record<string, unknown>).llm = { providers: {} };
  const plm = cfg.llm as Record<string, unknown>;
  if (!plm.providers || typeof plm.providers !== "object") plm.providers = {};
  const prov = plm.providers as Record<string, Record<string, unknown>>;

  if (gwProviders && typeof gwProviders === "object" && !Array.isArray(gwProviders)) {
    for (const [name, gw] of Object.entries(gwProviders)) {
      if (!name || !gw || typeof gw !== "object") continue;
      const rawKey = (gw as Record<string, unknown>).apiKey ?? (gw as Record<string, unknown>).api_key;
      if (typeof rawKey !== "string" || !rawKey.trim()) continue;
      if (!prov[name]) {
        prov[name] = {
          apiKey: rawKey.trim(),
          baseURL: (gw as Record<string, unknown>).baseURL ?? (gw as Record<string, unknown>).base_url,
        };
        mergedProviderNames.push(name);
        api.logger.info?.(`memory-hybrid: using gateway provider "${name}" for llm.providers (add ${name}/<model> to llm.default or llm.heavy to use)`);
      }
    }
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
      api.logger.info?.("memory-hybrid: using ANTHROPIC_API_KEY for llm.providers.anthropic (verify --test-llm will test Anthropic models)");
    }
  }

  // If we merged providers, ensure at least one model from each is in the tier lists so they get tested and used as fallbacks.
  const hasModelFrom = (list: string[], prefix: string) => list.some((m) => m.startsWith(`${prefix}/`) || (m.startsWith("claude-") && prefix === "anthropic") || (m.startsWith("gemini-") && prefix === "google"));
  if (cfg.llm && mergedProviderNames.length > 0) {
    const defaultList = Array.isArray(cfg.llm.default) ? [...cfg.llm.default] : [];
    const heavyList = Array.isArray(cfg.llm.heavy) ? [...cfg.llm.heavy] : [];
    const knownDefault: Record<string, string> = {
      anthropic: "anthropic/claude-sonnet-4-6",
      openai: "openai/gpt-4.1-mini",
      google: "google/gemini-2.5-flash",
    };
    let appended = false;
    for (const name of mergedProviderNames) {
      if (hasModelFrom(defaultList, name) && hasModelFrom(heavyList, name)) continue;
      let defaultModel: string | null = knownDefault[name] ?? null;
      if (!defaultModel && gwProviders && typeof (gwProviders as Record<string, unknown>)[name] === "object") {
        const gw = (gwProviders as Record<string, unknown>)[name] as Record<string, unknown>;
        const gwModel = typeof gw.defaultModel === "string" ? gw.defaultModel : typeof gw.model === "string" ? gw.model : null;
        if (gwModel?.trim()) defaultModel = `${name}/${gwModel.trim()}`;
      }
      if (!defaultModel) continue;
      if (!hasModelFrom(defaultList, name)) { defaultList.push(defaultModel); appended = true; }
      const heavyModel = name === "anthropic" ? "anthropic/claude-opus-4-6" : defaultModel;
      if (!hasModelFrom(heavyList, name)) { heavyList.push(heavyModel); appended = true; }
    }
    if (appended) {
      (cfg.llm as Record<string, unknown>).default = defaultList;
      (cfg.llm as Record<string, unknown>).heavy = heavyList;
      api.logger.info?.(`memory-hybrid: appended gateway provider models to llm.default/heavy so they are tested and used as fallbacks.`);
    }
  }

  // Chat/LLM client: multi-provider proxy that routes each model to the correct API.
  // google/* → Google Gemini OpenAI-compat API (uses distill.apiKey or llm.providers.google.apiKey)
  // openai/* or bare names → OpenAI API (uses embedding.apiKey or llm.providers.openai.apiKey)
  // Other providers → require llm.providers.<provider>.apiKey + optionally baseURL
  const openai = buildMultiProviderOpenAI(cfg, api, costTracker);

  let credentialsDb: CredentialsDB | null = null;
  if (cfg.credentials.enabled) {
    const credPath = join(dirname(resolvedSqlitePath), "credentials.db");
    credentialsDb = new CredentialsDB(credPath, cfg.credentials.encryptionKey ?? "");
    const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
    api.logger.info(
      encrypted
        ? `memory-hybrid: credentials vault enabled (encrypted) (${credPath})`
        : `memory-hybrid: credentials vault enabled (plaintext; secure by other means) (${credPath})`
    );
  }

  // Initialize Write-Ahead Log for crash resilience
  let wal: WriteAheadLog | null = null;
  if (cfg.wal.enabled) {
    const walPath = cfg.wal.walPath || join(dirname(resolvedSqlitePath), "memory.wal");
    wal = new WriteAheadLog(walPath, cfg.wal.maxAge);
    api.logger.info(`memory-hybrid: WAL enabled (${walPath})`);
  }

  let proposalsDb: ProposalsDB | null = null;
  if (cfg.personaProposals.enabled) {
    const proposalsPath = join(dirname(resolvedSqlitePath), "proposals.db");
    proposalsDb = new ProposalsDB(proposalsPath);
    api.logger.info(`memory-hybrid: persona proposals enabled (${proposalsPath})`);
  }

  // Initialize EventLog whenever any episodic feature is enabled: nightlyCycle (consolidation,
  // contradiction resolution), graph.autoSupersede (contradiction events), or passiveObserver
  // (Layer 1 write-before-store, Issue #150). This ensures any code path that appends to
  // event_log gets a live instance rather than silently skipping.
  let eventLog: EventLog | null = null;
  if (cfg.nightlyCycle.enabled || cfg.graph?.autoSupersede || cfg.passiveObserver.enabled) {
    const eventLogPath = join(dirname(resolvedSqlitePath), "event-log.db");
    eventLog = new EventLog(eventLogPath);
    api.logger.info(`memory-hybrid: event log initialized (${eventLogPath})`);
  }

  // Initialize alias DB (Issue #149)
  let aliasDb: AliasDB | null = null;
  if (cfg.aliases?.enabled) {
    const aliasPath = join(dirname(resolvedSqlitePath), "aliases.db");
    const aliasLancePath = join(dirname(resolvedSqlitePath), "aliases.lance");
    aliasDb = new AliasDB(aliasPath, aliasLancePath, cfg.embedding.dimensions);
    api.logger.info(`memory-hybrid: retrieval aliases enabled (${aliasPath}, ${aliasLancePath})`);
  }

  // Initialize IssueStore — always enabled, lightweight SQLite table (Issue #137)
  const issueStorePath = join(dirname(resolvedSqlitePath), "issues.db");
  const issueStore = new IssueStore(issueStorePath);
  api.logger.info(`memory-hybrid: issue store initialized (${issueStorePath})`);

  // Initialize WorkflowStore — always created; recording gated by cfg.workflowTracking.enabled (Issue #209)
  const workflowStorePath = join(dirname(resolvedSqlitePath), "workflow-traces.db");
  const workflowStore = new WorkflowStore(workflowStorePath);
  api.logger.info(`memory-hybrid: workflow store initialized (${workflowStorePath})`);

  // Initialize CrystallizationStore — always created; proposals gated by cfg.crystallization.enabled (Issue #208)
  const crystallizationStorePath = join(dirname(resolvedSqlitePath), "crystallization-proposals.db");
  const crystallizationStore = new CrystallizationStore(crystallizationStorePath);
  api.logger.info(`memory-hybrid: crystallization store initialized (${crystallizationStorePath})`);

  // Initialize ToolProposalStore — always created; proposals gated by cfg.selfExtension.enabled (Issue #210)
  const toolProposalStorePath = join(dirname(resolvedSqlitePath), "tool-proposals.db");
  const toolProposalStore = new ToolProposalStore(toolProposalStorePath);
  api.logger.info(`memory-hybrid: tool proposal store initialized (${toolProposalStorePath})`);

  // Initialize VerificationStore when enabled (Issue #162).
  // Share FactsDB's db instance so verified_facts lives in the same connection —
  // avoids a second Database handle on facts.db and prevents dual table-creation conflicts.
  let verificationStore: VerificationStore | null = null;
  if (cfg.verification.enabled) {
    verificationStore = new VerificationStore(factsDb.getRawDb(), {
      backupPath: cfg.verification.backupPath,
      reverificationDays: cfg.verification.reverificationDays,
      logger: api.logger,
    });
    api.logger.info("memory-hybrid: verification store enabled");
  }


  // Initialize ProvenanceService when enabled (Issue #163)
  let provenanceService: ProvenanceService | null = null;
  if (cfg.provenance.enabled) {
    const provenancePath = join(dirname(resolvedSqlitePath), "provenance.db");
    provenanceService = new ProvenanceService(provenancePath);
    api.logger.info(`memory-hybrid: provenance tracing enabled (${provenancePath})`);
  }

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
  const currentEmbeddingMeta = { provider: cfg.embedding.provider, model: cfg.embedding.model };
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
      const hint = cfg.embedding.provider === "ollama"
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
          `memory-hybrid: ⚠️  CREDENTIALS VAULT CHECK FAILED — ${String(e)}. ` +
            "Plugin will continue but credential storage will not work. " +
            "Check OPENCLAW_CRED_KEY (or credentials.encryptionKey). Wrong key or corrupted DB. Run 'openclaw hybrid-mem verify' for details.",
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
          await handle.close().catch(() => { /* ignore close errors */ });
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
            api.logger.warn(`memory-hybrid: credential migration had ${result.errors.length} error(s): ${result.errors.join("; ")}`);
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
            const progress = JSON.parse(readFileSync(reembedProgressPath, "utf-8")) as { completedIds: string[]; total: number };
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
                const progress = { completedIds: Array.from(completedIds), total: facts.length };
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

          api.logger.info(
            `memory-hybrid: re-embedded ${reembedded}/${facts.length} facts during re-embedding pass`,
          );
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

  return {
    factsDb,
    vectorDb,
    embeddings,
    embeddingRegistry,
    openai,
    credentialsDb,
    wal,
    proposalsDb,
    eventLog,
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
  };
}

function resolveEmbeddingRegistryModels(
  embedding: HybridMemoryConfig["embedding"],
): EmbeddingModelConfig[] | undefined {
  if (Array.isArray(embedding.multiModels) && embedding.multiModels.length > 0) {
    return embedding.multiModels;
  }
  const rawModels = (embedding as unknown as { models?: unknown }).models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) return undefined;
  const hasObjectModels = rawModels.every(
    (item) => item && typeof item === "object",
  );
  if (!hasObjectModels) return undefined;
  return rawModels as EmbeddingModelConfig[];
}

/**
 * Closes old database instances before reinitializing.
 * Used when the plugin is reloaded (e.g., on SIGUSR1 signal).
 */
export function closeOldDatabases(context: {
  factsDb?: FactsDB | null;
  vectorDb?: VectorDB | null;
  credentialsDb?: CredentialsDB | null;
  proposalsDb?: ProposalsDB | null;
  eventLog?: EventLog | null;
  aliasDb?: AliasDB | null;
  issueStore?: IssueStore | null;
  workflowStore?: WorkflowStore | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  verificationStore?: VerificationStore | null;
  provenanceService?: ProvenanceService | null;
}): void {
  const { factsDb, vectorDb, credentialsDb, proposalsDb, eventLog, aliasDb, issueStore, workflowStore, crystallizationStore, toolProposalStore, verificationStore, provenanceService } = context;

  invalidateClusterCache();

  if (typeof factsDb?.close === "function") {
    try {
      factsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "factsDb" });
    }
  }
  if (typeof vectorDb?.close === "function") {
    try {
      vectorDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "vectorDb" });
    }
  }
  if (credentialsDb) {
    try {
      credentialsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "credentialsDb" });
    }
  }
  if (proposalsDb) {
    try {
      proposalsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "proposalsDb" });
    }
  }
  if (eventLog) {
    try {
      eventLog.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "eventLog" });
    }
  }
  if (aliasDb) {
    try {
      aliasDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "aliasDb" });
    }
  }
  if (issueStore) {
    try {
      issueStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "issueStore" });
    }
  }
  if (workflowStore) {
    try {
      workflowStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "workflowStore" });
    }
  }
  if (crystallizationStore) {
    try {
      crystallizationStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "crystallizationStore" });
    }
  }
  if (toolProposalStore) {
    try {
      toolProposalStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "toolProposalStore" });
    }
  }
  if (verificationStore) {
    try {
      verificationStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "verificationStore" });
    }
  }
  if (provenanceService) {
    try {
      provenanceService.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "provenanceService" });
    }
  }
}
