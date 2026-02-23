import { dirname, join } from "node:path";
import { existsSync, readFileSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import { CredentialsDB } from "../backends/credentials-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { WriteAheadLog } from "../backends/wal.js";
import { Embeddings } from "../services/embeddings.js";
import { vectorDimsForModel, type HybridMemoryConfig, type LLMProviderConfig, type CredentialType } from "../config.js";
import { UnconfiguredProviderError } from "../services/chat.js";
import { setKeywordsPath } from "../utils/language-keywords.js";
import { setMemoryCategories, getMemoryCategories } from "../config.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "../services/credential-migration.js";
import { capturePluginError } from "../services/error-reporter.js";

/** Known provider OpenAI-compatible base URLs. */
const GOOGLE_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
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
 *  - Unknown provider, no config → falls back to OpenAI client, logs a warning
 */
function buildMultiProviderOpenAI(cfg: HybridMemoryConfig, api: ClawdbotPluginApi): OpenAI {
  const clientCache = new Map<string, OpenAI>();
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
      return getOrCreate(`openai:gateway:${gatewayBaseUrl}`, () => new OpenAI({
        apiKey: gatewayToken ?? cfg.embedding.apiKey ?? "unused",
        baseURL: gatewayBaseUrl,
      }));
    }
    return getOrCreate("openai:default", () => new OpenAI({ apiKey: cfg.embedding.apiKey }));
  }

  function resolveClient(model: string): { client: OpenAI; bareModel: string } {
    const trimmed = model.trim();
    const slashIdx = trimmed.indexOf("/");

    if (slashIdx <= 0) {
      // Bare model name — use default OpenAI client
      return { client: defaultOpenAIClient(), bareModel: trimmed };
    }

    const prefix = trimmed.slice(0, slashIdx).toLowerCase();
    const bareModel = trimmed.slice(slashIdx + 1);
    const providerCfg: LLMProviderConfig | undefined = (cfg.llm?.providers as Record<string, LLMProviderConfig | undefined> | undefined)?.[prefix];

    if (prefix === "google") {
      const apiKey = providerCfg?.apiKey ?? cfg.distill?.apiKey;
      if (!apiKey) throw new UnconfiguredProviderError("google", trimmed);
      const baseURL = providerCfg?.baseURL ?? GOOGLE_GEMINI_BASE_URL;
      return { client: getOrCreate(`google:${baseURL}`, () => new OpenAI({ apiKey, baseURL })), bareModel };
    }

    if (prefix === "openai") {
      const apiKey = providerCfg?.apiKey ?? gatewayToken ?? cfg.embedding.apiKey;
      const baseURL = providerCfg?.baseURL ?? gatewayBaseUrl;
      const cacheKey = `openai:prefixed:${apiKey.slice(0, 8)}:${baseURL ?? "default"}`;
      return { client: getOrCreate(cacheKey, () => new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })), bareModel };
    }

    if (prefix === "anthropic") {
      const apiKey = providerCfg?.apiKey;
      if (!apiKey) throw new UnconfiguredProviderError("anthropic", trimmed);
      const baseURL = providerCfg?.baseURL;
      if (!baseURL) {
        throw new UnconfiguredProviderError(
          "anthropic",
          trimmed,
          "Missing OpenAI-compatible baseURL for Anthropic. Set llm.providers.anthropic.baseURL (e.g. your gateway or OpenAI-compatible proxy)."
        );
      }
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
      const apiKey = providerCfg.apiKey ?? "unused";
      const baseURL = providerCfg.baseURL;
      return { client: getOrCreate(`custom:${prefix}`, () => new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })), bareModel };
    }


    // Unknown provider with no config — throw so callers can skip to the next model cleanly
    throw new UnconfiguredProviderError(prefix, trimmed);
  }

  /** o1, o3, o4-mini, o3-pro, etc. — reasoning models that reject temperature/top_p params */
  const isReasoningModel = (bare: string) => /^o[0-9]/.test(bare.toLowerCase());
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
  return new Proxy(new OpenAI({ apiKey: cfg.embedding.apiKey }), {
    get(target, prop, receiver) {
      if (prop === "chat") {
        return {
          completions: {
            create(body: Parameters<OpenAI["chat"]["completions"]["create"]>[0], opts?: Parameters<OpenAI["chat"]["completions"]["create"]>[1]) {
              const model: string = (body as { model?: string }).model ?? "";
              const { client, bareModel } = resolveClient(model);
              const prefix = model.trim().split("/")[0]?.toLowerCase();
              const isOpenAI = prefix === "openai" || !model.includes("/");
              const adjustedBody = isOpenAI
                ? remapMaxTokensForOpenAI({ ...(body as object), model: bareModel }, bareModel)
                : { ...(body as object), model: bareModel };
              return client.chat.completions.create(adjustedBody as unknown as Parameters<OpenAI["chat"]["completions"]["create"]>[0], opts);
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
  embeddings: Embeddings;
  openai: OpenAI;
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  resolvedLancePath: string;
  resolvedSqlitePath: string;
  health: HealthStatus;
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
  const vectorDim = vectorDimsForModel(cfg.embedding.model);

  const factsDb = new FactsDB(resolvedSqlitePath, { fuzzyDedupe: cfg.store.fuzzyDedupe });
  const vectorDb = new VectorDB(resolvedLancePath, vectorDim);
  vectorDb.setLogger(api.logger);
  // Embeddings always use a direct OpenAI client (gateway does not proxy /v1/embeddings — issue #91)
  const openaiForEmbeddings = new OpenAI({ apiKey: cfg.embedding.apiKey });
  const embeddingModels = cfg.embedding.models?.length ? cfg.embedding.models : [cfg.embedding.model];
  const embeddings = new Embeddings(openaiForEmbeddings, embeddingModels);

  // When llm.default/heavy are not explicitly configured, auto-derive from agents.defaults.model
  // (the same model list shown by `openclaw models list`). This makes the plugin zero-config for
  // model selection when the user has already set up their models in openclaw.json.
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
      // Heavy:  pro, opus, o3, o1, large, ultra       — capable/expensive models
      // Light:  flash, small                           — fast/cheap (but not nano-cheap)
      // Medium: everything else (sonnet, gpt-4o, gpt-5, etc.)
      const isNano  = (m: string) => /nano|\bmini\b|haiku|\blite\b|\bturbo-mini\b/.test((m.split("/").pop() ?? m).toLowerCase());
      const isHeavy = (m: string) => /\bpro\b|opus|\bo3\b|\bo1\b|\blarge\b|ultra|heavy/.test((m.split("/").pop() ?? m).toLowerCase());
      const isLight = (m: string) => /flash|\bsmall\b/.test((m.split("/").pop() ?? m).toLowerCase());
      const nano    = uniqueModels.filter(m => isNano(m) && !isHeavy(m));
      const heavy   = uniqueModels.filter(m => isHeavy(m) && !isNano(m));
      const light   = uniqueModels.filter(m => isLight(m) && !isNano(m) && !isHeavy(m));
      const medium  = uniqueModels.filter(m => !isNano(m) && !isLight(m) && !isHeavy(m));

      // default tier: light first, then medium, then heavy as fallbacks
      const defaultTier = [...light, ...medium, ...heavy];
      // heavy tier: heavy first (capable), then medium, then light as fallbacks
      const heavyTier = [...heavy, ...medium, ...light];

      cfg.llm = {
        default: defaultTier.length > 0 ? defaultTier : uniqueModels,
        heavy: heavyTier.length > 0 ? heavyTier : uniqueModels,
        // nano tier: only set when nano/mini models exist in the gateway list
        ...(nano.length > 0 ? { nano: [...nano, ...light, ...medium] } : {}),
        _source: "gateway",
      };
      api.logger.info?.(`memory-hybrid: llm model tiers auto-derived from agents.defaults.model (default: ${cfg.llm.default.join(", ")}${nano.length > 0 ? `; nano: ${nano.join(", ")}` : ""})`);
    }
  }
  // Chat/LLM client: multi-provider proxy that routes each model to the correct API.
  // google/* → Google Gemini OpenAI-compat API (uses distill.apiKey or llm.providers.google.apiKey)
  // openai/* or bare names → OpenAI API (uses embedding.apiKey or llm.providers.openai.apiKey)
  // Other providers → require llm.providers.<provider>.apiKey + optionally baseURL
  const openai = buildMultiProviderOpenAI(cfg, api);

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

  // Health status tracking for verification checks
  const health: HealthStatus = {
    embeddingsOk: false,
    credentialsVaultOk: false,
    lastCheckTime: Date.now(),
  };

  // Prerequisite checks (async, don't block plugin start): verify keys and model access
  // Health status can be queried by tools to fail gracefully instead of throwing at runtime.
  void (async () => {
    try {
      await embeddings.embed("verify");
      health.embeddingsOk = true;
      api.logger.info("memory-hybrid: embedding API check OK");
    } catch (e) {
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "embeddings",
        operation: "init-verify",
        phase: "initialization",
        backend: "openai",
      });
      api.logger.error(
        `memory-hybrid: ⚠️  EMBEDDING API CHECK FAILED — ${String(e)}. ` +
          "Plugin will continue but semantic search will not work. " +
          "Set a valid embedding.apiKey in plugin config and ensure the model is accessible. Run 'openclaw hybrid-mem verify' for details.",
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
        await handle.writeFile("1", "utf8");
        await handle.close();
        shouldMigrate = true; // We won the race, proceed with migration
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Another process already created the flag - skip migration
          shouldMigrate = false;
        } else {
          throw err; // Unexpected error
        }
      }
      if (shouldMigrate) {
        try {
          const result = await migrateCredentialsToVault({
            factsDb,
            vectorDb,
            embeddings,
            credentialsDb,
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
  })();

  return {
    factsDb,
    vectorDb,
    embeddings,
    openai,
    credentialsDb,
    wal,
    proposalsDb,
    resolvedLancePath,
    resolvedSqlitePath,
    health,
  };
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
}): void {
  const { factsDb, vectorDb, credentialsDb, proposalsDb } = context;

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
}
