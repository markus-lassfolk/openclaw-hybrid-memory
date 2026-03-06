export * from "./core.js";
export * from "./retrieval.js";
export * from "./capture.js";
export * from "./maintenance.js";
export * from "./features.js";
export * from "./agents.js";

// Re-export all types from domain files and define HybridMemoryConfig and other shared types

import type {
  AutoRecallConfig,
  AutoClassifyConfig,
  SearchConfig,
  RetrievalConfig,
  QueryExpansionConfig,
  RerankingConfig,
  ContextualVariantsConfig,
} from "./retrieval.js";

import type {
  StoreConfig,
  WALConfig,
  PathConfig,
} from "./core.js";

import type {
  PassiveObserverConfig,
  ReflectionConfig,
  ProceduresConfig,
  ExtractionConfig,
} from "./capture.js";

import type {
  VerificationConfig,
  ProvenanceConfig,
  NightlyCycleConfig,
  HealthConfig,
  MaintenanceConfig,
} from "./maintenance.js";

import type {
  GraphConfig,
  GraphRetrievalConfig,
  ClustersConfig,
  GapsConfig,
  AliasesConfig,
  IngestConfig,
  MemoryTieringConfig,
  AmbientConfig,
  ReinforcementConfig,
  FutureDateProtectionConfig,
  DocumentsConfig,
} from "./features.js";

import type {
  MultiAgentConfig,
  PersonaProposalsConfig,
  MemoryToSkillsConfig,
} from "./agents.js";

/** Tier for cron job model selection: "default" = standard, "heavy" = larger context/reasoning. */
/** "nano" = ultra-cheap for high-frequency ops (autoClassify, HyDE, classifyBeforeWrite, summarize); falls back to "default" when unset. */
export type CronModelTier = "default" | "heavy" | "nano";

/**
 * Per-provider API credentials for direct LLM calls (bypasses the gateway agent endpoint).
 * Built-in defaults: google uses distill.apiKey + Gemini OpenAI-compat endpoint; openai uses embedding.apiKey.
 */
export type LLMProviderConfig = {
  /** API key for this provider. Overrides built-in defaults (distill.apiKey for google, embedding.apiKey for openai). */
  apiKey?: string;
  /** OpenAI-compatible base URL. Overrides built-in defaults. */
  baseURL?: string;
};

/** LLM model preference: ordered lists per tier with direct provider API calls. */
export type LLMConfig = {
  /** Internal: set to "gateway" when auto-derived from agents.defaults.model; undefined when from plugin config. */
  _source?: "gateway";
  /** Ordered preference for default-tier LLM calls (first available wins). */
  default: string[];
  /** Ordered preference for heavy-tier LLM calls (e.g. distill, spawn). */
  heavy: string[];
  /**
   * Optional: ordered model list for nano/ultra-light ops — autoClassify, HyDE, classifyBeforeWrite, auto-recall summarize.
   * These run on every chat message or write, so cheapness matters most.
   * When not set, falls back to the default tier.
   * Ideal models: openai/gpt-4.1-nano, google/gemini-2.0-flash-lite, anthropic/claude-haiku-*.
   */
  nano?: string[];
  /** When true, if all preferred models fail, try the fallback model. */
  fallbackToDefault?: boolean;
  /** When fallbackToDefault is true, this model is tried last. */
  fallbackModel?: string;
  /**
   * Per-provider API config for direct LLM calls.
   * Keys are provider prefixes as they appear in model IDs (e.g. "google", "openai", "anthropic").
   * Built-in providers (google, openai) have defaults; others require explicit apiKey + baseURL.
   * Example: { google: { apiKey: "AIzaSy..." }, anthropic: { apiKey: "sk-ant-...", baseURL: "https://api.anthropic.com/v1" } }
   */
  providers?: Record<string, LLMProviderConfig | undefined>;
};

/** Minimal plugin config shape for resolving cron job model (no full parse). */
export type CronModelConfig = {
  embedding?: { apiKey?: string };
  distill?: { apiKey?: string; defaultModel?: string; fallbackModels?: string[] };
  reflection?: { model?: string };
  /** Optional: when present, use for cron LLM (e.g. Claude). */
  claude?: { apiKey?: string; defaultModel?: string };
  /** Optional: gateway-routed LLM preference lists (issue #87). When set, overrides provider-based resolution. */
  llm?: LLMConfig;
};

/** Credential types supported by the credentials store */
export const CREDENTIAL_TYPES = [
  "token",
  "password",
  "api_key",
  "ssh",
  "bearer",
  "other",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** Auto-capture configuration for credential scanning from tool call inputs */
export type CredentialAutoCaptureConfig = {
  /** Enable scanning of tool call inputs for credential patterns (default: false, opt-in) */
  toolCalls: boolean;
  /**
   * Pattern set to use: "builtin" uses the built-in regex set (default: "builtin").
   * Custom patterns are not currently supported but reserved for future extension.
   */
  patterns?: "builtin";
  /** Emit info-level log on each capture (default: true) */
  logCaptures?: boolean;
  /** When true, only store when a credential pattern matched (reject value-only extraction). Default false. */
  requirePatternMatch?: boolean;
};

/** Opt-in credentials: structured, encrypted storage for API keys, tokens, etc. */
export type CredentialsConfig = {
  enabled: boolean;
  store: "sqlite";
  /** Encryption key: "env:VAR_NAME" resolves from env, or raw string (not recommended) */
  encryptionKey: string;
  /** When enabled, detect credential patterns in conversation and prompt to store (default false) */
  autoDetect?: boolean;
  /** Auto-capture credentials from tool call inputs (default: disabled) */
  autoCapture?: CredentialAutoCaptureConfig;
  /** Days before expiry to warn (default 7) */
  expiryWarningDays?: number;
};

/** Error reporting configuration for GlitchTip/Sentry integration (opt-in, privacy-first) */
export type ErrorReportingConfig = {
  enabled: boolean;
  /** DSN for self-hosted mode. Not required in schema (only at runtime for self-hosted). */
  dsn?: string;
  consent: boolean;
  /** "community" (default): use hardcoded community DSN. "self-hosted": require custom DSN. */
  mode: "community" | "self-hosted";
  environment?: string;
  sampleRate?: number;
  /** Optional UUID identifying this bot instance; sent as tag so GlitchTip can group errors by bot. */
  botId?: string;
  /** Optional friendly name for this bot (e.g. Maeve, Doris); sent as tag for readable reports. */
  botName?: string;
};

/** Configuration for a single embedding model in a multi-model setup (Issue #158). */
export interface EmbeddingModelConfig {
  /** Model identifier (e.g. "nomic-embed-text", "text-embedding-3-small"). */
  name: string;
  /** Provider for this model. */
  provider: "openai" | "ollama" | "onnx";
  /** Vector dimensions this model produces. */
  dimensions: number;
  /** Semantic role this model plays. */
  role: "general" | "domain" | "query" | "custom";
  /** API key for openai provider (overrides embedding.apiKey). */
  apiKey?: string;
  /** Endpoint for ollama provider (overrides embedding.endpoint). */
  endpoint?: string;
  /** Whether this model is active (default: true). */
  enabled?: boolean;
}

/** Configuration for LanceDB vector store behaviour (issue #128). */
export type VectorConfig = {
  /**
   * When true, automatically drop and recreate the LanceDB table if its vector dimension
   * doesn't match the configured embedding model dimension.
   * After repair, existing facts from SQLite are re-embedded automatically.
   * Default: false (log the mismatch and return empty results instead of throwing).
   */
  autoRepair: boolean;
};

/** Active task working memory: ACTIVE-TASK.md persistence and session injection */
export type ActiveTaskConfig = {
  /** Enable active task working memory (default: true) */
  enabled: boolean;
  /** Path to ACTIVE-TASK.md (default: "ACTIVE-TASK.md" in workspace root) */
  filePath: string;
  /** Auto-write task entries on subagent spawn/complete events (default: true) */
  autoCheckpoint: boolean;
  /** Max tokens for session-start injection (default: 500) */
  injectionBudget: number;
  /**
   * Duration before flagging a task as stale. Supports human-friendly strings:
   * "24h", "1d", "1d12h30m", "45m", or a plain integer (treated as minutes).
   * Default: "24h".
   *
   * Legacy `staleHours: number` is automatically converted on config load.
   */
  staleThreshold: string;
  /** Flush task summary to memory/YYYY-MM-DD.md on completion (default: true) */
  flushOnComplete: boolean;
  /** Stale-task warning injection at session start */
  staleWarning: {
    /** Inject stale task warnings into context on before_agent_start (default: true) */
    enabled: boolean;
  };
};

/** Self-correction pipeline: semantic dedup, TOOLS.md sectioning, auto-rewrite vs approve */
export type SelfCorrectionConfig = {
  /** Use embedding similarity to skip near-duplicate facts before MEMORY_STORE (default: true). */
  semanticDedup: boolean;
  /** Similarity threshold for semantic dedup, 0–1 (default: 0.92). */
  semanticDedupThreshold: number;
  /** TOOLS.md section heading for new rules, e.g. "Self-correction rules" (default: "Self-correction rules"). */
  toolsSection: string;
  /** When true (default), insert suggested TOOLS rules under toolsSection. Set false to only suggest in report (then use --approve to apply). */
  applyToolsByDefault: boolean;
  /** When true, LLM rewrites TOOLS.md to integrate new rules (no duplicates/contradictions). When false, use section insert (or suggest if applyToolsByDefault is false) (default: false). */
  autoRewriteTools: boolean;
  /** When true and incident count > spawnThreshold, run Phase 2 via `openclaw sessions spawn --model <model>` for large context. Model is chosen from config (Gemini/OpenAI/Claude) when spawnModel is empty (default: false). */
  analyzeViaSpawn: boolean;
  /** Use spawn for Phase 2 when incidents exceed this count (default: 15). */
  spawnThreshold: number;
  /** Model for spawn when analyzeViaSpawn is true. Empty = use provider default from config (see getDefaultCronModel). */
  spawnModel: string;
};

/** Configuration mode presets. See docs/CONFIGURATION-MODES.md. */
export type ConfigMode = "essential" | "normal" | "expert" | "full";

export type MemoryCategory = string;

export type HybridMemoryConfig = {
  embedding: {
    provider: "openai" | "ollama" | "onnx";
    model: string;
    /** Required for openai provider; optional for ollama/onnx. */
    apiKey?: string;
    /** Optional ordered preference list (openai gateway fallback). First model defines vector dimension; all must have same dimension. */
    models?: string[];
    /** Vector dimensions for this model (required for ollama/onnx; auto-resolved for known openai models). */
    dimensions: number;
    /** Ollama endpoint URL (default: http://localhost:11434). Only used when provider='ollama'. */
    endpoint?: string;
    /** Number of texts to embed per batch call (default: 50). */
    batchSize: number;
    /**
     * Additional embedding models for multi-model support (Issue #158).
     * When non-empty, facts are embedded with all models and stored in the fact_embeddings table.
     * At retrieval time, all model indices are queried and results are merged via RRF.
     * When empty/undefined, the system works in single-model mode (backward compatible).
     */
    multiModels?: EmbeddingModelConfig[];
  };
  lanceDbPath: string;
  sqlitePath: string;
  autoCapture: boolean;
  autoRecall: AutoRecallConfig;
  /** Max characters per captured/stored fact (filter and truncation). Default 5000. */
  captureMaxChars: number;
  categories: string[];
  autoClassify: AutoClassifyConfig;
  /** Store options (2.3): fuzzyDedupe = skip store when normalized text matches existing. */
  store: StoreConfig;
  /** Opt-in credential management: structured, encrypted storage (default: disabled) */
  credentials: CredentialsConfig;
  /** Graph-based spreading activation: auto-linking and graph traversal */
  graph: GraphConfig;
  /** Write-Ahead Log for crash resilience (default: enabled) */
  wal: WALConfig;
  /** Opt-in persona proposals: agent self-evolution with human approval (default: disabled) */
  personaProposals: PersonaProposalsConfig;
  /** Passive observer — background fact extraction from session transcripts (default: disabled) */
  passiveObserver: PassiveObserverConfig;
  /** Reflection layer — synthesize behavioral patterns from facts (default: disabled) */
  reflection: ReflectionConfig;
  /** Procedural memory — procedure tagging and auto-skills (default: enabled) */
  procedures: ProceduresConfig;
  /** Multi-pass extraction with LLM verification (Issue #166, default: disabled). */
  extraction: ExtractionConfig;
  /** Memory-to-skills: synthesize skill drafts from clustered procedures (default: enabled when procedures enabled) */
  memoryToSkills: MemoryToSkillsConfig;
  /** Dynamic memory tiering — hot/warm/cold (default: enabled) */
  memoryTiering: MemoryTieringConfig;
  /** Optional: LLM preference lists and per-provider API config for direct chat calls (issue #87). */
  llm?: LLMConfig;
  /** Optional: Gemini for distill (1M context). apiKey/defaultModel deprecated in favor of llm + gateway. */
  distill?: {
    apiKey?: string;
    defaultModel?: string;
    /** Fallback models to try if primary model fails after retries (optional). Deprecated: use llm.default/heavy. */
    fallbackModels?: string[];
    /** Enable directive extraction from sessions (default: true). */
    extractDirectives?: boolean;
    /** Enable reinforcement extraction from sessions (default: true). */
    extractReinforcement?: boolean;
    /** Reinforcement boost added to facts search score (default: 0.1). */
    reinforcementBoost?: number;
    /** Phase 2: Reinforcement boost added to procedures search score (default: 0.1). */
    reinforcementProcedureBoost?: number;
    /** Phase 2: Number of reinforcements to trigger auto-promotion of procedures (default: 2). */
    reinforcementPromotionThreshold?: number;
  };
  /** Auto-build multilingual keywords from memory (default: enabled). Run at first startup if no file, then weekly. */
  languageKeywords: { autoBuild: boolean; weeklyIntervalDays: number };
  /** Optional: ingest workspace markdown files as facts (skills, TOOLS.md, etc.) */
  ingest?: IngestConfig;
  /** Optional: search tweaks (HyDE query expansion) */
  search?: SearchConfig;
  /** Multi-strategy RRF retrieval pipeline configuration (Issue #152). */
  retrieval: RetrievalConfig;
  /** Optional: self-correction analysis — semantic dedup, TOOLS sectioning, auto-rewrite, spawn */
  selfCorrection?: SelfCorrectionConfig;
  /** Multi-agent memory scoping — dynamic agent detection and scope defaults (default: orchestratorId="main", defaultStoreScope="global") */
  multiAgent: MultiAgentConfig;
  /** Error reporting to GlitchTip/Sentry (opt-out, default: enabled with community DSN). Set enabled: false or consent: false to opt out. */
  errorReporting: ErrorReportingConfig;
  /** Active task working memory — ACTIVE-TASK.md persistence and session injection (default: enabled) */
  activeTask: ActiveTaskConfig;
  /** Vector store configuration (LanceDB schema validation and auto-repair, issue #128). */
  vector: VectorConfig;
  /** Enhanced ambient retrieval with multi-query generation (Issue #156, default: disabled). */
  ambient: AmbientConfig;
  /** GraphRAG retrieval: semantic search + graph expansion (Issue #145, default: enabled, defaultExpand: false). */
  graphRetrieval: GraphRetrievalConfig;
  /** Future-date decay freeze protection (#144). Enabled by default. */
  futureDateProtection: FutureDateProtectionConfig;
  /** Maintenance tasks: monthly review, consolidation, etc. */
  maintenance: MaintenanceConfig;
  /** Nightly dream cycle: automated prune → consolidate → reflect (Issue #143, default: disabled). */
  nightlyCycle: NightlyCycleConfig;
  /** Confidence reinforcement on repeated mentions (Issue #147, default: enabled). */
  reinforcement: ReinforcementConfig;
  /** Topic cluster detection: BFS connected-component analysis on memory_links (Issue #146). */
  clusters: ClustersConfig;
  /** Memory health dashboard (Issue #148, default: enabled). */
  health: HealthConfig;
  /** Knowledge gap analysis — orphan/weak detection and suggested links (Issue #141, default: enabled). */
  gaps: GapsConfig;
  /** Multi-hook retrieval aliases: generate and index alternative phrasings per fact (Issue #149, default: disabled). */
  aliases: AliasesConfig;
  /** Shortest-path traversal between memories via BFS (Issue #140, default: enabled). */
  path: PathConfig;
  /** Document ingestion via MarkItDown Python bridge (Issue #206, default: disabled). */
  documents: DocumentsConfig;
  /** Contextual variant generation at index time (Issue #159, default: disabled). */
  contextualVariants: ContextualVariantsConfig;
  /** Query expansion via LLM at retrieval time (Issue #160, default: disabled). */
  queryExpansion: QueryExpansionConfig;
  /** LLM re-ranking of RRF fusion results (Issue #161, default: disabled). */
  reranking: RerankingConfig;
  /** Verification store for critical facts (Issue #162, default: disabled). */
  verification: VerificationConfig;
  /** Provenance tracing for fact-to-source chains (Issue #163, default: disabled). */
  provenance: ProvenanceConfig;
  /** Set when user specified a mode in config; used by verify to show "Mode: Normal" etc. */
  mode?: ConfigMode | "custom";
};
