/** Verification store for critical facts (Issue #162). */
export type VerificationConfig = {
  /** Enable verification store (default: false). */
  enabled: boolean;
  /** Path to append-only backup JSON file (default: '~/.openclaw/verified-facts.json'). */
  backupPath: string;
  /** Days until a verified fact should be re-verified (default: 30). */
  reverificationDays: number;
  /** When true, auto-enroll critical facts into verification (default: true). */
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
  /** Archive consolidated event log entries older than this many days (default: 0 = disabled). */
  eventLogArchivalDays?: number;
  /** Directory for compressed JSONL archives (default: '~/.openclaw/event-log-archive'). */
  eventLogArchivePath?: string;
  /** Legacy: max age for unconsolidated event log entries before deletion (default: 90). */
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
  /** Cron reliability settings for memory maintenance jobs (Issue #281). */
  cronReliability: CronReliabilityConfig;
  /** Council review provenance configuration (Issue #280). */
  council: CouncilConfig;
};

/**
 * ACP provenance configuration for council reviews (Issue #280).
 *
 * Council reviews are orchestrated externally (by the main agent, not the plugin).
 * This config provides the mode setting; actual header generation is done via
 * getProvenanceHeaders() in utils/provenance.ts.
 */
export type CouncilProvenanceMode = "meta+receipt" | "meta" | "receipt" | "none";

export type CouncilConfig = {
  /**
   * Provenance metadata level to include in council review spawn calls and PR comments.
   * - "meta+receipt": include ACP meta headers + GitHub receipt comment (default)
   * - "meta": ACP headers only (X-Trace-Id, X-Council-Member, X-Session-Key)
   * - "receipt": GitHub PR comment receipt only
   * - "none": disable provenance metadata
   */
  provenance: CouncilProvenanceMode;
  /**
   * Optional: label prefix for council session keys (e.g. "council-review" → "council-review-abc123").
   * Default: "council-review"
   */
  sessionKeyPrefix: string;
};

/**
 * Cron reliability configuration for memory maintenance (Issue #281).
 * Controls nightly cycle schedule, weekly backup, and boot-time health verification.
 */
export type CronReliabilityConfig = {
  /** Cron expression for nightly maintenance cycle (default: "0 3 * * *"). */
  nightlyCron: string;
  /** Cron expression for weekly backup (default: "0 4 * * 0"). */
  weeklyBackupCron: string;
  /**
   * When true, check cron health at startup and log warnings for missing or stale jobs.
   * Default: true.
   */
  verifyOnBoot: boolean;
  /**
   * Max staleness in hours before a job is considered "stale" (default: 28).
   * Applies only to daily/nightly jobs; weekly jobs use 7 days.
   */
  staleThresholdHours: number;
};
