/** Verification store for critical facts (Issue #162). */
export type VerificationConfig = {
  /** Enable verification store (default: false). */
  enabled: boolean;
  /** Path to append-only backup JSON file (default: '~/.openclaw/verified-facts.json'). */
  backupPath: string;
  /** Days until a verified fact should be re-verified (default: 30). */
  reverificationDays: number;
  /** When true, suggest verification for IP/infrastructure facts (does NOT auto-enroll; default: true). */
  autoClassify: boolean;
  /** Enable continuous verification cycle (Issue #164, default: false). */
  continuousVerification: boolean;
  /** Days between continuous verification cycles (default: 30). */
  cycleDays: number;
  /** LLM model for continuous verification (default: openai/gpt-4.1-nano). */
  verificationModel?: string;
};

/** Provenance tracing for fact-to-source chains (Issue #163). */
export type ProvenanceConfig = {
  /** Enable provenance tracing (default: false — opt-in). */
  enabled: boolean;
  /** Days to retain provenance edges before pruning (default: 365). */
  retentionDays: number;
};

/** Nightly dream cycle: automated prune → consolidate → reflect pipeline (Issue #143). */
export type NightlyCycleConfig = {
  /** Enable the nightly dream cycle (default: false). */
  enabled: boolean;
  /** Cron expression for nightly run (default: "45 2 * * *" = 2:45 AM). */
  schedule: string;
  /** Reflection window in days (default: 7). */
  reflectWindowDays: number;
  /** Prune mode: "expired" = pruneExpired only, "decay" = decayConfidence only, "both" = both (default: "both"). */
  pruneMode: "expired" | "decay" | "both";
  /** LLM model for reflection step (default: resolved from llm config). */
  model?: string;
  /** Days before consolidating episodic events into facts (default: 7). */
  consolidateAfterDays: number;
  /** Max age for unconsolidated event log entries before archiving (default: 90). */
  maxUnconsolidatedAgeDays: number;
};

/** Memory health dashboard configuration (Issue #148). */
export type HealthConfig = {
  /** Enable memory_health tool (default: true). */
  enabled: boolean;
};

/** Monthly knowledge quality review (Issue #165). */
export type MonthlyReviewConfig = {
  enabled: boolean;           // default: false
  model?: string;             // LLM model for recommendations, default: plugin default
  dayOfMonth: number;         // default: 1
};

/** Maintenance configuration group. */
export type MaintenanceConfig = {
  monthlyReview: MonthlyReviewConfig;
};
