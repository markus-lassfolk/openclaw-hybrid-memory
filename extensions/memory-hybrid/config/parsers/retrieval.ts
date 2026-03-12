import type {
  AutoRecallConfig,
  AutoRecallInjectionFormat,
  AutoClassifyConfig,
  EntityLookupConfig,
  RetrievalDirectivesConfig,
  AuthFailureRecallConfig,
  RetrievalConfig,
  SearchConfig,
  QueryExpansionConfig,
  RerankingConfig,
  ContextualVariantsConfig,
} from "../types/retrieval.js";

// Minimum timeout floors (#384): prevent spurious timeouts for slow thinking models like Gemini 2.5 Flash.
// Exported so tests can reference the canonical values without hardcoding magic numbers.
export const MIN_QE_TIMEOUT_MS = 10_000;
export const MIN_RERANK_TIMEOUT_MS = 5_000;

export function parseAutoClassifyConfig(cfg: Record<string, unknown>): AutoClassifyConfig {
  const acCfg = cfg.autoClassify as Record<string, unknown> | undefined;
  return {
    enabled: acCfg?.enabled === true,
    model: typeof acCfg?.model === "string" ? acCfg.model : undefined,
    batchSize: typeof acCfg?.batchSize === "number" ? acCfg.batchSize : 20,
    suggestCategories: acCfg?.suggestCategories !== false,
    minFactsForNewCategory: typeof acCfg?.minFactsForNewCategory === "number" ? acCfg.minFactsForNewCategory : 10,
  };
}

export function parseAutoRecallConfig(cfg: Record<string, unknown>): AutoRecallConfig {
  const arRaw = cfg.autoRecall;
  const VALID_FORMATS = ["full", "short", "minimal", "progressive", "progressive_hybrid"] as const;

  if (typeof arRaw === "object" && arRaw !== null && !Array.isArray(arRaw)) {
    const ar = arRaw as Record<string, unknown>;
    const format = typeof ar.injectionFormat === "string" && VALID_FORMATS.includes(ar.injectionFormat as typeof VALID_FORMATS[number])
      ? (ar.injectionFormat as AutoRecallInjectionFormat)
      : "full";
    const limit = typeof ar.limit === "number" && ar.limit > 0 ? Math.floor(ar.limit) : 10;
    const minScore = typeof ar.minScore === "number" && ar.minScore >= 0 && ar.minScore <= 1 ? ar.minScore : 0.3;
    const preferLongTerm = ar.preferLongTerm === true;
    const useImportanceRecency = ar.useImportanceRecency === true;
    const entityLookupRaw = ar.entityLookup as Record<string, unknown> | undefined;
    const entityLookup: EntityLookupConfig = {
      enabled: entityLookupRaw?.enabled === true,
      entities: Array.isArray(entityLookupRaw?.entities)
        ? (entityLookupRaw.entities as string[]).filter((e) => typeof e === "string" && e.length > 0)
        : [],
      maxFactsPerEntity:
        typeof entityLookupRaw?.maxFactsPerEntity === "number" && entityLookupRaw.maxFactsPerEntity > 0
          ? Math.floor(entityLookupRaw.maxFactsPerEntity)
          : 2,
    };
    const summaryThreshold =
      typeof ar.summaryThreshold === "number" && ar.summaryThreshold >= 0 ? ar.summaryThreshold : 300;
    const summaryMaxChars =
      typeof ar.summaryMaxChars === "number" && ar.summaryMaxChars > 0 ? Math.min(ar.summaryMaxChars, 500) : 80;
    const useSummaryInInjection = ar.useSummaryInInjection !== false;
    const summarizeWhenOverBudget = ar.summarizeWhenOverBudget === true;
    const summarizeModel = typeof ar.summarizeModel === "string" ? ar.summarizeModel : undefined;
    const directivesRaw = ar.retrievalDirectives as Record<string, unknown> | undefined;
    const keywordsRaw = directivesRaw?.keywords ?? directivesRaw?.keyword;
    const keywords = Array.isArray(keywordsRaw)
      ? (keywordsRaw as string[]).filter((k) => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
      : [];
    const taskTypesRaw = directivesRaw?.taskTypes;
    const taskTypes: Record<string, string[]> =
      taskTypesRaw && typeof taskTypesRaw === "object" && !Array.isArray(taskTypesRaw)
        ? Object.fromEntries(
            Object.entries(taskTypesRaw as Record<string, unknown>)
              .map(([k, v]) => {
                if (!Array.isArray(v)) return null;
                const list = (v as string[]).filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
                return list.length > 0 ? [k, list] : null;
              })
              .filter((v): v is [string, string[]] => v !== null),
          )
        : {};
    const retrievalDirectives: RetrievalDirectivesConfig = {
      enabled: directivesRaw?.enabled !== false,
      entityMentioned: directivesRaw?.entityMentioned !== false,
      keywords,
      taskTypes,
      sessionStart: directivesRaw?.sessionStart === true,
      limit:
        typeof directivesRaw?.limit === "number" && directivesRaw.limit > 0
          ? Math.floor(directivesRaw.limit)
          : 3,
      maxPerPrompt:
        typeof directivesRaw?.maxPerPrompt === "number" && directivesRaw.maxPerPrompt > 0
          ? Math.floor(directivesRaw.maxPerPrompt)
          : 4,
    };
    const progressiveMaxCandidates =
      typeof ar.progressiveMaxCandidates === "number" && ar.progressiveMaxCandidates > 0
        ? Math.floor(ar.progressiveMaxCandidates)
        : 15;
    let progressiveIndexMaxTokens: number | undefined =
      typeof ar.progressiveIndexMaxTokens === "number" && ar.progressiveIndexMaxTokens > 0
        ? Math.floor(ar.progressiveIndexMaxTokens)
        : undefined;
    // Default index cap to 300 when using progressive disclosure (keeps index ~150–300 tokens)
    if ((format === "progressive" || format === "progressive_hybrid") && progressiveIndexMaxTokens === undefined) {
      progressiveIndexMaxTokens = 300;
    }
    const progressiveGroupByCategory = ar.progressiveGroupByCategory === true;
    const progressivePinnedRecallCount =
      typeof ar.progressivePinnedRecallCount === "number" && ar.progressivePinnedRecallCount >= 0
        ? Math.floor(ar.progressivePinnedRecallCount)
        : 3;
    const scopeFilterRaw = ar.scopeFilter as Record<string, unknown> | undefined;
    const scopeFilter =
      scopeFilterRaw && typeof scopeFilterRaw === "object" && !Array.isArray(scopeFilterRaw)
        ? {
            userId: typeof scopeFilterRaw.userId === "string" && scopeFilterRaw.userId.trim().length > 0 ? scopeFilterRaw.userId.trim() : undefined,
            agentId: typeof scopeFilterRaw.agentId === "string" && scopeFilterRaw.agentId.trim().length > 0 ? scopeFilterRaw.agentId.trim() : undefined,
            sessionId: typeof scopeFilterRaw.sessionId === "string" && scopeFilterRaw.sessionId.trim().length > 0 ? scopeFilterRaw.sessionId.trim() : undefined,
          }
        : undefined;
    // Auth failure recall config
    const authFailureRaw = ar.authFailure as Record<string, unknown> | undefined;
    const authFailure: AuthFailureRecallConfig = {
      enabled: authFailureRaw?.enabled !== false, // enabled by default
      patterns: Array.isArray(authFailureRaw?.patterns)
        ? (authFailureRaw.patterns as string[]).filter((p) => typeof p === "string" && p.length > 0)
        : [],
      maxRecallsPerTarget: typeof authFailureRaw?.maxRecallsPerTarget === "number" && authFailureRaw.maxRecallsPerTarget >= 0
        ? Math.floor(authFailureRaw.maxRecallsPerTarget)
        : 1,
      includeVaultHints: authFailureRaw?.includeVaultHints !== false,
    };
    return {
      enabled: ar.enabled !== false,
      maxTokens: typeof ar.maxTokens === "number" && ar.maxTokens > 0 ? ar.maxTokens : 800,
      maxPerMemoryChars: typeof ar.maxPerMemoryChars === "number" && ar.maxPerMemoryChars >= 0 ? ar.maxPerMemoryChars : 0,
      injectionFormat: format,
      limit,
      minScore,
      preferLongTerm,
      useImportanceRecency,
      entityLookup,
      retrievalDirectives,
      summaryThreshold,
      summaryMaxChars,
      useSummaryInInjection,
      summarizeWhenOverBudget,
      summarizeModel,
      progressiveMaxCandidates,
      progressiveIndexMaxTokens,
      progressiveGroupByCategory,
      progressivePinnedRecallCount,
      scopeFilter,
      authFailure,
    };
  } else {
    return {
      enabled: arRaw !== false,
      maxTokens: 800,
      maxPerMemoryChars: 0,
      injectionFormat: "full",
      limit: 10,
      minScore: 0.3,
      preferLongTerm: false,
      useImportanceRecency: false,
      entityLookup: { enabled: false, entities: [], maxFactsPerEntity: 2 },
      retrievalDirectives: {
        enabled: true,
        entityMentioned: true,
        keywords: [],
        taskTypes: {},
        sessionStart: false,
        limit: 3,
        maxPerPrompt: 4,
      },
      summaryThreshold: 300,
      summaryMaxChars: 80,
      useSummaryInInjection: true,
      summarizeWhenOverBudget: false,
      summarizeModel: undefined,
      progressiveMaxCandidates: 15,
      progressiveIndexMaxTokens: undefined,
      progressiveGroupByCategory: false,
      progressivePinnedRecallCount: 3,
      authFailure: {
        enabled: true,
        patterns: [],
        maxRecallsPerTarget: 1,
        includeVaultHints: true,
      },
    };
  }
}

export function parseRetrievalConfig(cfg: Record<string, unknown>): RetrievalConfig {
  const retrievalRaw = cfg.retrieval as Record<string, unknown> | undefined;
  const VALID_STRATEGIES = ["semantic", "fts5", "graph"] as const;
  const parsedStrategies =
    Array.isArray(retrievalRaw?.strategies)
      ? (retrievalRaw.strategies as string[]).filter(
          (s): s is "semantic" | "fts5" | "graph" =>
            typeof s === "string" && VALID_STRATEGIES.includes(s as typeof VALID_STRATEGIES[number]),
        )
      : (["semantic", "fts5"] as Array<"semantic" | "fts5" | "graph">);
  return {
    strategies: parsedStrategies.length > 0 ? parsedStrategies : ["semantic", "fts5"],
    rrf_k:
      typeof retrievalRaw?.rrf_k === "number" && retrievalRaw.rrf_k > 0
        ? Math.floor(retrievalRaw.rrf_k)
        : 60,
    ambientBudgetTokens:
      typeof retrievalRaw?.ambientBudgetTokens === "number" && retrievalRaw.ambientBudgetTokens > 0
        ? Math.floor(retrievalRaw.ambientBudgetTokens)
        : 2000,
    explicitBudgetTokens:
      typeof retrievalRaw?.explicitBudgetTokens === "number" && retrievalRaw.explicitBudgetTokens > 0
        ? Math.floor(retrievalRaw.explicitBudgetTokens)
        : 4000,
    graphWalkDepth:
      typeof retrievalRaw?.graphWalkDepth === "number" && retrievalRaw.graphWalkDepth > 0
        ? Math.floor(retrievalRaw.graphWalkDepth)
        : 2,
    semanticTopK:
      typeof retrievalRaw?.semanticTopK === "number" && retrievalRaw.semanticTopK > 0
        ? Math.floor(retrievalRaw.semanticTopK)
        : 20,
    fts5TopK:
      typeof retrievalRaw?.fts5TopK === "number" && retrievalRaw.fts5TopK > 0
        ? Math.floor(retrievalRaw.fts5TopK)
        : 20,
  };
}

export function parseSearchConfig(cfg: Record<string, unknown>): SearchConfig | undefined {
  const searchRaw = cfg.search as Record<string, unknown> | undefined;
  if (!searchRaw || typeof searchRaw !== "object") return undefined;
  return {
    hydeEnabled: searchRaw.hydeEnabled === true,
    hydeModel:
      typeof searchRaw.hydeModel === "string" && searchRaw.hydeModel.trim().length > 0
        ? searchRaw.hydeModel.trim()
        : undefined,
  };
}

export function parseQueryExpansionConfig(cfg: Record<string, unknown>): QueryExpansionConfig {
  const qeRaw = cfg.queryExpansion as Record<string, unknown> | undefined;
  const searchRaw = cfg.search as Record<string, unknown> | undefined;

  // Migration shim: if the legacy search.hydeEnabled flag is set, emit a deprecation warning
  // and auto-enable queryExpansion when it has not been explicitly enabled.
  const hydeEnabled = searchRaw?.hydeEnabled === true;
  const qeExplicitlySet = qeRaw?.enabled !== undefined;

  if (hydeEnabled) {
    console.warn(
      "memory-hybrid: search.hydeEnabled is DEPRECATED — use queryExpansion.enabled instead. " +
      (qeExplicitlySet
        ? "Both are set; queryExpansion config takes precedence. Remove search.hydeEnabled from your config."
        : "Auto-migrating: queryExpansion.enabled has been set to true. Update your config to silence this warning."),
    );
  }

  // queryExpansion.enabled wins when explicitly set; otherwise fall through to HyDE migration
  const enabled = qeExplicitlySet ? qeRaw.enabled === true : hydeEnabled;

  const rawMode = typeof qeRaw?.mode === "string" ? qeRaw.mode.trim() : "";
  const parsedMode =
    rawMode === "always" || rawMode === "conditional" || rawMode === "off"
      ? rawMode
      : undefined;

  const mode: "always" | "conditional" | "off" =
    !enabled ? "off" : (parsedMode ?? "always");

  const threshold =
    typeof qeRaw?.threshold === "number" && qeRaw.threshold >= 0 && qeRaw.threshold <= 1
      ? qeRaw.threshold
      : 0.03;

  // queryExpansion.model wins when set; fall back to search.hydeModel when model is missing and expansion is enabled (migration compat)
  const hydeModel =
    typeof searchRaw?.hydeModel === "string" && searchRaw.hydeModel.trim().length > 0
      ? searchRaw.hydeModel.trim()
      : undefined;
  const model =
    typeof qeRaw?.model === "string" && qeRaw.model.trim().length > 0
      ? qeRaw.model.trim()
      : (enabled ? hydeModel : undefined);

  const maxVariants =
    typeof qeRaw?.maxVariants === "number" && qeRaw.maxVariants > 0
      ? Math.min(10, Math.floor(qeRaw.maxVariants))
      : 4;

  const cacheSize =
    typeof qeRaw?.cacheSize === "number" && qeRaw.cacheSize > 0
      ? Math.floor(qeRaw.cacheSize)
      : 100;

  // When auto-migrating from search.hydeEnabled, preserve the original 25s timeout for pure legacy
  // migrations (i.e. no queryExpansion key in the merged config, including via preset). Once a preset
  // or explicit queryExpansion config is present, the new 15s default applies — this is intentional
  // because the new QE path has its own minimum floor enforcement (#384).
  const defaultTimeout = (hydeEnabled && !qeExplicitlySet) ? 25000 : 15000;

  const rawQeTimeoutRaw = qeRaw?.timeoutMs;
  // Treat 0 or negative as an explicit "no config-level floor" bypass: caller receives undefined
  // and chatComplete falls back to its own internal default timeout. Use Number.isFinite to reject
  // Infinity (which would pass > 0 but cannot be safely used with setTimeout).
  if (typeof rawQeTimeoutRaw === "number" && rawQeTimeoutRaw <= 0) {
    return {
      enabled,
      mode,
      threshold,
      model,
      maxVariants,
      cacheSize,
      timeoutMs: undefined,
    };
  }

  const rawQeTimeout = typeof rawQeTimeoutRaw === "number" && Number.isFinite(rawQeTimeoutRaw) && rawQeTimeoutRaw > 0
    ? Math.floor(rawQeTimeoutRaw)
    : null;

  if (rawQeTimeout !== null && rawQeTimeout < MIN_QE_TIMEOUT_MS) {
    console.warn(
      `memory-hybrid: queryExpansion.timeoutMs=${rawQeTimeout} is below the minimum floor of ${MIN_QE_TIMEOUT_MS}ms` +
      ` and has been raised to ${MIN_QE_TIMEOUT_MS}ms to prevent spurious timeouts on thinking models (#384).` +
      ` Set timeoutMs to 0 or a negative value to bypass the floor entirely.`,
    );
  }

  return {
    enabled,
    mode,
    threshold,
    model,
    maxVariants,
    cacheSize,
    timeoutMs: rawQeTimeout !== null ? Math.max(MIN_QE_TIMEOUT_MS, rawQeTimeout) : defaultTimeout,
  };
}

export function parseRerankingConfig(cfg: Record<string, unknown>): RerankingConfig {
  const rrRaw = cfg.reranking as Record<string, unknown> | undefined;

  const enabled = rrRaw?.enabled === true;
  const model = typeof rrRaw?.model === "string" && rrRaw.model.trim().length > 0 ? rrRaw.model.trim() : undefined;
  const candidateCount =
    typeof rrRaw?.candidateCount === "number" && rrRaw.candidateCount > 0
      ? Math.floor(rrRaw.candidateCount)
      : 50;
  const outputCount =
    typeof rrRaw?.outputCount === "number" && rrRaw.outputCount > 0
      ? Math.floor(rrRaw.outputCount)
      : 20;

  const rawRerankTimeoutRaw = rrRaw?.timeoutMs;
  // Treat 0 or negative as an explicit "no config-level floor" bypass: caller receives undefined
  // and chatComplete falls back to its own internal default timeout. Use Number.isFinite to reject
  // Infinity (which would pass > 0 but cannot be safely used with setTimeout).
  if (typeof rawRerankTimeoutRaw === "number" && rawRerankTimeoutRaw <= 0) {
    return {
      enabled,
      model,
      candidateCount,
      outputCount,
      timeoutMs: undefined,
    };
  }
  const rawRerankTimeout = typeof rawRerankTimeoutRaw === "number" && Number.isFinite(rawRerankTimeoutRaw) && rawRerankTimeoutRaw > 0
    ? Math.floor(rawRerankTimeoutRaw)
    : null;
  if (rawRerankTimeout !== null && rawRerankTimeout < MIN_RERANK_TIMEOUT_MS) {
    console.warn(
      `memory-hybrid: reranking.timeoutMs=${rawRerankTimeout} is below the minimum floor of ${MIN_RERANK_TIMEOUT_MS}ms` +
      ` and has been raised to ${MIN_RERANK_TIMEOUT_MS}ms to prevent spurious timeouts (#384).` +
      ` Set timeoutMs to 0 or a negative value to bypass the floor entirely.`,
    );
  }
  return {
    enabled,
    model,
    candidateCount,
    outputCount,
    timeoutMs: rawRerankTimeout !== null ? Math.max(MIN_RERANK_TIMEOUT_MS, rawRerankTimeout) : 10000,
  };
}

export function parseContextualVariantsConfig(cfg: Record<string, unknown>): ContextualVariantsConfig {
  const cvRaw = cfg.contextualVariants as Record<string, unknown> | undefined;
  return {
    enabled: cvRaw?.enabled === true,
    model: typeof cvRaw?.model === "string" && cvRaw.model.trim().length > 0 ? cvRaw.model.trim() : undefined,
    maxVariantsPerFact:
      typeof cvRaw?.maxVariantsPerFact === "number" && cvRaw.maxVariantsPerFact > 0
        ? Math.min(5, Math.floor(cvRaw.maxVariantsPerFact))
        : 2,
    maxPerMinute:
      typeof cvRaw?.maxPerMinute === "number" && cvRaw.maxPerMinute > 0
        ? Math.floor(cvRaw.maxPerMinute)
        : 30,
    categories:
      Array.isArray(cvRaw?.categories) && (cvRaw.categories as unknown[]).length > 0
        ? (cvRaw.categories as unknown[]).filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        : undefined,
  };
}
