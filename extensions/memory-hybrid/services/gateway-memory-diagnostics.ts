import { statSync } from "node:fs";
import v8 from "node:v8";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { resolveReregisterPolicy, reregisterMetrics } from "../setup/reregister-policy.js";
import { getStartupMemoryAttributionEntries } from "./startup-memory-attribution.js";
import { collectVectorBackendObservability } from "./vector-backend-observability.js";
import { getDirSize } from "../utils/fs.js";
import { nowIso } from "../utils/dates.js";
import { getEventLoopLagSnapshot } from "../utils/event-loop-health.js";

export type GatewayMemoryDiagnosticsContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  resolvedSqlitePath?: string;
  resolvedLancePath?: string;
  recallInFlightRef?: { value: number };
  variantQueuePending?: number;
};

export type GatewayMemoryDiagnostics = {
  generatedAt: string;
  uptimeSeconds: number;
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    nativeRssBytes: number;
  };
  v8: {
    numberOfDetachedContexts?: number;
    numberOfNativeContexts?: number;
    topHeapSpaces?: Array<{ spaceName: string; spaceUsedSize: number }>;
  };
  disk: {
    sqliteBytes: number | null;
    sqliteWalBytes: number | null;
    lanceDirBytes: number | null;
  };
  facts: {
    activeFacts: number | null;
    topSources: Array<{ source: string; count: number }> | null;
  };
  hybridMemory: {
    recallInFlight: number;
    variantQueuePending: number | null;
    reregisterPolicy: string;
    reregisterMetrics: typeof reregisterMetrics;
    vectorObservability?: Awaited<ReturnType<typeof collectVectorBackendObservability>>;
  };
  eventLoop: {
    activeHandles: number;
    activeRequests: number;
    lagMeanMs: number | null;
    lagMaxMs: number | null;
    lagP99Ms: number | null;
    health: "healthy" | "degraded" | "unknown";
    degradedThresholdMs: number;
  };
  leakHints: string[];
  startupAttribution: ReturnType<typeof getStartupMemoryAttributionEntries>;
};

function fileSizeOrNull(path: string | undefined): number | null {
  if (!path) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function walPath(sqlitePath: string | undefined): string | null {
  if (!sqlitePath) return null;
  return `${sqlitePath}-wal`;
}

function activeHandleCount(): number {
  const proc = process as NodeJS.Process & { _getActiveHandles?: () => unknown[] };
  if (typeof proc._getActiveHandles !== "function") return -1;
  return proc._getActiveHandles()?.length ?? -1;
}

function activeRequestCount(): number {
  const proc = process as NodeJS.Process & { _getActiveRequests?: () => unknown[] };
  if (typeof proc._getActiveRequests !== "function") return -1;
  return proc._getActiveRequests()?.length ?? -1;
}

function readV8HeapSpaces(): GatewayMemoryDiagnostics["v8"] {
  try {
    const stats = v8.getHeapStatistics();
    const spaces = v8
      .getHeapSpaceStatistics?.()
      ?.map((s) => ({ spaceName: s.space_name, spaceUsedSize: s.space_used_size }))
      .sort((a, b) => b.spaceUsedSize - a.spaceUsedSize)
      .slice(0, 5);
    return {
      numberOfDetachedContexts: stats.number_of_detached_contexts,
      numberOfNativeContexts: stats.number_of_native_contexts,
      topHeapSpaces: spaces,
    };
  } catch {
    return {};
  }
}

function readActiveFacts(factsDb: FactsDB): number | null {
  try {
    const db = factsDb.getRawDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM facts
         WHERE (valid_until IS NULL OR valid_until > ?)
           AND (expires_at IS NULL OR expires_at > ?)
           AND superseded_at IS NULL`,
      )
      .get(nowSec, nowSec) as { cnt: number };
    return row.cnt;
  } catch {
    return null;
  }
}

function readTopFactSources(factsDb: FactsDB): Array<{ source: string; count: number }> | null {
  try {
    const db = factsDb.getRawDb();
    const rows = db
      .prepare(
        `SELECT COALESCE(source, '(null)') AS source, COUNT(*) AS count
         FROM facts GROUP BY source ORDER BY count DESC LIMIT 5`,
      )
      .all() as Array<{ source: string; count: number }>;
    return rows;
  } catch {
    return null;
  }
}

function buildLeakHints(opts: {
  nativeRssBytes: number;
  reregisterMetrics: typeof reregisterMetrics;
  policy: string;
}): string[] {
  const hints: string[] = [];
  const nativeMb = opts.nativeRssBytes / (1024 * 1024);
  if (opts.policy !== "reuse-databases" && opts.reregisterMetrics.registrations > 1) {
    hints.push("plugin_reregister_full_teardown: set OPENCLAW_HYBRID_MEM_REREGISTER_POLICY=reuse-databases");
  }
  if (opts.reregisterMetrics.fullTeardowns > 0 && opts.policy === "reuse-databases") {
    // Attribute the teardowns to their named reasons (#2136) instead of the old generic
    // "check bootstrapSettledRef or config drift" nudge, so an operator can immediately tell an
    // intentional teardown (config_drift:<field>) from a policy violation (bootstrap_not_settled,
    // donor_handle_closed, teardown_soft_timeout, …).
    const reasons = opts.reregisterMetrics.fullTeardownReasons ?? {};
    const breakdown = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    hints.push(
      `plugin_reregister_full_teardown_despite_reuse_policy: ${
        breakdown || "reason unrecorded"
      } (config_drift:* is expected on config change; bootstrap_not_settled / donor_handle_closed / teardown_*_timeout indicate a reload-timing issue)`,
    );
  }
  if (nativeMb > 2048 && opts.reregisterMetrics.databaseReuses > 0) {
    hints.push(
      "native_rss_high_with_db_reuse: likely Lance/Rust allocator or OpenClaw plugin module reload (not Lance close/reopen)",
    );
  }
  if (opts.reregisterMetrics.fullTeardowns >= 3) {
    hints.push(
      "repeated_lance_sqlite_teardown: each full re-register can retain ~500MB-2GB native RSS until process restart",
    );
  }
  return hints;
}

/** Strip tenant/global DB details from diagnostics exposed via public HTTP API. */
export function sanitizePublicMemoryDiagnostics(diag: GatewayMemoryDiagnostics): GatewayMemoryDiagnostics {
  const vectorObs = diag.hybridMemory.vectorObservability;
  return {
    ...diag,
    facts: { activeFacts: null, topSources: null },
    startupAttribution: [],
    disk: {
      sqliteBytes: null,
      sqliteWalBytes: null,
      lanceDirBytes: null,
    },
    hybridMemory: {
      ...diag.hybridMemory,
      vectorObservability: vectorObs
        ? {
            ...vectorObs,
            fileDescriptors: vectorObs.fileDescriptors
              ? {
                  ...vectorObs.fileDescriptors,
                  lancedbPaths: [],
                  sampleTargets: {
                    lancedb: [],
                    sqlite: [],
                    wal: [],
                    shm: [],
                    socket: [],
                    pipe: [],
                    anon: [],
                    other: [],
                  },
                }
              : vectorObs.fileDescriptors,
            vectorDb: { ...vectorObs.vectorDb, path: null },
            lancedb: {
              ...vectorObs.lancedb,
              basePath: null,
              tables: vectorObs.lancedb.tables.map((t) => ({ ...t, path: "" })),
            },
          }
        : vectorObs,
    },
  };
}

export async function buildGatewayMemoryDiagnostics(
  ctx: GatewayMemoryDiagnosticsContext,
): Promise<GatewayMemoryDiagnostics> {
  const usage = process.memoryUsage();
  const nativeRssBytes = Math.max(0, usage.rss - usage.heapTotal - usage.external);
  const policy = resolveReregisterPolicy();

  let lanceDirBytes: number | null = null;
  if (ctx.resolvedLancePath) {
    try {
      lanceDirBytes = await getDirSize(ctx.resolvedLancePath);
    } catch {
      lanceDirBytes = null;
    }
  }

  const vectorObs = await collectVectorBackendObservability({
    vectorDb: ctx.vectorDb,
    resolvedLancePath: ctx.resolvedLancePath,
    lanceBytes: lanceDirBytes,
  });

  const lag = getEventLoopLagSnapshot();

  return {
    generatedAt: nowIso(),
    uptimeSeconds: Math.floor(process.uptime()),
    process: {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers ?? 0,
      nativeRssBytes,
    },
    v8: readV8HeapSpaces(),
    disk: {
      sqliteBytes: fileSizeOrNull(ctx.resolvedSqlitePath),
      sqliteWalBytes: fileSizeOrNull(walPath(ctx.resolvedSqlitePath) ?? undefined),
      lanceDirBytes,
    },
    facts: {
      activeFacts: readActiveFacts(ctx.factsDb),
      topSources: readTopFactSources(ctx.factsDb),
    },
    hybridMemory: {
      recallInFlight: ctx.recallInFlightRef?.value ?? 0,
      variantQueuePending: ctx.variantQueuePending ?? null,
      reregisterPolicy: policy,
      // Deep-copy the nested reason map so the snapshot is a true point-in-time value and does
      // not alias the live, still-mutating reregisterMetrics.fullTeardownReasons (#2136 QA).
      reregisterMetrics: { ...reregisterMetrics, fullTeardownReasons: { ...reregisterMetrics.fullTeardownReasons } },
      vectorObservability: vectorObs,
    },
    eventLoop: {
      activeHandles: activeHandleCount(),
      activeRequests: activeRequestCount(),
      lagMeanMs: lag.meanMs,
      lagMaxMs: lag.maxMs,
      lagP99Ms: lag.p99Ms,
      health: lag.health,
      degradedThresholdMs: lag.degradedThresholdMs,
    },
    leakHints: buildLeakHints({ nativeRssBytes, reregisterMetrics, policy }),
    startupAttribution: getStartupMemoryAttributionEntries(),
  };
}

/** Compact process snapshot for legacy monitoring clients. */
export function buildProcessMemorySnapshot(): Pick<
  GatewayMemoryDiagnostics,
  "generatedAt" | "uptimeSeconds" | "process" | "eventLoop"
> {
  const usage = process.memoryUsage();
  const lag = getEventLoopLagSnapshot();
  return {
    generatedAt: nowIso(),
    uptimeSeconds: Math.floor(process.uptime()),
    process: {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers ?? 0,
      nativeRssBytes: Math.max(0, usage.rss - usage.heapTotal - usage.external),
    },
    eventLoop: {
      activeHandles: activeHandleCount(),
      activeRequests: activeRequestCount(),
      lagMeanMs: lag.meanMs,
      lagMaxMs: lag.maxMs,
      lagP99Ms: lag.p99Ms,
      health: lag.health,
      degradedThresholdMs: lag.degradedThresholdMs,
    },
  };
}
