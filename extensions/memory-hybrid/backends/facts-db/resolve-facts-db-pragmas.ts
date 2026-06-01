import { statSync } from "node:fs";
import { getEnv } from "../../utils/env-manager.js";

const DEFAULT_CACHE_SIZE_KB = 64_000;
const DEFAULT_MMAP_SIZE_BYTES = 268_435_456;
const MIN_CACHE_SIZE_KB = 2_000;
const MMAP_HEADROOM_BYTES = 64 * 1024 * 1024;

export type FactsDbPragmas = {
  cacheSizeKb: number;
  mmapSizeBytes: number;
};

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve SQLite page-cache and mmap pragmas for facts.db.
 *
 * Env overrides (OPENCLAW_FACTS_CACHE_SIZE_KB, OPENCLAW_FACTS_MMAP_SIZE) are clamped
 * to the on-disk DB size so a stale oversized env cannot reserve gigabytes of anonymous
 * RSS on gateway restart (maevevm RCA: 512MB cache + huge mmap on ~414MB DB).
 */
export function resolveFactsDbPragmas(dbPath: string): FactsDbPragmas {
  let cacheSizeKb = parsePositiveInt(getEnv("OPENCLAW_FACTS_CACHE_SIZE_KB")) ?? DEFAULT_CACHE_SIZE_KB;
  let mmapSizeBytes = parsePositiveInt(getEnv("OPENCLAW_FACTS_MMAP_SIZE")) ?? DEFAULT_MMAP_SIZE_BYTES;

  let dbBytes = 0;
  try {
    dbBytes = statSync(dbPath).size;
  } catch {
    return { cacheSizeKb, mmapSizeBytes };
  }

  if (dbBytes > 0) {
    const dbKb = Math.ceil(dbBytes / 1024);
    const maxCacheKb = Math.max(MIN_CACHE_SIZE_KB, Math.ceil(dbKb * 1.5));
    cacheSizeKb = Math.min(cacheSizeKb, maxCacheKb);
    const maxMmap = dbBytes + MMAP_HEADROOM_BYTES;
    mmapSizeBytes = Math.min(mmapSizeBytes, maxMmap);
  }

  return { cacheSizeKb, mmapSizeBytes };
}
