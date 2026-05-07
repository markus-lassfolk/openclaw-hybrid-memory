export const DECAY_CLASSES = [
  "permanent",
  "durable", // ~3 months half-life
  "normal", // ~90 days half-life (#1186/#1189: aligned with implicit-feedback trajectory TTL)
  "short", // ~2 days half-life
  "ephemeral", // ~4 hours half-life
  "stable", // legacy: 90 days
  "active", // legacy: 14 days
  "session", // legacy: 24 hours
  "checkpoint", // legacy: 4 hours
] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

/** TTL defaults in seconds per decay class. null = never expires. */
export const TTL_DEFAULTS: Record<DecayClass, number | null> = {
  permanent: null,
  durable: 90 * 24 * 3600, // ~3 months
  // Issue #1186/#1189: trajectory lessons and other source-/importance-defaulted facts use
  // `normal` and need ~90 days of grace before they expire (was 14 days). Reinforcement on
  // recall keeps useful facts alive; never-recalled facts now actually expire.
  normal: 90 * 24 * 3600, // ~90 days
  short: 2 * 24 * 3600, // 2 days
  ephemeral: 4 * 3600, // 4 hours
  stable: 90 * 24 * 3600, // legacy: 90 days
  active: 14 * 24 * 3600, // legacy: 14 days
  session: 24 * 3600, // legacy: 24 hours
  checkpoint: 4 * 3600, // legacy: 4 hours
};

export type StoreDedupeAction = "skip" | "boost" | "merge" | "store";

/**
 * Behaviour when a write would exceed `maxPerDay`:
 *   - `drop` (legacy default) — reject the new write, increment `daily_writes.dropped`.
 *   - `evict-lowest-confidence` — supersede the lowest-confidence active fact for the same
 *     source and insert the new one, incrementing `daily_writes.evicted` (#1194). This is the
 *     recommended setting for noisy ingest paths (e.g. implicit-feedback) where dropping new
 *     evidence in favour of stale facts is the wrong choice.
 */
export type StoreOverflowAction = "drop" | "evict-lowest-confidence";

export type StoreSourceProfile = {
  vectorThreshold?: number;
  lexicalJaccard?: number;
  maxPerDay?: number;
  onDuplicate?: StoreDedupeAction;
  boostBy?: number;
  /** Strategy applied when `maxPerDay` is exceeded (#1194). Default `drop`. */
  onOverflow?: StoreOverflowAction;
};

/** Store options: fuzzy dedupe and optional classify-before-write. */
export type StoreConfig = {
  fuzzyDedupe: boolean;
  /** Per-source dedupe/quotas; exact keys or glob patterns such as seed:*. */
  sourceProfiles?: Record<string, StoreSourceProfile>;
  /** Fallback source profile when no exact/glob profile matches. */
  defaultProfile?: StoreSourceProfile;
  /** Classify incoming fact against existing similar facts (ADD/UPDATE/DELETE/NOOP) before storing (default: false) */
  classifyBeforeWrite?: boolean;
  /** Model for classification; when unset, runtime uses getDefaultCronModel(cfg, "nano") */
  classifyModel?: string;
};

/** Write-Ahead Log (WAL) configuration for crash resilience */
export type WALConfig = {
  /** Enable WAL for crash resilience (default: true) */
  enabled: boolean;
  /** Path to WAL file (default: same directory as SQLite DB) */
  walPath?: string;
  /** Maximum age of WAL entries before they're considered stale (ms, default: 5 minutes) */
  maxAge?: number;
};

/** Event log archival configuration. */
export type EventLogConfig = {
  /** Days before consolidated events are archived (default: 90). */
  archivalDays: number;
  /** Output directory for compressed JSONL archives (default: '~/.openclaw/event-archive'). */
  archivePath: string;
};

/** Shortest-path traversal configuration (Issue #140). */
export type PathConfig = {
  /** Enable memory_path tool (default: true). */
  enabled: boolean;
  /** Hard cap on maxDepth accepted by memory_path (default: 10). */
  maxPathDepth: number;
};
