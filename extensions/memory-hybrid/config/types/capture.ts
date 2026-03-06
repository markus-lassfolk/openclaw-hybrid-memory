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
  /** Cosine similarity threshold above which a new fact is considered a duplicate (default: 0.85) */
  deduplicationThreshold: number;
  /** Override sessions directory (default: procedures.sessionsDir) */
  sessionsDir?: string;
};

/** Reflection / pattern synthesis from session history */
export type ReflectionConfig = {
  enabled: boolean;
  model?: string;            // when unset, runtime uses getDefaultCronModel(cfg, "default")
  defaultWindow: number;      // Time window in days (default: 14)
  minObservations: number;   // Min observations to support a pattern (default: 2)
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
};
