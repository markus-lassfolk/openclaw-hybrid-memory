/**
 * Autonomous dreaming config (#2170–#2177 / Epic #2169).
 *
 * Defaults are conservative: master switch off; candidate store off; shadow on;
 * auto-promote/rollback off; autonomous mode (machine review is the happy path).
 */

export type DreamComposeStep =
  | "distill"
  | "self-correction"
  | "reflect"
  | "consolidate"
  | "contradictions"
  | "dream-cycle-core";

export type DreamingMode = "autonomous" | "supervised";

export type DreamingCandidateStoreConfig = {
  /** Persist candidate entries for dream/curation runs. Default: false. */
  enabled: boolean;
  /**
   * When candidate store is enabled: write candidates + gate decisions without applying
   * unless autoPromote is also on (or CLI promote --force). Default: true.
   */
  shadow: boolean;
};

export type DreamingAutoPromoteConfig = {
  /** Apply gated-ok candidates to the live store. Default: false. */
  enabled: boolean;
  /** Require session evidence or non-empty rationale. Default: true. */
  requireProvenance: boolean;
  /**
   * Block promote when a candidate would worsen high-severity unresolved contradictions.
   * Stub for #2170 (always passes unless an entry opts into `contradictionWorsens`). Default: true.
   */
  blockOnContradictionWorsening: boolean;
};

export type DreamingAutoRollbackConfig = {
  /** Observe post-promote and apply reverse plan on regression. Default: false. */
  enabled: boolean;
  /** Observation window hours (for #2173 metrics probe). Default: 24. */
  observeWindowHours: number;
  /** Absolute effectScore drop vs baseline to trigger. Default: 0.15. */
  regressionThreshold: number;
};

/** Blast-radius / prevalence bars by scope (#2172). */
export type DreamingPrevalenceTier = {
  minSessions: number;
  minAgents: number;
  /** Optional minimum confidence 0..1 when payload carries confidence. */
  minConfidence?: number;
};

export type DreamingPrevalenceConfig = {
  session: DreamingPrevalenceTier;
  agent: DreamingPrevalenceTier;
  user: DreamingPrevalenceTier;
  global: DreamingPrevalenceTier;
  /** Single-tenant personal vaults: treat global bar like user (minAgents=1). Default: false. */
  personalSingleTenant: boolean;
};

export type DreamPermissionBoundary = {
  /** Target memory scope for this dream. Default: global. */
  targetScope: "session" | "agent" | "user" | "global";
  /**
   * When true (default), only attach sessions whose effective ACL ⊆ targetScope.
   * Fail closed: unresolved ACL → exclude.
   */
  enforce: boolean;
  /** Personal vaults may treat most content as one boundary. Default: false. */
  personalMode: boolean;
};

export type DreamSteeringConfig = {
  profile: "personal" | "coding" | "ops" | "custom";
  promote: string[];
  ignore: string[];
  notes?: string;
};

export type DreamingConfig = {
  /** Master switch for unified Dream (#2171). Default: false. */
  enabled: boolean;
  /**
   * Product mode (#2177). `autonomous` = machine gates are happy path;
   * `supervised` = escape-hatch review orientation (still no required human inbox).
   */
  mode: DreamingMode;
  /** Ordered compose stages for `dream run`. */
  compose: DreamComposeStep[];
  /** Cap attached session ids (1..100). Default: 20. */
  maxSessions: number;
  /** Hard wall-clock ceiling for a Dream run (minutes). Default: 30. */
  maxRuntimeMinutes: number;
  /**
   * When Dream is enabled, skip overlapping nightly maintenance steps so Dream owns them.
   * Default: true.
   */
  skipNightlyOverlap: boolean;
  /**
   * After compose, call promote (gates + shadow/apply). Default: false
   * (follow explicit promote CLI or autoPromote.enabled).
   */
  promoteAfterRun: boolean;
  candidateStore: DreamingCandidateStoreConfig;
  autoPromote: DreamingAutoPromoteConfig;
  autoRollback: DreamingAutoRollbackConfig;
  prevalence: DreamingPrevalenceConfig;
  permissionBoundary: DreamPermissionBoundary;
  steering: DreamSteeringConfig;
};

export const DEFAULT_DREAM_COMPOSE: DreamComposeStep[] = [
  "distill",
  "contradictions",
  "reflect",
  "consolidate",
];

export const DEFAULT_DREAMING_CONFIG: DreamingConfig = {
  enabled: false,
  mode: "autonomous",
  compose: [...DEFAULT_DREAM_COMPOSE],
  maxSessions: 20,
  maxRuntimeMinutes: 30,
  skipNightlyOverlap: true,
  promoteAfterRun: false,
  candidateStore: {
    enabled: false,
    shadow: true,
  },
  autoPromote: {
    enabled: false,
    requireProvenance: true,
    blockOnContradictionWorsening: true,
  },
  autoRollback: {
    enabled: false,
    observeWindowHours: 24,
    regressionThreshold: 0.15,
  },
  prevalence: {
    session: { minSessions: 1, minAgents: 1 },
    agent: { minSessions: 1, minAgents: 1 },
    user: { minSessions: 2, minAgents: 1, minConfidence: 0.7 },
    global: { minSessions: 3, minAgents: 2 },
    personalSingleTenant: false,
  },
  permissionBoundary: {
    /** Conservative default: session-scoped dreams; raise explicitly for global curriculum (#2174). */
    targetScope: "session",
    enforce: true,
    personalMode: false,
  },
  steering: {
    profile: "personal",
    promote: ["preference", "procedure", "tool_failure"],
    ignore: ["one_off_debug", "transient_path", "secret_like"],
    notes: undefined,
  },
};
