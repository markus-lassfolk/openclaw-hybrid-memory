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
  /** Maximum events to merge into one consolidated fact (default: 200). */
  maxEventsPerConsolidation: number;
  /**
   * Retention window in days for log tables (recall_log, reinforcement_log, feedback_trajectories).
   * Rows older than this are deleted during the dream cycle. Set to 0 to disable log pruning.
   * Default: 30.
   */
  logRetentionDays: number;
  /**
   * When true, run PRAGMA wal_checkpoint(TRUNCATE) + VACUUM after each nightly cycle
   * to reclaim disk space freed by pruning. Slightly slower but keeps facts.db lean.
   * Default: true.
   */
  vacuumOnCycle: boolean;
  /**
   * When true, run the source-/importance-aware decay reclassifier as part of the
   * nightly cycle (#1189). Without this, the only way to reclassify legacy
   * `decay_class=stable` entries was the manual `decay reclassify --apply` CLI.
   * Default: true.
   */
  reclassifyDecayOnCycle: boolean;
  /** Inactivity threshold (days) used by the recall-based demotion path. Default: 90. */
  reclassifyInactiveDays: number;
  /** Recall count required to promote a fact to a longer-lived class. Default: 3. */
  reclassifyPromoteRecallCount: number;
  /**
   * When set, only these `event_log.event_type` values are eligible for episodic consolidation,
   * after the built-in deny list is applied (#1185). Omit for no allow restriction.
   */
  consolidationEventTypeAllow?: string[];
  /**
   * Extra `event_type` values to exclude from consolidation (merged with built-in session/
   * heartbeat/transport deny list). Default: none.
   */
  consolidationEventTypeDeny?: string[];
  /**
   * When true, enable reflection rules generation during the dream cycle.
   * Rules are only generated when enough patterns exist (>= MIN_PATTERNS_FOR_RULES).
   * Cost optimization: Set to false to save 30-40% of dream cycle LLM cost.
   * Default: true (enabled for backward compatibility).
   */
  enableReflectionRules?: boolean;
  /**
   * When true, dream-cycle reflection output is auto-enqueued as governed proposals
   * (persona rules + optional Skill Workshop bridge). Default: false.
   */
  autoPropose?: boolean;
  /**
   * When true, run the wiki dream findings ingester as a post-cycle step.
   * Reads dream cycle artifacts and stores novel patterns/summaries as facts
   * so they surface in the Dreaming UI via memory-wiki bridge. Default: false.
   */
  ingestDreamFindings?: boolean;
};

/** Memory health dashboard configuration (Issue #148). */
export type HealthConfig = {
  /** Enable memory_health tool (default: true). */
  enabled: boolean;
  /**
   * Require authentication for all dashboard HTTP routes (Issue #279).
   * Must be the same value for every route under /plugins/memory-dashboard/
   * to satisfy the OpenClaw v2026.3.8 consistent-auth requirement.
   * Default: true.
   */
  authenticated: boolean;
};

/** Monthly knowledge quality review (Issue #165). */
export type MonthlyReviewConfig = {
  enabled: boolean; // default: false
  model?: string; // LLM model for recommendations, default: plugin default
  dayOfMonth: number; // default: 1
};

/** Maintenance-failure telemetry configuration (Issue #1836). */
export type MaintenanceFailureReportingConfig = {
  /**
   * When true, emit best-effort grouped GlitchTip/Sentry-compatible events for
   * maintenance failures and degraded semantic outcomes. Default: true.
   */
  enabled: boolean;
};

/**
 * Redaction of emails/home-paths/private-IPs from maintenance-extracted fact text before storage
 * (distill, extract-directives, extract-reinforcement). Default: disabled — see #2055. This is a
 * personal-memory system; contacts/IPs are usually what an operator wants remembered, and actual
 * secrets already go through the separate credential vault rather than plain fact text.
 */
export type MaintenancePrivacyRedactionConfig = {
  /** Enable redaction at the maintenance-pipeline fact-store boundary (default: false). */
  enabled: boolean;
  /** Fact categories exempt from redaction even when enabled (default: ["entity"]). */
  exemptCategories: string[];
  /** Fact `key` values exempt from redaction even when enabled (default: ["email", "phone", "mobile"]). */
  exemptKeys: string[];
};

/** Orchestrator tuning for hybrid maintenance consolidation. */
export type MaintenanceOrchestratorConfig = {
  /** Per-step guard overrides (step name → min interval ms). */
  stepGuards?: Record<string, number>;
  /** Max lookback for scan cursors after a long outage (default: 14 days). */
  maxCatchUpDays?: number;
  /** Pause between consecutive LLM-provider steps (default: 30000ms). */
  llmCooldownBetweenStepsMs?: number;
  /** Max consecutive 429s before deferring remaining LLM steps (default: 2). */
  rateLimitMaxRetries?: number;
  /** Optional time budget per orchestrator run in minutes (default: unlimited). */
  maxRuntimeMinutes?: number;
  /** Use consolidated single-job cron layout (default: true for new installs). */
  consolidatedCronJobs?: boolean;
  /** DB-backed worker leases for background maintenance (Issue #1904). */
  workerLeases?: WorkerLeasesConfig;
};

/** Worker lease + quiet-window configuration (Issue #1904). */
export type WorkerLeasesConfig = {
  /** Enable lease acquisition for background workers (default: true). */
  enabled: boolean;
  /** Default lease TTL in seconds (default: 120). */
  defaultTtlSeconds: number;
  /** Heartbeat interval in seconds (default: 30). */
  heartbeatIntervalSeconds: number;
  /** Quiet window: heavy maintenance only outside this range (UTC by default). */
  quietWindow?: {
    enabled: boolean;
    start: string;
    end: string;
    tz: string;
  };
  /** Skip worker when estimated context usage exceeds this threshold (0–1). */
  contextUsageThreshold?: number;
};

/** Maintenance configuration group. */
export type MaintenanceConfig = {
  monthlyReview: MonthlyReviewConfig;
  /** Cron reliability settings for memory maintenance jobs (Issue #281). */
  cronReliability: CronReliabilityConfig;
  /** Grouped GlitchTip/Sentry-compatible reporting for maintenance failures (Issue #1836). */
  failureReporting: MaintenanceFailureReportingConfig;
  /** Redaction of emails/paths/private-IPs from maintenance-extracted fact text (Issue #2055). */
  privacyRedaction: MaintenancePrivacyRedactionConfig;
  /** Council review provenance configuration (Issue #280). */
  council: CouncilConfig;
  /** Hybrid maintenance orchestrator settings. */
  orchestrator?: MaintenanceOrchestratorConfig;
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
