export const DECAY_CLASSES = [
  "permanent",
  "durable",    // ~3 months half-life
  "normal",     // ~2 weeks half-life
  "short",      // ~2 days half-life
  "ephemeral",  // ~4 hours half-life
  "stable",     // legacy: 90 days
  "active",     // legacy: 14 days
  "session",    // legacy: 24 hours
  "checkpoint", // legacy: 4 hours
] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

/** TTL defaults in seconds per decay class. null = never expires. */
export const TTL_DEFAULTS: Record<DecayClass, number | null> = {
  permanent: null,
  durable: 90 * 24 * 3600,   // ~3 months
  normal: 14 * 24 * 3600,    // 2 weeks
  short: 2 * 24 * 3600,      // 2 days
  ephemeral: 4 * 3600,       // 4 hours
  stable: 90 * 24 * 3600,    // legacy: 90 days
  active: 14 * 24 * 3600,    // legacy: 14 days
  session: 24 * 3600,        // legacy: 24 hours
  checkpoint: 4 * 3600,      // legacy: 4 hours
};

/** Store options: fuzzy dedupe and optional classify-before-write. */
export type StoreConfig = {
  fuzzyDedupe: boolean;
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
