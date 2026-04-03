import { constants, existsSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
/** @module bootstrap-databases — Database bootstrap, optional stores, and lifecycle teardown. */
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { ApitapStore } from "../backends/apitap-store.js";
import { CostTracker } from "../backends/cost-tracker.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { IssueStore } from "../backends/issue-store.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { CredentialType, HybridMemoryConfig } from "../config.js";
import { getMemoryCategories, setMemoryCategories } from "../config.js";
import { normalizeResolvedSecretValue } from "../config/parsers/core.js";
import { is403QuotaOrRateLimitLike, is429OrWrapped } from "../services/chat.js";
import { CREDENTIAL_REDACTION_MIGRATION_FLAG, migrateCredentialsToVault } from "../services/credential-migration.js";
import { runEmbeddingMaintenance } from "../services/embedding-migration.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { formatOpenAiEmbeddingDisplayLabel, shouldSuppressEmbeddingError } from "../services/embeddings/shared.js";
import { capturePluginError } from "../services/error-reporter.js";
import { installCoreBootstrapServices, installOptionalBootstrapServices } from "../services/index.js";
import type { ProvenanceService } from "../services/provenance.js";
import type { AliasDB } from "../services/retrieval-aliases.js";
import { invalidateClusterCache } from "../services/retrieval-orchestrator.js";
import type { VerificationStore } from "../services/verification-store.js";
import { hasOAuthProfiles } from "../utils/auth.js";
import { getEnv } from "../utils/env-manager.js";
import { setKeywordsPath } from "../utils/language-keywords.js";
import { isHeavyModel, isLightModel, isNanoModel } from "../utils/model-tier.js";
import {
  OLLAMA_DEFAULT_BASE_URL,
  ROUTABLE_BUILTIN_PROVIDERS,
  buildMultiProviderOpenAI,
  clearOllamaHealthCacheEntry,
  extractGatewayConfig,
  getGatewayModelsProviders,
  mergeGatewayProviderCredentialsIntoLlmProvidersMap,
  patchEmbeddingEndpointFromGatewayProviders,
  probeOllamaEndpoint,
} from "./provider-router.js";
interface HealthStatus {
  embeddingsOk: boolean;
  credentialsVaultOk: boolean;
  lastCheckTime: number;
}

interface DatabaseContext {
  factsDb: FactsDB;
  edictStore: EdictStore;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  embeddingRegistry: EmbeddingRegistry;
  openai: OpenAI;
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  identityReflectionStore: import("../backends/identity-reflection-store.js").IdentityReflectionStore | null;
  personaStateStore: import("../backends/persona-state-store.js").PersonaStateStore | null;
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

  patchEmbeddingEndpointFromGatewayProviders(cfg, api);

  const { factsDb, edictStore, vectorDb, embeddings, embeddingRegistry } = installCoreBootstrapServices({
    cfg,
    api,
    resolvedSqlitePath,
    resolvedLancePath,
  });

  // Merge gateway provider keys into plugin llm.providers BEFORE auto-derivation so canRoute
  // can see all available providers (issue #487 fix).
  // Check three paths: models.providers (standard), llm.providers (legacy), providers (top-level).
  const gwConfig = api.config as Record<string, unknown> | undefined;
  const gwProviders = getGatewayModelsProviders(gwConfig);
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

  mergeGatewayProviderCredentialsIntoLlmProvidersMap(
    prov,
    gwProviders,
    api,
    mergedProviderNames,
    mergedProviderOriginalNames,
  );

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
      // Mirrors resolveClient()'s <PREFIX>_API_KEY fallback (see resolveClient in setup/provider-router.ts).
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
    const envKey = normalizeResolvedSecretValue(getEnv("ANTHROPIC_API_KEY")) ?? "";
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
            clearOllamaHealthCacheEntry(ollamaBase);
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
      const modelForLog =
        effectiveProvider === "openai"
          ? formatOpenAiEmbeddingDisplayLabel(embeddings.modelName, cfg.embedding.endpoint)
          : embeddings.modelName;
      api.logger.info(
        effectiveProvider !== cfg.embedding.provider
          ? `memory-hybrid: embedding check OK (provider=${effectiveProvider}, model=${modelForLog} — using fallback; ${cfg.embedding.provider} unavailable)`
          : `memory-hybrid: embedding check OK (provider=${effectiveProvider}, model=${modelForLog})`,
      );
    } catch (e) {
      const asErr = e instanceof Error ? e : new Error(String(e));
      if (!shouldSuppressEmbeddingError(asErr)) {
        capturePluginError(asErr, {
          subsystem: "embeddings",
          operation: "init-verify",
          phase: "initialization",
          backend: cfg.embedding.provider,
        });
      }
      const errText = String(e);
      const quota403 = is403QuotaOrRateLimitLike(e);
      const azure404 =
        typeof cfg.embedding.endpoint === "string" &&
        /\.openai\.azure\.com/i.test(cfg.embedding.endpoint) &&
        (/404|not found/i.test(errText) || /Model not found/i.test(errText));
      const hint = quota403
        ? "The provider returned 403 with quota/rate-limit signals (e.g. remaining-tokens=0, Retry-After). Wait for the window to reset or raise quota; your key may still be valid. Run 'openclaw hybrid-mem verify' for details."
        : cfg.embedding.provider === "ollama"
          ? `Ensure Ollama is running at ${cfg.embedding.endpoint ?? "http://localhost:11434"} and model '${cfg.embedding.model}' is pulled. Run 'openclaw hybrid-mem verify' for details.`
          : azure404
            ? 'Azure OpenAI embeddings use the deployment name as the API model id. In plugins.entries["openclaw-hybrid-memory"].config.embedding set "deployment" to the exact embedding deployment name from Azure Portal (Resource → Model deployments), or rename the deployment to match embedding.model. Ensure embedding.endpoint is the resource URL (e.g. …/openai/v1). Run \'openclaw hybrid-mem verify\' for details.'
            : "Set a valid embedding.apiKey in plugin config and ensure the model is accessible. Run 'openclaw hybrid-mem verify' for details.";
      // Warn only for transient quota/rate-limit; keep error for bad keys, wrong model, geo 403, etc. (#941 review).
      const logEmbFailure = quota403 || is429OrWrapped(asErr) ? api.logger.warn : api.logger.error;
      const embTag = quota403 || is429OrWrapped(asErr) ? "[embedding-quota]" : "[embedding-init]";
      logEmbFailure(
        `${embTag} memory-hybrid: ⚠️  EMBEDDING CHECK FAILED (provider=${cfg.embedding.provider}) — ${String(e)}. ` +
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
    edictStore,
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
  edictStore?: EdictStore | null;
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
  auditStore?: import("../backends/audit-store.js").AuditStore | null;
  agentHealthStore?: import("../backends/agent-health-store.js").AgentHealthStore | null;
}): void {
  const {
    factsDb,
    edictStore,
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
    auditStore,
    agentHealthStore,
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
  if (typeof edictStore?.close === "function") {
    try {
      edictStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "edictStore",
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
  if (auditStore) {
    try {
      auditStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "auditStore",
      });
    }
  }
  if (agentHealthStore) {
    try {
      agentHealthStore.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "close-databases",
        subsystem: "agentHealthStore",
      });
    }
  }
}
