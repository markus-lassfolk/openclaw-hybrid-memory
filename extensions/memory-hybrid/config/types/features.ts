/** Graph-based spreading activation: auto-linking and traversal settings */
export type GraphConfig = {
  enabled: boolean;
  autoLink: boolean;            // Auto-create RELATED_TO links during storage
  autoLinkMinScore: number;     // Min similarity score for auto-linking (default 0.7)
  autoLinkLimit: number;        // Max similar facts to link per storage (default 3)
  maxTraversalDepth: number;    // Max hops for graph traversal in recall (default 2)
  useInRecall: boolean;         // Enable graph traversal in memory_recall (default true)
  /** Weight for temporal co-occurrence RELATES_TO edges (default 0.3) */
  coOccurrenceWeight: number;
  /** When true, auto-create SUPERSEDES edge + supersede old fact when entity+key conflict detected (default true) */
  autoSupersede: boolean;
};

/** GraphRAG retrieval configuration (Issue #145). */
export type GraphRetrievalConfig = {
  /** Enable GraphRAG expansion in memory_recall (default: true). */
  enabled: boolean;
  /** When true, memory_recall expands the graph by default even without expandGraph=true (default: false — backward compatible). */
  defaultExpand: boolean;
  /** Maximum BFS depth cap — expandDepth param is clamped to this value (default: 3). */
  maxExpandDepth: number;
  /** Maximum number of graph-expanded results appended to direct matches (default: 20). */
  maxExpandedResults: number;
};

/** Topic cluster detection configuration (Issue #146). */
export type ClustersConfig = {
  /** Enable topic cluster detection (default: true). */
  enabled: boolean;
  /** Minimum number of facts to form a cluster (default: 3). */
  minClusterSize: number;
  /** Reserved: Days between full re-cluster runs; 0 = disabled (default: 7). Currently not used by any automatic scheduling. */
  refreshIntervalDays: number;
  /** Reserved: Model for label generation; null = rule-based only (default: null). Currently not passed to detectClusters. */
  labelModel: string | null;
};

/** Knowledge gap analysis configuration (Issue #141). */
export type GapsConfig = {
  /** Enable the memory_gaps tool (default: true when graph is enabled). */
  enabled: boolean;
  /** Minimum cosine similarity to suggest a missing link (default: 0.8). */
  similarityThreshold: number;
};

/** Multi-hook retrieval aliases (Issue #149). */
export type AliasesConfig = {
  /** Enable alias generation and embedding search (default: false). */
  enabled: boolean;
  /** Maximum aliases per fact (default: 5). */
  maxAliases: number;
  /** Model for alias generation; when unset, runtime uses getDefaultCronModel(cfg, "nano"). */
  model?: string;
};

/** Ingest workspace files: index markdown files as facts for search */
export type IngestConfig = {
  /** Glob patterns relative to workspace (e.g. ["skills/**\/*.md", "TOOLS.md"]) */
  paths: string[];
  /** Chunk size in characters for LLM extraction (default 800) */
  chunkSize: number;
  /** Overlap between chunks (default 100) */
  overlap: number;
};

/** Dynamic memory tiering (hot/warm/cold). */
export type MemoryTieringConfig = {
  enabled: boolean;
  /** Max tokens for HOT tier always loaded at session start (default: 2000). */
  hotMaxTokens: number;
  /** Run compaction on agent_end (default: true). */
  compactionOnSessionEnd: boolean;
  /** Days without access to treat preference as inactive -> warm (default: 7). */
  inactivePreferenceDays: number;
  /** Cap HOT tier to this many facts when promoting blockers (default: 50). */
  hotMaxFacts: number;
};

/** Enhanced ambient retrieval with multi-query generation (Issue #156). */
export type AmbientConfig = {
  /** Enable enhanced ambient retrieval (default: false). */
  enabled: boolean;
  /** When true, generate 2-4 queries per trigger instead of one (default: false). */
  multiQuery: boolean;
  /** Cosine distance threshold for topic-shift detection, 0–1 (default: 0.4). */
  topicShiftThreshold: number;
  /** Max implicit queries generated per retrieval trigger, capped at 4 (default: 4). */
  maxQueriesPerTrigger: number;
  /** Token budget for ambient context injection (default: 2000). */
  budgetTokens: number;
};

/** Confidence reinforcement on repeated mentions (Issue #147). */
export type ReinforcementConfig = {
  /** Enable confidence reinforcement (default: true). */
  enabled: boolean;
  /** Confidence delta applied when a semantically similar fact is stored again (default: 0.1). */
  passiveBoost: number;
  /** Confidence delta applied when a fact is retrieved via memory_recall (default: 0.05). */
  activeBoost: number;
  /** Upper cap for confidence after reinforcement (default: 1.0). */
  maxConfidence: number;
  /** Cosine similarity threshold above which a new fact is treated as a repeat of an existing one (default: 0.85). */
  similarityThreshold: number;
  /** Max reinforcement events to store per fact before FIFO eviction (default: 50). */
  maxEventsPerFact?: number;
  /** Weight applied to diversity score when calculating effective boost (default: 1.0). */
  diversityWeight?: number;
  /** When false, skip storing context columns (query_snippet, topic, etc.) per event (default: true). */
  trackContext?: boolean;
  /** Base boost amount before diversity weighting is applied (default: 1.0). */
  boostAmount?: number;
};

/** Future-date decay freeze protection (#144). */
export type FutureDateProtectionConfig = {
  /** When true, facts containing future dates have their decay frozen until that date passes. Default: true. */
  enabled: boolean;
  /** Maximum days to freeze decay (prevents absurdly long freezes). 0 = no limit. Default: 365. */
  maxFreezeDays: number;
};

/** Workflow tracking: structured tool-sequence capture and pattern learning (Issue #209). */
export type WorkflowTrackingConfig = {
  /** Enable workflow trace recording (default: false — opt-in). */
  enabled: boolean;
  /** Maximum traces recorded per day across all sessions (default: 100). */
  maxTracesPerDay: number;
  /** Days to retain traces before auto-pruning (default: 90). */
  retentionDays: number;
  /** Optional: model used for goal extraction from conversation context. */
  goalExtractionModel?: string;
};

/** Workflow crystallization: auto-generate AgentSkill SKILL.md files from repeated patterns (Issue #208). */
export type CrystallizationConfig = {
  /** Enable crystallization cycle (default: false — opt-in). */
  enabled: boolean;
  /** Minimum usage count for a pattern to be considered (default: 5). */
  minUsageCount: number;
  /** Minimum success rate for a pattern to be considered (default: 0.7). */
  minSuccessRate: number;
  /** When true, auto-approve and write skills without human review (default: false). */
  autoApprove: boolean;
  /** Output directory for generated skills, ~ is expanded (default: '~/.openclaw/workspace/skills/auto'). */
  outputDir: string;
  /** Maximum number of approved crystallized skills (default: 50). */
  maxCrystallized: number;
  /** Prune unused auto-skills older than N days (default: 30; 0 = disabled). */
  pruneUnusedDays: number;
};

/** Document ingestion via MarkItDown Python bridge (Issue #206). */
export type DocumentsConfig = {
  /** Enable document ingestion tool (default: false — opt-in) */
  enabled: boolean;
  /** Python executable path (default: "python3") */
  pythonPath: string;
  /** Max characters per chunk when splitting markdown (default: 2000) */
  chunkSize: number;
  /** Overlap characters (heading context) carried into each chunk (default: 200) */
  chunkOverlap: number;
  /** Max document size in bytes before rejection (default: 50 * 1024 * 1024 = 50 MB) */
  maxDocumentSize: number;
  /** Automatically add filename as a tag to ingested facts (default: true) */
  autoTag: boolean;
  /** Enable LLM vision for image ingestion (default: false) */
  visionEnabled: boolean;
  /** Optional vision model (default: resolved from llm.default) */
  visionModel?: string;
  /** Optional allowlist of absolute directory paths; when set, ingestion only allows files under these paths */
  allowedPaths?: string[];
};

/** Plugin self-extension: generate tool proposals from usage-pattern gaps (Issue #210). */
export type SelfExtensionConfig = {
  /** Enable self-extension gap detection and proposal generation (default: false — opt-in). */
  enabled: boolean;
  /** Minimum times a gap must be observed before proposing a tool (default: 3). */
  minGapFrequency: number;
  /** Minimum number of tool calls saved to qualify as a gap (default: 2). */
  minToolSavings: number;
  /** Maximum number of pending proposals allowed at any time (default: 20). */
  maxProposals: number;
};

/** Signal types for implicit feedback detection (Issue #262). */
export type ImplicitSignalType =
  | "rephrase"
  | "immediate_action"
  | "topic_change"
  | "grateful_close"
  | "self_service"
  | "escalation"
  | "terse_response"
  | "extended_engagement"
  | "copy_paste"
  | "correction_cascade"
  | "silence_after_action";

/** Implicit feedback detection from behavioral conversation signals (Issue #262). */
export type ImplicitFeedbackConfig = {
  /** Enable implicit feedback detection (default: true). */
  enabled: boolean;
  /** Minimum confidence to include a signal (default: 0.5). */
  minConfidence: number;
  /** Signal types to detect; defaults to all types. */
  signalTypes: ImplicitSignalType[];
  /** Similarity threshold for rephrase detection (default: 0.8). */
  rephraseThreshold: number;
  /** Similarity threshold for topic-change detection (default: 0.3). */
  topicChangeThreshold: number;
  /** Fraction of avg message length below which terse_response fires (default: 0.4). */
  terseResponseRatio: number;
  /** Feed positive implicit signals into the reinforcement pipeline (default: true). */
  feedToReinforcement: boolean;
  /** Feed negative implicit signals into the self-correction pipeline (default: true). */
  feedToSelfCorrection: boolean;
  /** Use LLM-based trajectory analysis instead of heuristic lesson extraction (default: false). */
  trajectoryLLMAnalysis: boolean;
};

/** Frustration signal weights override (Issue #263 — Phase 1). */
export type FrustrationSignalWeights = {
  short_reply?: number;
  imperative_tone?: number;
  repeated_instruction?: number;
  caps_or_emphasis?: number;
  explicit_frustration?: number;
  correction_frequency?: number;
  question_to_command?: number;
  reduced_context?: number;
  emoji_shift?: number;
};

/** Frustration detection configuration (Issue #263 — Phase 1). */
export type FrustrationDetectionConfig = {
  /** Enable real-time frustration detection (default: true). */
  enabled: boolean;
  /** Sliding window: number of conversation turns to analyse (default: 8). */
  windowSize: number;
  /** Recency decay applied per turn (default: 0.9). */
  decayRate: number;
  /** Custom per-signal weights overriding defaults (0-1). */
  signalWeights?: FrustrationSignalWeights;
  /** Frustration level (0-1) at which to inject a hint into system context (default: 0.3). */
  injectionThreshold: number;
  /** Frustration level thresholds per adaptation category. */
  adaptationThresholds: {
    medium: number;   // default 0.3
    high: number;     // default 0.5
    critical: number; // default 0.7
  };
  /** Export frustration signals to the #262 implicit feedback pipeline (default: true). */
  feedToImplicitPipeline: boolean;
};

/** Cross-agent learning configuration (Issue #263 — Phase 2). */
export type CrossAgentLearningConfig = {
  /** Enable cross-agent learning in the nightly cycle (default: false). */
  enabled: boolean;
  /** Days of agent-scoped facts to consider (default: 14). */
  windowDays: number;
  /** LLM model for generalisation (default: resolved from llm.nano). */
  model?: string;
  /** Fallback models if primary fails. */
  fallbackModels?: string[];
  /** Batch size per LLM call (default: 20). */
  batchSize: number;
  /** Minimum confidence of source agent fact (default: 0.4). */
  minSourceConfidence: number;
  /** Run during nightly cycle (default: true when enabled). */
  runInNightlyCycle: boolean;
};

/** Tool effectiveness scoring configuration (Issue #263 — Phase 3). */
export type ToolEffectivenessConfig = {
  /** Enable tool effectiveness scoring (default: true when workflowTracking.enabled). */
  enabled: boolean;
  /** Minimum total calls before a tool is scored (default: 3). */
  minCalls: number;
  /** Top-N tools to surface in reports (default: 10). */
  topN: number;
  /** Score below which a tool is flagged as low-scorer (default: 0.3). */
  lowScoreThreshold: number;
  /** Score decay per nightly run (default: 0.95). */
  decayFactor: number;
  /** Run scoring in the nightly cycle (default: true when enabled). */
  runInNightlyCycle: boolean;
  /** Inject tool-preference hints into agent context (default: true). */
  injectHints?: boolean;
};

/** Closed-loop rule effectiveness measurement (Issue #262). */
export type ClosedLoopConfig = {
  /** Enable closed-loop measurement (default: true). */
  enabled: boolean;
  /** Days before and after rule creation to compare (default: 7). */
  measurementWindowDays: number;
  /** Minimum total feedback events required before scoring (default: 5). */
  minSampleSize: number;
  /** Effect score threshold below which a rule is auto-deprecated (default: -0.3). */
  autoDeprecateThreshold: number;
  /** Effect score threshold above which a rule's confidence is boosted (default: 0.5). */
  autoBoostThreshold: number;
  /** Run measurement in the nightly cycle (default: true). */
  runInNightlyCycle: boolean;
};
