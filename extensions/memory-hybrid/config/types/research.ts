/**
 * Proactive research loop config (docs/PROACTIVE-RESEARCH.md).
 *
 * The loop: nightly insight synthesis (LLM reads person-signals → evidence-linked `insight`
 * facts) → deterministic trigger policy (picks ≤1 concern per night, cooldown + blocklist) →
 * overnight OpenClaw cron agent researches it with web tools and stores a `briefing` fact via
 * the research CLI → the briefing surfaces once at the next session start (and optionally via
 * cron announce delivery).
 */
export interface ResearchInsightsConfig {
  /** Max insight facts stored per nightly run. */
  maxPerRun: number;
  /** Days of person-signals (valence, routines, frustration, patterns) to read. */
  windowDays: number;
  /** Minimum evidence refs an insight must cite to be stored. */
  minEvidence: number;
  /** Model override for the synthesis call (default: maintenance tier). */
  model?: string;
}

export interface ResearchTriggerPolicyConfig {
  /**
   * Minimum insight importance to graduate to research. Insight importance is
   * 0.5 + 0.4 × salience, so 0.74 ≈ salience ≥ 0.6.
   */
  minImportance: number;
  /** Minimum evidence count (from the insight's provenance) to be eligible. */
  minEvidence: number;
  /** Days before the same research slug may be picked again. */
  cooldownDays: number;
  /** Max topics queued per nightly run. */
  maxPerNight: number;
  /** Topic labels (insight `value`) never sent to research. Sensitive text is also regex-blocked. */
  topicBlocklist: string[];
}

export interface ResearchExecutorConfig {
  /** Hard cap on stored briefing body length. */
  maxBriefingChars: number;
  /** Max source URLs recorded per briefing. */
  maxSources: number;
}

export interface ResearchDeliveryConfig {
  /** "announce" pushes the overnight agent's summary to a channel; "none" relies on the session-start briefing. */
  mode: "none" | "announce";
  /** Delivery channel for announce mode (both channel and to required). */
  channel?: string;
  /** Delivery recipient for announce mode. */
  to?: string;
  /** How many days a stored briefing stays eligible for session-start injection (0 disables injection). */
  injectDays: number;
  /** Max briefings injected per session start. */
  maxBriefings: number;
}

export interface ResearchConfig {
  /** Master gate for the whole loop (synthesis, trigger, cron job, injection). Default true. */
  enabled: boolean;
  /** Cron expression for the overnight research agent (default "30 3 * * *", after nightly maintenance). */
  schedule: string;
  insights: ResearchInsightsConfig;
  trigger: ResearchTriggerPolicyConfig;
  executor: ResearchExecutorConfig;
  delivery: ResearchDeliveryConfig;
}
