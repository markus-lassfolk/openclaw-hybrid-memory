/** Passive observer: background fact extraction from session transcripts */
export type PassiveObserverConfig = {
  /** Enable passive observer (default: false — opt-in) */
  enabled: boolean;
  /** How often to run, in minutes (default: 15) */
  intervalMinutes: number;
  /** Model override; when unset, uses nano tier */
  model?: string;
  /** Max characters per transcript chunk sent to LLM (default: 8000) */
  maxCharsPerChunk: number;
  /** Min importance score 0–1 to store a fact (default: 0.5) */
  minImportance: number;
  /** Cosine similarity threshold above which a new fact is considered a duplicate (default: 0.92) */
  deduplicationThreshold: number;
  /** Override sessions directory (default: procedures.sessionsDir) */
  sessionsDir?: string;
};

/** Reflection / pattern synthesis from session history */
export type ReflectionConfig = {
  enabled: boolean;
  model?: string; // when unset, runtime uses getDefaultCronModel(cfg, "default")
  defaultWindow: number; // Time window in days (default: 14)
  minObservations: number; // Min observations to support a pattern (default: 2)
};

/** Two-tier LLM pre-filter configuration for bulk session triage (Issue #290). */
export type ExtractionPreFilterConfig = {
  /** Enable local LLM pre-filtering (default: false). When true, each session is triaged by a local Ollama model before cloud LLM analysis. */
  enabled: boolean;
  /**
   * Ollama model identifier (e.g. "qwen3:8b" or "ollama/qwen3:8b").
   * The "ollama/" prefix is stripped automatically when calling Ollama directly.
   * For Qwen3 thinking models, consider using a ":no_think" variant to reduce token usage.
   * Default: "qwen3:8b".
   */
  model: string;
  /**
   * Ollama base URL. When unset, falls back to llm.providers.ollama.baseURL,
   * then defaults to "http://localhost:11434".
   */
  endpoint?: string;
  /**
   * Max characters of user messages extracted per session for triage (default: 2000).
   * Higher values improve accuracy but increase local LLM call time.
   */
  maxCharsPerSession?: number;
};

/** Multi-pass extraction with LLM verification (Issue #166). */
export type ExtractionConfig = {
  /** Enable multi-pass extraction (default: false). Pass 1 (explicit) is always enabled when true. */
  extractionPasses: boolean;
  /** Enable Pass 3 verification against transcript (default: false). */
  verificationPass: boolean;
  /** Model for Pass 1 explicit extraction; when unset, uses nano tier. */
  extractionModel?: string;
  /** Model for Pass 2 implicit extraction (preferences, corrections, context); when unset, uses default tier. */
  implicitModel?: string;
  /** Model for Pass 3 verification against transcript; when unset, uses nano tier. */
  verificationModel?: string;
  /**
   * Two-tier LLM pre-filter: use a local Ollama model to triage sessions before cloud LLM analysis (Issue #290).
   * When enabled, only sessions flagged as interesting by the local model are sent to the cloud LLM.
   * Reduces cloud LLM costs by ~80–95% for bulk re-index operations.
   */
  preFilter?: ExtractionPreFilterConfig;
  /** Model tier for extraction pipeline LLM calls. "nano" or "default" saves cost; unset = "heavy". */
  extractionModelTier?: "nano" | "default" | "heavy";
};

/** Procedural memory: auto-generated skills from learned patterns */
export type ProceduresConfig = {
  enabled: boolean;
  /** Session JSONL directory (default: ~/.openclaw/agents/main/sessions) */
  sessionsDir: string;
  /** Min tool steps to consider a procedure (default: 2) */
  minSteps: number;
  /** Validations before auto-generating a skill (default: 3) */
  validationThreshold: number;
  /** TTL days for procedure confidence / revalidation (default: 30) */
  skillTTLDays: number;
  /** Path to auto-generated skills (default: workspace/skills/auto) */
  skillsAutoPath: string;
  /** Require human approval before promoting auto-skill to permanent (default: true) */
  requireApprovalForPromote: boolean;
  /** Max tokens for procedure block injected into recall (default: 500). Prevents procedure context from dominating. */
  maxInjectionTokens: number;
};
