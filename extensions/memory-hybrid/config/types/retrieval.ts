/** Auto-recall injection line format: full = [backend/category] text, short = category: text, minimal = text only, progressive = memory index (agent fetches on demand), progressive_hybrid = pinned in full + rest as index */
export type AutoRecallInjectionFormat = "full" | "short" | "minimal" | "progressive" | "progressive_hybrid";

export type AutoClassifyConfig = {
  enabled: boolean;
  model?: string; // when unset, runtime uses getDefaultCronModel(cfg, "nano")
  batchSize: number; // facts per LLM call (default 20)
  /** When true, LLM can suggest new categories from "other" facts; labels with at least minFactsForNewCategory become real categories (default true) */
  suggestCategories?: boolean;
  /** Minimum facts with the same suggested label before we create that category (default 10). Not told to the LLM. */
  minFactsForNewCategory?: number;
};

/** Entity-centric recall: when prompt mentions an entity from the list, merge lookup(entity) facts into candidates */
export type EntityLookupConfig = {
  enabled: boolean;
  entities: string[]; // e.g. ["user", "owner", "decision"]; prompt matched case-insensitively
  maxFactsPerEntity: number; // max facts to merge per matched entity (default 2)
};

/** Auto-recall on authentication failures (reactive memory trigger) */
export type AuthFailureRecallConfig = {
  enabled: boolean;
  /** Auth failure patterns to detect (regex strings). Default includes SSH, HTTP 401/403, API key errors. */
  patterns: string[];
  /** Max recalls per target per session (dedup to avoid spam). Default: 1. */
  maxRecallsPerTarget: number;
  /** Inject credentials as system hint even if they were stored in the vault. Default: true. */
  includeVaultHints: boolean;
};

/** Targeted recall directives (trigger memory_recall alongside semantic auto-recall). */
export type RetrievalDirectivesConfig = {
  enabled: boolean;
  /** When prompt mentions a configured entity, run targeted recall for that entity. */
  entityMentioned: boolean;
  /** Keyword triggers to run targeted recall (case-insensitive substring match). */
  keywords: string[];
  /** Task-type triggers: map task type → keywords that activate it. */
  taskTypes: Record<string, string[]>;
  /** When true, run a one-time session-start recall. */
  sessionStart: boolean;
  /** Max results per directive (default: 3). */
  limit: number;
  /** Max directive matches per prompt (default: 4). */
  maxPerPrompt: number;
};

/** Auto-recall: enable/disable plus token cap, format, limit, minScore, preferLongTerm, importance/recency, entity lookup, summary, progressive options */
export type AutoRecallConfig = {
  enabled: boolean;
  maxTokens: number;
  maxPerMemoryChars: number;
  injectionFormat: AutoRecallInjectionFormat;
  limit: number;
  minScore: number;
  preferLongTerm: boolean;
  useImportanceRecency: boolean;
  entityLookup: EntityLookupConfig;
  /** Targeted recall directives (entity mention, keyword, task type, session start). */
  retrievalDirectives: RetrievalDirectivesConfig;
  summaryThreshold: number; // facts longer than this get a summary stored; 0 = disabled (default 300)
  summaryMaxChars: number; // summary length when generated (default 80)
  useSummaryInInjection: boolean; // inject summary instead of full text when present (default true)
  summarizeWhenOverBudget: boolean; // when token cap forces dropping memories, LLM-summarize all into 2-3 sentences (1.4)
  summarizeModel?: string; // when unset, runtime uses getDefaultCronModel(cfg, "nano")
  /** Max candidates for progressive index (default 15). Only when injectionFormat is progressive or progressive_hybrid. */
  progressiveMaxCandidates?: number;
  /** Max tokens for the index block in progressive mode (default: 300 when injectionFormat is progressive or progressive_hybrid). */
  progressiveIndexMaxTokens?: number;
  /** Group index lines by category (e.g. "Preferences (3):") for readability (default false). */
  progressiveGroupByCategory?: boolean;
  /** Min recall count or permanent decay to treat as "pinned" in progressive_hybrid (default 3). */
  progressivePinnedRecallCount?: number;
  /** Scope filter for auto-recall (userId, agentId, sessionId). When set, only global + matching scopes are injected. */
  scopeFilter?: { userId?: string; agentId?: string; sessionId?: string };
  /** Auto-recall on authentication failures (reactive trigger after tool results) */
  authFailure: AuthFailureRecallConfig;
  /** Phase 2.1: Hard degradation. When main-lane queue depth > this value, use FTS-only + HOT facts and set degraded flag. 0 = disabled. Default 10. */
  degradationQueueDepth?: number;
  /** Phase 2.1: Hard degradation. When recall latency (ms) exceeds this value, use FTS-only + HOT and set degraded. 0 = disabled. Default 5000. */
  degradationMaxLatencyMs?: number;
};

/** Multi-strategy retrieval pipeline configuration (Issue #152: RRF scoring pipeline). */
export type RetrievalConfig = {
  /** Active retrieval strategies (default: ["semantic", "fts5"]; "graph" is accepted but is a no-op stub until #145 is complete). */
  strategies: Array<"semantic" | "fts5" | "graph">;
  /** RRF k constant (default 60). Higher = less rank-position sensitivity. */
  rrf_k: number;
  /** Token budget for ambient (auto-recall) context injection (default 2000). */
  ambientBudgetTokens: number;
  /** Token budget for explicit (tool call) context injection (default 4000). */
  explicitBudgetTokens: number;
  /** Max hops for graph walk spreading activation (default 2). Used when #145 is implemented. */
  graphWalkDepth: number;
  /** Top-K candidates from semantic search passed to RRF (default 20). */
  semanticTopK: number;
  /** Top-K candidates from FTS5 search passed to RRF (default 20). Independent of semanticTopK. */
  fts5TopK: number;
};

/** Search options: HyDE query expansion
 * @deprecated Use `queryExpansion` config instead. `search.hydeEnabled` and `search.hydeModel`
 * will be removed in the next major version. A migration shim auto-enables `queryExpansion`
 * when `search.hydeEnabled` is set; update your config to silence the deprecation warning.
 */
export type SearchConfig = {
  /** Generate hypothetical answer before embedding for vector search (default false)
   * @deprecated Use `queryExpansion.enabled` instead. Will be removed in next major version. */
  hydeEnabled: boolean;
  /** Model for HyDE generation; when unset uses llm.default / legacy default (issue #92)
   * @deprecated Use `queryExpansion.model` instead. Will be removed in next major version. */
  hydeModel?: string;
};

/** Query expansion at retrieval time via LLM (Issue #160). */
export type QueryExpansionConfig = {
  /** Enable query expansion (default: false). */
  enabled: boolean;
  /** Expansion mode: always run LLM, conditional for threshold-based LLM, or off (default: "always" when enabled). */
  mode?: "always" | "conditional" | "off";
  /** Score threshold for conditional mode (default: 0.03). */
  threshold?: number;
  /** LLM model for expansion; when unset, defaults to "openai/gpt-4.1-nano". */
  model?: string;
  /** Max number of expansion variants to generate (default: 4). */
  maxVariants: number;
  /** LRU cache size for memoized expansions (default: 100). */
  cacheSize: number;
  /**
   * Timeout in ms for the LLM call; on timeout, fall back to original query (default: 15000).
   * A minimum floor of 10 000 ms is enforced to prevent spurious timeouts on thinking models (#384).
   * Set to `0` or a negative value in config to bypass the floor (chatComplete uses its own default).
   * `undefined` here means "no config-level timeout" — chatComplete uses its internal default.
   */
  timeoutMs: number | undefined;
};

/** LLM re-ranking of RRF fusion results (Issue #161). */
export type RerankingConfig = {
  /** Enable LLM re-ranking (default: false). */
  enabled: boolean;
  /** LLM model for re-ranking; when unset, defaults to "openai/gpt-4.1-nano". */
  model?: string;
  /** Number of top RRF candidates to present to the LLM for re-ranking (default: 50). */
  candidateCount: number;
  /** Number of results to return after re-ranking (default: 20). */
  outputCount: number;
  /**
   * Timeout in ms for the LLM call; on timeout, fall back to original RRF order (default: 10000).
   * A minimum floor of 5 000 ms is enforced to prevent spurious timeouts (#384).
   * Set to `0` or a negative value in config to bypass the floor (chatComplete uses its own default).
   * `undefined` here means "no config-level timeout" — chatComplete uses its internal default.
   */
  timeoutMs: number | undefined;
};

/** Contextual variant generation at index time (Issue #159). */
export type ContextualVariantsConfig = {
  /** Enable contextual variant generation (default: false). */
  enabled: boolean;
  /** LLM model for variant generation; when unset, defaults to "openai/gpt-4.1-nano". */
  model?: string;
  /** Max variants generated per fact (default: 2). */
  maxVariantsPerFact: number;
  /** Rate limit: max LLM calls per minute (default: 30). */
  maxPerMinute: number;
  /** When set, only generate variants for facts in these categories (null/empty = all). */
  categories?: string[];
};
