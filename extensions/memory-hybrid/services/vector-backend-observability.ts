import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VectorDB } from "../backends/vector-db.js";
import { nowIso } from "../utils/dates.js";
import { capturePluginError } from "./error-reporter.js";

/**
 * Semantic query cache "missing fragment" read-stream error telemetry shape, shared by
 * `VectorDB.getSemanticCacheFragmentErrorTelemetry()`, the observability snapshot, and the
 * integrity check below (GlitchTip #34 / issue #2213, recurred as #2227).
 */
export type SemanticCacheFragmentErrorTelemetry = {
  occurrences: number;
  firstAtEpochMs: number | null;
  lastAtEpochMs: number | null;
  lastRecoveryAttemptEpochMs: number | null;
  lastRecoveryAction: "checkout" | "rebuild" | null;
  lastRecoverySucceeded: boolean | null;
};

type ProcStatusSnapshot = {
  vmRssKb: number | null;
  vmHwmKb: number | null;
  rssAnonKb: number | null;
  rssFileKb: number | null;
  rssShmemKb: number | null;
  vmSwapKb: number | null;
};

type FdGroup = "lancedb" | "sqlite" | "wal" | "shm" | "socket" | "pipe" | "anon" | "other";

type FdStats = {
  total: number;
  byGroup: Record<FdGroup, number>;
  sampleTargets: Record<FdGroup, string[]>;
  lancedbPaths: string[];
};

type SizeSummary = {
  bytes: number | null;
  scannedEntries: number;
  truncated: boolean;
};

type LanceTableStats = {
  name: "memories" | "semantic_query_cache";
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  sizeScanTruncated: boolean;
  rowCount: number | null;
};

export type VectorBackendObservability = {
  capturedAt: string;
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    nativeRssEstimateBytes: number;
    procStatus: ProcStatusSnapshot | null;
  };
  fileDescriptors: FdStats | null;
  vectorDb: {
    path: string | null;
    initialized: boolean | null;
    lanceAvailable: boolean | null;
    degraded: { active: boolean; reason: string | null; sinceEpochMs: number | null } | null;
    openReaders: number | null;
    optimizing: boolean | null;
    search: {
      active: number;
      peak: number;
      total: number;
      lastRequestedLimit: number;
      lastEffectiveLimit: number;
      lastResultCount: number;
      lastCompletedAtEpochMs: number | null;
    } | null;
    cache: {
      rows: number | null;
      maxRowsPerFilterKey: number;
      candidateLimitMax: number;
      lastFilterKey: string | null;
      lastRemovedRows: number;
      lastPrunedAtEpochMs: number | null;
    } | null;
    /**
     * LanceDB "missing fragment" read-stream error telemetry on the semantic query cache table
     * (GlitchTip #34 / issue #2213, recurred as #2227). `occurrences: 0` means healthy. See
     * `evaluateSemanticQueryCacheIntegrity` / `reportSemanticQueryCacheIntegrityIssue` below.
     */
    cacheFragmentErrors: SemanticCacheFragmentErrorTelemetry | null;
    lastOptimize: {
      ranAtEpochMs: number | null;
      compacted: number;
      removedFragments: number;
      freedBytes: number;
    } | null;
    bounds: {
      vectorSearchMaxResults: number;
      semanticCacheMaxRowsPerFilterKey: number;
      semanticCacheCandidateLimitMax: number;
    } | null;
  };
  lancedb: {
    basePath: string | null;
    totalSizeBytes: number | null;
    tables: LanceTableStats[];
  };
};

function readProcStatusMemory(): ProcStatusSnapshot | null {
  const statusPath = "/proc/self/status";
  if (!existsSync(statusPath)) return null;
  try {
    const raw = readFileSync(statusPath, "utf-8");
    const parseKb = (key: string): number | null => {
      const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
      if (!match) return null;
      const parsed = Number.parseInt(match[1], 10);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      vmRssKb: parseKb("VmRSS"),
      vmHwmKb: parseKb("VmHWM"),
      rssAnonKb: parseKb("RssAnon"),
      rssFileKb: parseKb("RssFile"),
      rssShmemKb: parseKb("RssShmem"),
      vmSwapKb: parseKb("VmSwap"),
    };
  } catch {
    return null;
  }
}

function classifyFdTarget(target: string): FdGroup {
  const lowered = target.toLowerCase();
  if (lowered.startsWith("socket:")) return "socket";
  if (lowered.startsWith("pipe:")) return "pipe";
  if (lowered.startsWith("anon_inode:")) return "anon";
  if (lowered.endsWith("-wal")) return "wal";
  if (lowered.endsWith("-shm")) return "shm";
  if (lowered.endsWith(".db") || lowered.includes(".db?")) return "sqlite";
  if (lowered.includes(".lance") || lowered.includes("/lancedb/")) return "lancedb";
  return "other";
}

function collectFdStats(sampleLimit = 5): FdStats | null {
  const fdRoot = "/proc/self/fd";
  if (!existsSync(fdRoot)) return null;
  const byGroup: Record<FdGroup, number> = {
    lancedb: 0,
    sqlite: 0,
    wal: 0,
    shm: 0,
    socket: 0,
    pipe: 0,
    anon: 0,
    other: 0,
  };
  const sampleTargets: Record<FdGroup, string[]> = {
    lancedb: [],
    sqlite: [],
    wal: [],
    shm: [],
    socket: [],
    pipe: [],
    anon: [],
    other: [],
  };
  const lanceSet = new Set<string>();
  let total = 0;
  try {
    const entries = readdirSync(fdRoot);
    for (const fd of entries) {
      const fdPath = join(fdRoot, fd);
      let target = "";
      try {
        target = readlinkSync(fdPath);
      } catch {
        continue;
      }
      total += 1;
      const group = classifyFdTarget(target);
      byGroup[group] += 1;
      if (sampleTargets[group].length < sampleLimit) {
        sampleTargets[group].push(target);
      }
      if (group === "lancedb") {
        const cleaned = target.replace(/\s+\(deleted\)$/, "");
        lanceSet.add(cleaned);
      }
    }
  } catch {
    return null;
  }
  return {
    total,
    byGroup,
    sampleTargets,
    lancedbPaths: [...lanceSet].sort(),
  };
}

function measurePathBytes(path: string, maxEntries = 50_000): SizeSummary {
  const out: SizeSummary = { bytes: 0, scannedEntries: 0, truncated: false };
  if (!existsSync(path)) return { bytes: null, scannedEntries: 0, truncated: false };
  const queue = [path];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(current);
    } catch {
      // Transient ENOENT/EACCES — skip this entry and continue the scan
      continue;
    }
    out.scannedEntries += 1;
    if (out.scannedEntries > maxEntries) {
      out.truncated = true;
      return out;
    }
    if (st.isDirectory()) {
      let children: string[];
      try {
        children = readdirSync(current).map((name) => join(current, name));
      } catch {
        // Directory became unreadable (e.g. concurrent Lance compaction) — skip
        continue;
      }
      queue.push(...children);
    } else if (st.isFile()) {
      if (out.bytes != null) out.bytes += st.size;
    }
  }
  return out;
}

export async function collectVectorBackendObservability(opts: {
  vectorDb: VectorDB;
  resolvedLancePath?: string;
  lanceBytes?: number | null;
  fdSampleLimit?: number;
}): Promise<VectorBackendObservability> {
  const usage = process.memoryUsage();
  const nativeRssEstimateBytes = Math.max(0, usage.rss - usage.heapTotal - usage.external);
  const procStatus = readProcStatusMemory();
  const fdStats = collectFdStats(opts.fdSampleLimit ?? 5);

  const vectorDbWithObs = opts.vectorDb as unknown as {
    getPath?: () => string;
    isInitialized?: () => boolean;
    isLanceDbAvailable?: () => boolean;
    getDegradedState?: () => { active: boolean; reason: string | null; sinceEpochMs: number | null };
    getOpenReaderCount?: () => number;
    isOptimizing?: () => boolean;
    getSearchTelemetry?: () => {
      active: number;
      peak: number;
      total: number;
      lastRequestedLimit: number;
      lastEffectiveLimit: number;
      lastResultCount: number;
      lastCompletedAtEpochMs: number | null;
    };
    getSemanticQueryCacheTelemetry?: () => {
      maxRowsPerFilterKey: number;
      candidateLimitMax: number;
      lastFilterKey: string | null;
      lastRemovedRows: number;
      lastPrunedAtEpochMs: number | null;
    };
    getSemanticCacheFragmentErrorTelemetry?: () => SemanticCacheFragmentErrorTelemetry;
    getLastOptimizeTelemetry?: () => {
      ranAtEpochMs: number | null;
      compacted: number;
      removedFragments: number;
      freedBytes: number;
    };
    getRuntimeBounds?: () => {
      vectorSearchMaxResults: number;
      semanticCacheMaxRowsPerFilterKey: number;
      semanticCacheCandidateLimitMax: number;
    };
    countSemanticQueryCacheRows?: () => Promise<number>;
    count?: () => Promise<number>;
  };

  const basePathRaw = vectorDbWithObs.getPath?.() ?? opts.resolvedLancePath ?? null;
  const basePath = basePathRaw ? resolve(basePathRaw) : null;

  const memoriesPath = basePath ? join(basePath, "memories.lance") : "";
  const cachePath = basePath ? join(basePath, "semantic_query_cache.lance") : "";
  const [memoriesCount, cacheCount] = await Promise.all([
    typeof vectorDbWithObs.count === "function" ? vectorDbWithObs.count().catch(() => null) : Promise.resolve(null),
    typeof vectorDbWithObs.countSemanticQueryCacheRows === "function"
      ? vectorDbWithObs.countSemanticQueryCacheRows().catch(() => null)
      : Promise.resolve(null),
  ]);

  const memoriesSize = basePath ? measurePathBytes(memoriesPath) : { bytes: null, scannedEntries: 0, truncated: false };
  const cacheSize = basePath ? measurePathBytes(cachePath) : { bytes: null, scannedEntries: 0, truncated: false };
  const totalSizeBytes = opts.lanceBytes ?? null;
  const cacheTelemetry = vectorDbWithObs.getSemanticQueryCacheTelemetry?.() ?? null;
  const cacheFragmentErrorTelemetry = vectorDbWithObs.getSemanticCacheFragmentErrorTelemetry?.() ?? null;

  return {
    capturedAt: nowIso(),
    memory: {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
      nativeRssEstimateBytes,
      procStatus,
    },
    fileDescriptors: fdStats,
    vectorDb: {
      path: basePath,
      initialized: vectorDbWithObs.isInitialized?.() ?? null,
      lanceAvailable: vectorDbWithObs.isLanceDbAvailable?.() ?? null,
      degraded: vectorDbWithObs.getDegradedState?.() ?? null,
      openReaders: vectorDbWithObs.getOpenReaderCount?.() ?? null,
      optimizing: vectorDbWithObs.isOptimizing?.() ?? null,
      search: vectorDbWithObs.getSearchTelemetry?.() ?? null,
      cache:
        cacheTelemetry == null
          ? null
          : {
              rows: cacheCount,
              maxRowsPerFilterKey: cacheTelemetry.maxRowsPerFilterKey,
              candidateLimitMax: cacheTelemetry.candidateLimitMax,
              lastFilterKey: cacheTelemetry.lastFilterKey,
              lastRemovedRows: cacheTelemetry.lastRemovedRows,
              lastPrunedAtEpochMs: cacheTelemetry.lastPrunedAtEpochMs,
            },
      cacheFragmentErrors: cacheFragmentErrorTelemetry,
      lastOptimize: vectorDbWithObs.getLastOptimizeTelemetry?.() ?? null,
      bounds: vectorDbWithObs.getRuntimeBounds?.() ?? null,
    },
    lancedb: {
      basePath,
      totalSizeBytes,
      tables: basePath
        ? [
            {
              name: "memories",
              path: memoriesPath,
              exists: existsSync(memoriesPath),
              sizeBytes: memoriesSize.bytes,
              sizeScanTruncated: memoriesSize.truncated,
              rowCount: memoriesCount,
            },
            {
              name: "semantic_query_cache",
              path: cachePath,
              exists: existsSync(cachePath),
              sizeBytes: cacheSize.bytes,
              sizeScanTruncated: cacheSize.truncated,
              rowCount: cacheCount,
            },
          ]
        : [],
    },
  };
}

export type SemanticCacheIntegrityStatus = SemanticCacheFragmentErrorTelemetry & {
  /** True when no missing-fragment error has been observed since this VectorDB instance started. */
  healthy: boolean;
};

const EMPTY_FRAGMENT_ERROR_TELEMETRY: SemanticCacheFragmentErrorTelemetry = {
  occurrences: 0,
  firstAtEpochMs: null,
  lastAtEpochMs: null,
  lastRecoveryAttemptEpochMs: null,
  lastRecoveryAction: null,
  lastRecoverySucceeded: null,
};

/**
 * Reads the semantic query cache's "missing fragment" self-heal telemetry (GlitchTip #34 / issue
 * #2213, recurred as #2227) off a VectorDB instance without side effects. `healthy` is true only
 * when no occurrence has been observed at all — a self-heal that *succeeded* still shows
 * `occurrences > 0` (informational: the table was repaired) but is reported as `healthy: true` via
 * `lastRecoverySucceeded`.
 */
export function evaluateSemanticQueryCacheIntegrity(vectorDb: VectorDB): SemanticCacheIntegrityStatus {
  const vectorDbWithTelemetry = vectorDb as unknown as {
    getSemanticCacheFragmentErrorTelemetry?: () => SemanticCacheFragmentErrorTelemetry;
  };
  const telemetry = vectorDbWithTelemetry.getSemanticCacheFragmentErrorTelemetry?.() ?? EMPTY_FRAGMENT_ERROR_TELEMETRY;
  return {
    ...telemetry,
    healthy: telemetry.occurrences === 0 || telemetry.lastRecoverySucceeded === true,
  };
}

/**
 * Health check for remediation idea #4 from issue #2227: fire a single, deduplicated GlitchTip
 * alert when the semantic query cache has had to run its "missing fragment" self-heal path, since
 * the underlying per-call error is intentionally dropped as noisy
 * (services/error-reporter/noisy-errors.ts) and would otherwise never reach an operator. Intended
 * to be called from a periodic surface (maintenance/health cron, `openclaw hybrid-mem verify`) —
 * capturePluginError's own fingerprint-based dedupe keeps repeated calls from spamming GlitchTip.
 *
 * A no-op (no report, `healthy: true`) when the cache has never hit this error class.
 */
export function reportSemanticQueryCacheIntegrityIssue(vectorDb: VectorDB): SemanticCacheIntegrityStatus {
  const status = evaluateSemanticQueryCacheIntegrity(vectorDb);
  if (status.occurrences === 0) return status;

  const first = status.firstAtEpochMs ? new Date(status.firstAtEpochMs).toISOString() : "unknown";
  const last = status.lastAtEpochMs ? new Date(status.lastAtEpochMs).toISOString() : "unknown";
  capturePluginError(
    new Error(
      `Semantic query cache hit the LanceDB "missing fragment" read-stream error ${status.occurrences} ` +
        `time(s) (first=${first}, last=${last}). Last self-heal action=${status.lastRecoveryAction ?? "none"} ` +
        `succeeded=${status.lastRecoverySucceeded ?? "unknown"}.`,
    ),
    {
      operation: "semantic-query-cache-integrity",
      subsystem: "vector",
      severity: status.healthy ? "warning" : "error",
      fingerprint: ["semantic-query-cache-integrity"],
    },
  );
  return status;
}
