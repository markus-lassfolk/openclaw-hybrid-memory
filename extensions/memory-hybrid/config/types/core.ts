export const DECAY_CLASSES = [
  "permanent",
  "stable",
  "active",
  "session",
  "checkpoint",
] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

/** TTL defaults in seconds per decay class. null = never expires. */
export const TTL_DEFAULTS: Record<DecayClass, number | null> = {
  permanent: null,
  stable: 90 * 24 * 3600, // 90 days
  active: 14 * 24 * 3600, // 14 days
  session: 24 * 3600, // 24 hours
  checkpoint: 4 * 3600, // 4 hours
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

/** Shortest-path traversal configuration (Issue #140). */
export type PathConfig = {
  /** Enable memory_path tool (default: true). */
  enabled: boolean;
  /** Hard cap on maxDepth accepted by memory_path (default: 10). */
  maxPathDepth: number;
};
