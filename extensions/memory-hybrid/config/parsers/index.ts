import { setMemoryCategories, getMemoryCategories, PRESET_OVERRIDES } from "../utils.js";
import type { HybridMemoryConfig, EmbeddingModelConfig, ConfigMode } from "../types/index.js";
import {
  DEFAULT_MODEL,
  DEFAULT_LANCE_PATH,
  DEFAULT_SQLITE_PATH,
  EMBEDDING_DIMENSIONS,
  OPENAI_MODELS,
  resolveEnvVars,
  resolveSecretRef,
  parseStoreConfig,
  parseWALConfig,
  parseEventLogConfig,
  parsePathConfig,
  parseVectorConfig,
  parseCredentialsConfig,
  parseActiveTaskConfig,
  parseSelfCorrectionConfig,
  parseLLMConfig,
  parseGatewayConfig,
  parseAuthConfig,
} from "./core.js";
import {
  parseAutoClassifyConfig,
  parseAutoRecallConfig,
  parseRetrievalConfig,
  parseSearchConfig,
  parseQueryExpansionConfig,
  parseRerankingConfig,
  parseContextualVariantsConfig,
} from "./retrieval.js";
import {
  parsePassiveObserverConfig,
  parseReflectionConfig,
  parseProceduresConfig,
  parseExtractionConfig,
} from "./capture.js";
import {
  parseVerificationConfig,
  parseProvenanceConfig,
  parseNightlyCycleConfig,
  parseHealthConfig,
  parseMaintenanceConfig,
} from "./maintenance.js";
import {
  parseGraphConfig,
  parseGraphRetrievalConfig,
  parseClustersConfig,
  parseGapsConfig,
  parseAliasesConfig,
  parseIngestConfig,
  parseMemoryTieringConfig,
  parseAmbientConfig,
  parseReinforcementConfig,
  parseFutureDateProtectionConfig,
  parseDocumentsConfig,
  parsePersonaProposalsConfig,
  parseMemoryToSkillsConfig,
  parseMultiAgentConfig,
  parseErrorReportingConfig,
  parseWorkflowTrackingConfig,
  parseCrystallizationConfig,
  parseSelfExtensionConfig,
  parseImplicitFeedbackConfig,
  parseClosedLoopConfig,
  parseFrustrationDetectionConfig,
  parseCrossAgentLearningConfig,
  parseToolEffectivenessConfig,
  parseCostTrackingConfig,
  parseDashboardConfig,
} from "./features.js";

/** Deep-merge: base + overrides (overrides win). Used to apply preset then user config. */
function deepMergePreset(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const b = out[key];
    const o = overrides[key];
    if (o !== undefined && o !== null && typeof o === "object" && !Array.isArray(o) && typeof b === "object" && b !== null && !Array.isArray(b)) {
      out[key] = deepMergePreset(b as Record<string, unknown>, o as Record<string, unknown>);
    } else if (o !== undefined) {
      out[key] = o;
    }
  }
  return out;
}

/** Deep-equal comparison that's order-independent for objects */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (!deepEqual(aArr[i], bArr[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!deepEqual(aKeys, bKeys)) return false;

  for (const key of aKeys) {
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/** True if user value explicitly overrides a preset key (same key, different value). Extra keys in user (e.g. encryptionKey) do not count. */
function userOverridesPresetValue(userVal: unknown, presetVal: unknown): boolean {
  if (presetVal !== undefined && presetVal !== null && typeof presetVal === "object" && !Array.isArray(presetVal)) {
    if (userVal === undefined || userVal === null || typeof userVal !== "object" || Array.isArray(userVal)) return false;
    const u = userVal as Record<string, unknown>;
    const p = presetVal as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      if (key in u && userOverridesPresetValue(u[key], p[key])) return true;
    }
    return false;
  }
  return !deepEqual(userVal, presetVal);
}

export function vectorDimsForModel(model: string, fallback?: number): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

function isOpenAIModel(model: string): boolean {
  return OPENAI_MODELS.has(model);
}

export function parseConfig(value: unknown): HybridMemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory-hybrid config required");
  }
  let cfg = value as Record<string, unknown>;
  const modeRaw = cfg.mode;
  const validModes: ConfigMode[] = ["essential", "normal", "expert", "full"];
  const defaultMode: ConfigMode = "full"; // best experience out of the box; use essential/normal for low-resource or cost-conscious setups
  // Fail fast on typos/invalid modes rather than silently applying full preset
  if (typeof modeRaw === "string" && modeRaw.trim() !== "" && !validModes.includes(modeRaw as ConfigMode)) {
    throw new Error(`memory-hybrid config: invalid mode "${modeRaw}"; expected one of: ${validModes.join(", ")}`);
  }
  // Resolve the mode to apply: use the specified valid mode or fall back to default
  const appliedMode: ConfigMode =
    typeof modeRaw === "string" && validModes.includes(modeRaw as ConfigMode)
      ? (modeRaw as ConfigMode)
      : defaultMode;
  let hasPresetOverrides = false; // true when user explicitly overrode a preset value (show "Custom" in verify)
  // Apply preset for resolved mode (covers both explicit mode and default-mode paths, eliminating duplication)
  const preset = PRESET_OVERRIDES[appliedMode];
  const userRaw = { ...cfg } as Record<string, unknown>;
  delete userRaw.mode;
  cfg = deepMergePreset(preset, cfg) as Record<string, unknown>;
  delete cfg.mode;
  // Only "Custom" when user explicitly set a preset key to a different value (not when they only add e.g. embedding or credentials.encryptionKey)
  for (const key of Object.keys(preset)) {
    if (!(key in userRaw)) continue;
    if (userOverridesPresetValue(userRaw[key], preset[key])) {
      hasPresetOverrides = true;
      break;
    }
  }

  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  const validProviders = ["openai", "ollama", "onnx", "google"];
  type EmbeddingProviderName = "openai" | "ollama" | "onnx" | "google";
  const distillForEmbed = cfg.distill as { apiKey?: string } | undefined;
  const llmProvidersForEmbed = (cfg.llm as { providers?: Record<string, { apiKey?: string }> } | undefined)?.providers;
  const hasGoogleKey =
    (typeof distillForEmbed?.apiKey === "string" && distillForEmbed.apiKey.trim().length >= 10) ||
    (typeof llmProvidersForEmbed?.google?.apiKey === "string" && llmProvidersForEmbed.google.apiKey.trim().length >= 10);
  let embeddingProvider: EmbeddingProviderName;
  if (typeof embedding?.provider === "string" && validProviders.includes(embedding.provider)) {
    embeddingProvider = embedding.provider as EmbeddingProviderName;
  } else if (embedding?.provider !== undefined) {
    throw new Error(`Invalid embedding.provider: '${embedding.provider}'. Valid options: openai, ollama, onnx, google.`);
  } else {
    // Infer provider when omitted: openai if apiKey + OpenAI model; google if no openai/ollama but have google key; else ollama.
    const hasApiKey =
      embedding &&
      typeof embedding.apiKey === "string" &&
      (embedding.apiKey as string).trim().length >= 10 &&
      (embedding.apiKey as string).trim() !== "YOUR_OPENAI_API_KEY" &&
      (embedding.apiKey as string).trim() !== "<OPENAI_API_KEY>";
    const modelStr = typeof embedding?.model === "string" ? (embedding.model as string).trim() : "";
    const llm = cfg.llm as { nano?: string[]; default?: string[]; heavy?: string[] } | undefined;
    const llmListsForProvider = [llm?.nano, llm?.default, llm?.heavy].filter(Array.isArray) as string[][];
    const hasOllamaInLlmForProvider = llmListsForProvider.some((list) => list.some((m) => typeof m === "string" && (m as string).startsWith("ollama/")));
    if (hasApiKey && modelStr && isOpenAIModel(modelStr)) {
      embeddingProvider = "openai";
    } else if (!hasApiKey && !hasOllamaInLlmForProvider && hasGoogleKey) {
      embeddingProvider = "google";
    } else {
      if (embedding !== undefined) {
        console.warn(`memory-hybrid: embedding.provider not set; defaulting to "ollama". Set embedding.provider explicitly (openai, ollama, onnx, google).`);
      }
      embeddingProvider = "ollama";
    }
  }

  // apiKey is required for openai provider only
  let resolvedApiKey: string | undefined;
  if (embeddingProvider === "openai") {
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required. Set it in plugins.entries[\"openclaw-hybrid-memory\"].config.embedding. Run 'openclaw hybrid-mem verify --fix' for help.");
    }
    const rawKey = (embedding.apiKey as string).trim();
    if (rawKey.length < 10 || rawKey === "YOUR_OPENAI_API_KEY" || rawKey === "<OPENAI_API_KEY>") {
      throw new Error("embedding.apiKey is missing or a placeholder. Set a valid OpenAI API key in config. Run 'openclaw hybrid-mem verify --fix' for help.");
    }
    resolvedApiKey = resolveEnvVars(rawKey);
  } else if (embedding && typeof embedding.apiKey === "string" && (embedding.apiKey as string).trim().length >= 10) {
    // Optional fallback apiKey for ollama/onnx (used for fallback to OpenAI when provider unavailable)
    resolvedApiKey = resolveEnvVars((embedding.apiKey as string).trim());
  }

  // Resolve model from explicit 'model' field or provider-specific aliases (ollamaModel, onnxModelPath)
  const primaryModelStr = typeof embedding?.model === "string" ? embedding.model.trim() : "";
  const ollamaModelAlias = typeof embedding?.ollamaModel === "string" ? (embedding.ollamaModel as string).trim() : "";
  const onnxModelPathAlias = typeof embedding?.onnxModelPath === "string" ? (embedding.onnxModelPath as string).trim() : "";
  const resolvedModelStr =
    primaryModelStr ||
    (embeddingProvider === "ollama" ? ollamaModelAlias : "") ||
    (embeddingProvider === "onnx" ? onnxModelPathAlias : "") ||
    "";

  // Validate that model is specified for non-OpenAI providers
  if (embeddingProvider !== "openai" && !resolvedModelStr) {
    const fieldHint =
      embeddingProvider === "ollama"
        ? "embedding.model (or embedding.ollamaModel)"
        : embeddingProvider === "onnx"
          ? "embedding.model (or embedding.onnxModelPath)"
          : "embedding.model";
    throw new Error(`${fieldHint} is required when provider='${embeddingProvider}'. Specify the model name (e.g., 'nomic-embed-text' for Ollama).`);
  }
  const singleModel = resolvedModelStr || DEFAULT_MODEL;
  const modelsRaw = Array.isArray(embedding?.models) ? (embedding.models as string[]).filter((m) => typeof m === "string" && (m as string).trim().length > 0).map((m) => (m as string).trim()) : [];
  let embeddingModels: string[] | undefined;
  // Parse models for all providers (#6): for openai, these are the model preference list;
  // for ollama/onnx, these are the OpenAI fallback model names (used when apiKey is set).
  if (modelsRaw.length > 0) {
    const valid: string[] = [];
    for (const m of modelsRaw) {
      try {
        vectorDimsForModel(m);
        // For ollama/onnx providers, models field contains OpenAI fallback names — reject non-OpenAI models
        if (embeddingProvider !== "openai" && !isOpenAIModel(m)) {
          console.warn(`memory-hybrid: embedding.models — model "${m}" is not an OpenAI model and will be skipped. For provider='${embeddingProvider}', the models field must contain OpenAI fallback model names (e.g. text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002).`);
          continue;
        }
        valid.push(m);
      } catch {
        console.warn(`memory-hybrid: embedding.models — model "${m}" is not recognized and will be skipped. Check spelling or use a supported model (e.g. text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002).`);
      }
    }
    if (valid.length > 0) {
      const firstDim = vectorDimsForModel(valid[0]);
      if (valid.every((m) => vectorDimsForModel(m) === firstDim)) {
        embeddingModels = valid;
      } else {
        const dims = valid.map((m) => `${m}=${vectorDimsForModel(m)}`).join(", ");
        console.warn(`memory-hybrid: embedding.models — models have mismatched vector dimensions (${dims}); all will be ignored. Models in a list must share the same output dimension.`);
      }
    }
  }
  // For OpenAI, the models list is a preference list so use its first entry as the primary model.
  // For Ollama/ONNX, models contains OpenAI fallback names — the primary model is always singleModel.
  const model = embeddingProvider === "openai" ? (embeddingModels?.[0] ?? singleModel) : singleModel;

  // Resolve vector dimensions: explicit config takes priority, then look up from known models
  const configDimensions = typeof embedding?.dimensions === "number" && embedding.dimensions > 0
    ? embedding.dimensions
    : undefined;
  let resolvedDimensions: number;
  if (configDimensions !== undefined) {
    resolvedDimensions = configDimensions;
  } else if (embeddingProvider === "openai") {
    resolvedDimensions = vectorDimsForModel(model); // throws for unknown openai models
  } else if (embeddingProvider === "google") {
    resolvedDimensions = 768; // Google text-embedding-004 default; set embedding.dimensions to override
  } else {
    // For ollama/onnx: require explicit dimensions when the model is unknown to prevent
    // silent schema mismatches with existing LanceDB tables (e.g. 768 vs 1536 dimensions).
    if (!EMBEDDING_DIMENSIONS[model]) {
      throw new Error(
        `memory-hybrid: embedding model '${model}' is not in the known-models list. ` +
        `Set embedding.dimensions explicitly to the vector size your model produces. ` +
        `Known models: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}.`,
      );
    }
    resolvedDimensions = vectorDimsForModel(model, 768); // 768 default for known ollama models
  }

  const resolvedEndpoint = typeof embedding?.endpoint === "string" && embedding.endpoint.trim().length > 0
    ? embedding.endpoint.trim()
    : undefined;
  const resolvedBatchSize = typeof embedding?.batchSize === "number" && embedding.batchSize > 0
    ? Math.floor(embedding.batchSize)
    : 50;

  // preferredProviders: explicit list or infer from LLM config (align with failover / Ollama-as-tier)
  const preferredProvidersRaw = embedding?.preferredProviders;
  const validProviderNames = ["ollama", "openai", "google"] as const;
  type PreferredProvider = "ollama" | "openai" | "google";
  let preferredProviders: PreferredProvider[];
  if (Array.isArray(preferredProvidersRaw) && preferredProvidersRaw.length > 0) {
    preferredProviders = preferredProvidersRaw
      .filter((p): p is PreferredProvider => typeof p === "string" && validProviderNames.includes(p as PreferredProvider))
      .filter((p, i, a) => a.indexOf(p) === i); // dedupe
    if (preferredProviders.length === 0) preferredProviders = ["ollama", "openai"];
  } else {
    const inferred: PreferredProvider[] = [];
    const llm = cfg.llm as { nano?: string[]; default?: string[]; heavy?: string[] } | undefined;
    const llmLists = [llm?.nano, llm?.default, llm?.heavy].filter(Array.isArray) as string[][];
    const hasOllamaInLlm = llmLists.some((list) => list.some((m) => typeof m === "string" && m.startsWith("ollama/")));
    if (hasOllamaInLlm || embeddingProvider === "ollama") inferred.push("ollama");
    if (resolvedApiKey && resolvedApiKey.length >= 10) inferred.push("openai");
    if (hasGoogleKey) inferred.push("google");
    preferredProviders = inferred.length > 0 ? inferred : ["ollama", "openai"];
  }
  // Resolve env:/file: SecretRef format for the Google API key (Issue #344 — parallel to #333 for embedding.apiKey).
  // resolveEnvVars() only handles ${VAR} template syntax; resolveSecretRef() also handles env:VAR and file:/path.
  const rawGoogleKey = (distillForEmbed?.apiKey ?? llmProvidersForEmbed?.google?.apiKey ?? "").trim();
  const isSecretRefFormat = rawGoogleKey.startsWith("env:") || rawGoogleKey.startsWith("file:");
  let resolvedGoogleApiKey: string | undefined;
  if ((preferredProviders.includes("google") || embeddingProvider === "google") && hasGoogleKey) {
    const secretRefResolved = resolveSecretRef(rawGoogleKey);
    if (secretRefResolved !== undefined) {
      resolvedGoogleApiKey = resolveEnvVars(secretRefResolved) ?? undefined;
    } else if (!isSecretRefFormat) {
      resolvedGoogleApiKey = resolveEnvVars(rawGoogleKey) ?? undefined;
    }
  }
  if (embeddingProvider === "google" && (!resolvedGoogleApiKey || resolvedGoogleApiKey.length < 10)) {
    const hint = isSecretRefFormat
      ? ` (SecretRef '${rawGoogleKey}' could not be resolved — check the referenced env var or file is set and non-empty.)`
      : " Set distill.apiKey or llm.providers.google.apiKey in plugin config.";
    throw new Error(`embedding.provider is 'google' but no valid key found.${hint}`);
  }

  // Parse multi-model embedding config (Issue #158)
  const multiModelsRaw = embedding?.multiModels;
  const multiModelProviders = ["openai", "ollama", "onnx"] as const;
  const multiModelRoles = ["general", "domain", "query", "custom"] as const;
  const parsedMultiModels: EmbeddingModelConfig[] = Array.isArray(multiModelsRaw)
    ? (multiModelsRaw as unknown[]).filter((item): item is EmbeddingModelConfig => {
        if (!item || typeof item !== "object") return false;
        const o = item as Record<string, unknown>;
        if (typeof o.name !== "string" || o.name.trim().length === 0) return false;
        if (!multiModelProviders.includes(o.provider as "openai" | "ollama" | "onnx")) return false;
        if (typeof o.dimensions !== "number" || o.dimensions <= 0) return false;
        if (!multiModelRoles.includes(o.role as "general" | "domain" | "query" | "custom")) return false;
        return true;
      }).map((o) => ({
        name: (o as unknown as Record<string, unknown>).name as string,
        provider: (o as unknown as Record<string, unknown>).provider as "openai" | "ollama" | "onnx",
        dimensions: (o as unknown as Record<string, unknown>).dimensions as number,
        role: (o as unknown as Record<string, unknown>).role as "general" | "domain" | "query" | "custom",
        ...(typeof (o as unknown as Record<string, unknown>).apiKey === "string" ? { apiKey: (o as unknown as Record<string, unknown>).apiKey as string } : {}),
        ...(typeof (o as unknown as Record<string, unknown>).endpoint === "string" ? { endpoint: (o as unknown as Record<string, unknown>).endpoint as string } : {}),
        ...((o as unknown as Record<string, unknown>).enabled === false ? { enabled: false } : {}),
      }))
    : [];

  // Parse custom categories
  const customCategories: string[] = Array.isArray(cfg.categories)
    ? (cfg.categories as string[]).filter((c) => typeof c === "string" && c.length > 0)
    : [];

  // Merge into runtime categories
  if (customCategories.length > 0) {
    setMemoryCategories(customCategories);
  }

  const captureMaxChars =
    typeof cfg.captureMaxChars === "number" && cfg.captureMaxChars > 0
      ? cfg.captureMaxChars
      : 5000;

  const langKwRaw = cfg.languageKeywords as Record<string, unknown> | undefined;
  const languageKeywords =
    langKwRaw && typeof langKwRaw === "object"
      ? {
          autoBuild: langKwRaw.autoBuild !== false,
          weeklyIntervalDays:
            typeof langKwRaw.weeklyIntervalDays === "number" && langKwRaw.weeklyIntervalDays >= 1
              ? Math.min(30, Math.floor(langKwRaw.weeklyIntervalDays))
              : 7,
        }
      : { autoBuild: true, weeklyIntervalDays: 7 };

  // Parse optional distill config (Gemini for session distillation)
  const distillRaw = cfg.distill as Record<string, unknown> | undefined;
  const distill =
    distillRaw && typeof distillRaw === "object"
      ? {
          apiKey: typeof distillRaw.apiKey === "string" ? distillRaw.apiKey : undefined,
          defaultModel: typeof distillRaw.defaultModel === "string" ? distillRaw.defaultModel : undefined,
          fallbackModels: Array.isArray(distillRaw.fallbackModels) && distillRaw.fallbackModels.every((m) => typeof m === "string")
            ? (distillRaw.fallbackModels as string[])
            : undefined,
          extractDirectives: distillRaw.extractDirectives !== false,
          extractReinforcement: distillRaw.extractReinforcement !== false,
          reinforcementBoost: typeof distillRaw.reinforcementBoost === "number" && distillRaw.reinforcementBoost >= 0 && distillRaw.reinforcementBoost <= 1.0
            ? distillRaw.reinforcementBoost
            : 0.1,
          reinforcementProcedureBoost: typeof distillRaw.reinforcementProcedureBoost === "number" && distillRaw.reinforcementProcedureBoost >= 0 && distillRaw.reinforcementProcedureBoost <= 1.0
            ? distillRaw.reinforcementProcedureBoost
            : 0.1,
          reinforcementPromotionThreshold: typeof distillRaw.reinforcementPromotionThreshold === "number" && distillRaw.reinforcementPromotionThreshold >= 1
            ? Math.floor(distillRaw.reinforcementPromotionThreshold)
            : 2,
          extractionModelTier: (() => {
            const v = typeof distillRaw.extractionModelTier === "string" ? distillRaw.extractionModelTier.trim().toLowerCase() : "";
            return (v === "nano" || v === "default" || v === "heavy") ? (v as "nano" | "default" | "heavy") : undefined;
          })(),
        }
      : undefined;

  return {
    embedding: {
      provider: embeddingProvider,
      model,
      apiKey: resolvedApiKey,
      models: embeddingModels,
      dimensions: resolvedDimensions,
      endpoint: resolvedEndpoint,
      batchSize: resolvedBatchSize,
      preferredProviders: preferredProviders.length > 1 ? preferredProviders : undefined,
      googleApiKey: resolvedGoogleApiKey,
      multiModels: parsedMultiModels.length > 0 ? parsedMultiModels : undefined,
      autoMigrate: embedding?.autoMigrate === true,
    },
    lanceDbPath:
      typeof cfg.lanceDbPath === "string" ? cfg.lanceDbPath : DEFAULT_LANCE_PATH,
    sqlitePath:
      typeof cfg.sqlitePath === "string" ? cfg.sqlitePath : DEFAULT_SQLITE_PATH,
    autoCapture: cfg.autoCapture !== false,
    autoRecall: parseAutoRecallConfig(cfg),
    captureMaxChars,
    categories: [...getMemoryCategories()],
    autoClassify: parseAutoClassifyConfig(cfg),
    store: parseStoreConfig(cfg),
    credentials: parseCredentialsConfig(cfg),
    graph: parseGraphConfig(cfg),
    wal: parseWALConfig(cfg),
    eventLog: parseEventLogConfig(cfg),
    personaProposals: parsePersonaProposalsConfig(cfg),
    passiveObserver: parsePassiveObserverConfig(cfg),
    reflection: parseReflectionConfig(cfg),
    procedures: parseProceduresConfig(cfg),
    extraction: parseExtractionConfig(cfg),
    memoryToSkills: parseMemoryToSkillsConfig(cfg),
    memoryTiering: parseMemoryTieringConfig(cfg),
    llm: parseLLMConfig(cfg),
    auth: parseAuthConfig(cfg),
    distill,
    languageKeywords,
    ingest: parseIngestConfig(cfg),
    search: parseSearchConfig(cfg),
    retrieval: parseRetrievalConfig(cfg),
    selfCorrection: parseSelfCorrectionConfig(cfg),
    multiAgent: parseMultiAgentConfig(cfg),
    errorReporting: parseErrorReportingConfig(cfg),
    activeTask: parseActiveTaskConfig(cfg),
    vector: parseVectorConfig(cfg),
    ambient: parseAmbientConfig(cfg),
    graphRetrieval: parseGraphRetrievalConfig(cfg),
    futureDateProtection: parseFutureDateProtectionConfig(cfg),
    maintenance: parseMaintenanceConfig(cfg),
    nightlyCycle: parseNightlyCycleConfig(cfg),
    reinforcement: parseReinforcementConfig(cfg),
    clusters: parseClustersConfig(cfg),
    health: parseHealthConfig(cfg),
    gaps: parseGapsConfig(cfg),
    aliases: parseAliasesConfig(cfg),
    path: parsePathConfig(cfg),
    documents: parseDocumentsConfig(cfg),
    workflowTracking: parseWorkflowTrackingConfig(cfg),
    crystallization: parseCrystallizationConfig(cfg),
    selfExtension: parseSelfExtensionConfig(cfg),
    implicitFeedback: parseImplicitFeedbackConfig(cfg),
    closedLoop: parseClosedLoopConfig(cfg),
    frustrationDetection: parseFrustrationDetectionConfig(cfg),
    crossAgentLearning: parseCrossAgentLearningConfig(cfg),
    toolEffectiveness: parseToolEffectivenessConfig(cfg),
    contextualVariants: parseContextualVariantsConfig(cfg),
    queryExpansion: parseQueryExpansionConfig(cfg),
    reranking: parseRerankingConfig(cfg),
    verification: parseVerificationConfig(cfg),
    provenance: parseProvenanceConfig(cfg),
    costTracking: parseCostTrackingConfig(cfg),
    dashboard: parseDashboardConfig(cfg),
    verbosity: parseVerbosityLevel(cfg),
    mode: hasPresetOverrides ? "custom" : appliedMode,
    gateway: parseGatewayConfig(cfg),
  };
}

/** Parse verbosity level from config. Defaults to "normal" when not set. */
export function parseVerbosityLevel(cfg: Record<string, unknown>): import("../types/index.js").VerbosityLevel {
  const valid = ["silent", "quiet", "normal", "verbose"] as const;
  const raw = cfg.verbosity;
  if (typeof raw === "string" && (valid as readonly string[]).includes(raw)) {
    return raw as import("../types/index.js").VerbosityLevel;
  }
  if (raw !== undefined) {
    console.warn(`memory-hybrid: invalid verbosity "${raw}"; expected one of: ${valid.join(", ")}. Defaulting to "normal".`);
  }
  return "normal";
}
