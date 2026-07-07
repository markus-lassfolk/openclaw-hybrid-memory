/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphConnectedStats } from "../../../backends/facts-db/links.js";
import type { ProcedurePromotionBlockReason } from "../../../backends/facts-db/procedures.js";
import { expandGraph, type GraphExpansionStats, resolveGraphHubDegreeCap } from "../../../services/graph-retrieval.js";
import type { MemoryEntry, ScopeFilter } from "../../../types/memory.js";
import { nowIso } from "../../../utils/dates.js";
import { isEntityStopWord } from "../../../utils/entity-stopwords.js";
import { globalOnlyScopeFilter } from "../../../utils/scope-filter.js";
import { SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER } from "../../cmd-feedback.js";
import type { ManageBindings } from "./bindings.js";
/** Max rows sampled for implicit-feedback prefix histogram (#1193); keeps audit bounded on huge pattern tables. */
export const IMPLICIT_FEEDBACK_HISTOGRAM_SAMPLE_CAP = 20_000;
/**
 * Legacy category aliases observed in long-lived stores.
 * These are treated as intentionally remappable when their configured
 * canonical targets exist, so audit health can avoid strict-mode noise
 * while still surfacing counts in categories.unknown.
 */
const LEGACY_CATEGORY_REMAPS: Readonly<Record<string, string>> = {
  forge_busy: "forge",
  forge_dispatch: "forge",
  forge_ops: "forge",
  episode: "ops_summary",
};

export type ReindexCheckpoint = {
  offset: number;
  total: number;
  migrated: number;
  skipped: number;
  ts: number;
};

export function defaultReindexCheckpointPath(resolvedSqlitePath: string): string {
  return join(dirname(resolvedSqlitePath), ".reindex_checkpoint.json");
}

export function readReindexCheckpoint(path: string): ReindexCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReindexCheckpoint>;
    if (
      typeof parsed.offset === "number" &&
      typeof parsed.total === "number" &&
      typeof parsed.migrated === "number" &&
      typeof parsed.skipped === "number" &&
      typeof parsed.ts === "number"
    ) {
      return {
        offset: Math.max(0, Math.floor(parsed.offset)),
        total: Math.max(0, Math.floor(parsed.total)),
        migrated: Math.max(0, Math.floor(parsed.migrated)),
        skipped: Math.max(0, Math.floor(parsed.skipped)),
        ts: Math.max(0, Math.floor(parsed.ts)),
      };
    }
  } catch {
    // ignore malformed checkpoints; caller treats as absent
  }
  return null;
}

export function writeReindexCheckpoint(path: string, state: ReindexCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Persisted metrics from the last `reembed-vectorless --apply` run.
 * Written alongside the SQLite database so audit-health can surface
 * actionable progress context when the vectorless SLO is breached.
 */
export type ReembedVectorlessLastRunMetrics = {
  /** ISO timestamp of the run. */
  ts: string;
  embedded: number;
  skipped: number;
  embedFailures: number;
  storeFailures: number;
  before: number;
  after: number;
  activeFacts: number;
  durationMs: number;
  aborted: boolean;
  failedReason?: string;
  vectorSloRepair: {
    vectorlessBefore: number;
    vectorlessAfter: number;
    vectorlessRatioAfter: number;
    targetVectorlessRatio: number;
    vectorlessToClearForSlo: number;
    estimatedRunsToReachSlo: number;
    recommendedLimitNextRun: number;
    recommendedBatchSizeNextRun: number;
    sloMetAfterRun: boolean;
  };
};

export function defaultReembedVectorlessMetricsPath(resolvedSqlitePath: string): string {
  return join(dirname(resolvedSqlitePath), ".reembed-vectorless-last-run.json");
}

export function readReembedVectorlessMetrics(path: string): ReembedVectorlessLastRunMetrics | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReembedVectorlessLastRunMetrics>;
    const slo = parsed.vectorSloRepair;
    if (
      typeof parsed.ts === "string" &&
      typeof parsed.embedded === "number" &&
      typeof parsed.after === "number" &&
      slo != null &&
      typeof slo.estimatedRunsToReachSlo === "number" &&
      typeof slo.sloMetAfterRun === "boolean" &&
      typeof slo.vectorlessRatioAfter === "number" &&
      typeof slo.vectorlessToClearForSlo === "number" &&
      typeof slo.recommendedLimitNextRun === "number"
    ) {
      return parsed as ReembedVectorlessLastRunMetrics;
    }
  } catch {
    // ignore malformed file; treat as absent
  }
  return null;
}

export function writeReembedVectorlessMetrics(path: string, metrics: ReembedVectorlessLastRunMetrics): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(metrics, null, 2), "utf-8");
}

export function parseBoundedIntOption(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? fallback), 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

export function parseBoundedFloatOption(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(String(raw ?? fallback));
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function formatRatioPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatVectorLifecycleSloBreach(breach: AuditHealthReport["vectorLifecycleSlo"]["breaches"][number]): string {
  if (breach.key === "vectorless_ratio") {
    return `${breach.key} actual=${breach.actual} (${formatRatioPercent(breach.actual)}) target=${breach.target} (${formatRatioPercent(breach.target)})`;
  }
  return `${breach.key} actual=${breach.actual} target=${breach.target}`;
}

type SyncBundleFile = {
  path: string;
  contentBase64: string;
};

const SYNC_BUNDLE_MIN_ITERATIONS = 100_000;
const SYNC_BUNDLE_MAX_ITERATIONS = 2_000_000;
const SYNC_BUNDLE_SALT_BYTES = 16;
const SYNC_BUNDLE_IV_BYTES = 12;
const SYNC_BUNDLE_TAG_BYTES = 16;

export function collectExportBundleFiles(root: string, dir = root): SyncBundleFile[] {
  const files: SyncBundleFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const fullPath = join(dir, name);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      files.push(...collectExportBundleFiles(root, fullPath));
      continue;
    }
    if (!st.isFile()) continue;
    const rel = fullPath.slice(root.length + 1).replace(/\\/g, "/");
    files.push({ path: rel, contentBase64: readFileSync(fullPath).toString("base64") });
  }
  return files;
}

function decodeRequiredBase64Field(envelope: Record<string, unknown>, field: string, expectedBytes?: number): Buffer {
  const raw = envelope[field];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`sync bundle field ${field} must be a non-empty base64 string`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw new Error(`sync bundle field ${field} is not valid base64`);
  }
  const decoded = Buffer.from(raw, "base64");
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new Error(`sync bundle field ${field} must decode to ${expectedBytes} bytes`);
  }
  if (expectedBytes === undefined && decoded.length === 0) {
    throw new Error(`sync bundle field ${field} must not be empty`);
  }
  return decoded;
}

export function validateSyncEnvelope(raw: unknown): {
  schemaVersion: 1;
  type: "hybrid-memory-sync-bundle";
  alg: "aes-256-gcm";
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sync bundle must be a JSON object");
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.schemaVersion !== 1) throw new Error("unsupported sync bundle schemaVersion");
  if (envelope.type !== "hybrid-memory-sync-bundle") throw new Error("unsupported sync bundle type");
  if (envelope.alg !== "aes-256-gcm") throw new Error("unsupported sync bundle algorithm");
  if (envelope.kdf !== "pbkdf2-sha256") throw new Error("unsupported sync bundle KDF");
  const iterations = envelope.iterations;
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < SYNC_BUNDLE_MIN_ITERATIONS ||
    iterations > SYNC_BUNDLE_MAX_ITERATIONS
  ) {
    throw new Error(
      `sync bundle iterations must be an integer between ${SYNC_BUNDLE_MIN_ITERATIONS} and ${SYNC_BUNDLE_MAX_ITERATIONS}`,
    );
  }
  return {
    schemaVersion: 1,
    type: "hybrid-memory-sync-bundle",
    alg: "aes-256-gcm",
    kdf: "pbkdf2-sha256",
    iterations,
    salt: decodeRequiredBase64Field(envelope, "salt", SYNC_BUNDLE_SALT_BYTES),
    iv: decodeRequiredBase64Field(envelope, "iv", SYNC_BUNDLE_IV_BYTES),
    tag: decodeRequiredBase64Field(envelope, "tag", SYNC_BUNDLE_TAG_BYTES),
    ciphertext: decodeRequiredBase64Field(envelope, "ciphertext"),
  };
}

/**
 * Insert one `storage_growth_history` row per UTC calendar day (idempotent).
 * Enables `audit health` 7d deltas when combined with daily cron (#audit remediation).
 */
export function recordStorageGrowthSample(
  factsDb: ManageBindings["factsDb"],
  lanceBytes: number | null,
  opts?: { force?: boolean; dryRun?: boolean },
): {
  inserted: boolean;
  recordedAt: number;
  sampleId: number | null;
  status: "recorded" | "skipped" | "dry_run";
  reason: "already_sampled_today" | "storage_unavailable" | null;
  sample: {
    recordedAt: number;
    sqliteBytes: number | null;
    lanceBytes: number | null;
    linkCount: number;
    factCount: number;
  };
} {
  const raw = factsDb.getRawDb?.();
  const nowSecReport = Math.floor(Date.now() / 1000);
  const storageBytes = factsDb.estimateStorageBytes?.();
  const activeFacts = factsDb.getCount();
  const linkCountTotal = raw
    ? Number((raw.prepare("SELECT COUNT(*) AS c FROM memory_links").get() as { c: number } | undefined)?.c ?? 0)
    : 0;
  const sample = {
    recordedAt: nowSecReport,
    sqliteBytes: storageBytes?.sqliteBytes ?? null,
    lanceBytes,
    linkCount: linkCountTotal,
    factCount: activeFacts,
  };
  if (!raw) {
    return {
      inserted: false,
      recordedAt: nowSecReport,
      sampleId: null,
      status: "skipped",
      reason: "storage_unavailable",
      sample,
    };
  }
  if (opts?.dryRun) {
    return {
      inserted: false,
      recordedAt: nowSecReport,
      sampleId: null,
      status: "dry_run",
      reason: null,
      sample,
    };
  }
  const d = new Date();
  const startOfDayUtc = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
  // The not-yet-sampled-today check and the insert are combined into one statement so a
  // concurrent process (e.g. a cron audit-health run overlapping a manual invocation) can't
  // interleave between a separate SELECT and INSERT and create two rows for the same day.
  const insertSql = opts?.force
    ? "INSERT INTO storage_growth_history (recorded_at, sqlite_bytes, lance_bytes, link_count, fact_count) VALUES (?, ?, ?, ?, ?)"
    : `INSERT INTO storage_growth_history (recorded_at, sqlite_bytes, lance_bytes, link_count, fact_count)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM storage_growth_history WHERE recorded_at >= ?)`;
  const insertParams = opts?.force
    ? [sample.recordedAt, sample.sqliteBytes, sample.lanceBytes, sample.linkCount, sample.factCount]
    : [sample.recordedAt, sample.sqliteBytes, sample.lanceBytes, sample.linkCount, sample.factCount, startOfDayUtc];
  const insertResult = raw.prepare(insertSql).run(...insertParams) as {
    changes?: number | bigint;
    lastInsertRowid?: number | bigint;
  };
  if (Number(insertResult.changes ?? 0) === 0) {
    return {
      inserted: false,
      recordedAt: nowSecReport,
      sampleId: null,
      status: "skipped",
      reason: "already_sampled_today",
      sample,
    };
  }
  const sampleId = insertResult.lastInsertRowid ? Number(insertResult.lastInsertRowid) : null;
  return {
    inserted: true,
    recordedAt: nowSecReport,
    sampleId,
    status: "recorded",
    reason: null,
    sample,
  };
}

/**
 * Build a `ScopeFilter` from the `hybrid-mem search --scope/--scope-target` CLI options.
 *
 * SECURITY: `scopeFilterClausePositional`/`filterByScope` treat a filter with no
 * userId/agentId/sessionId as "no restriction" (matches every scope) — a plain `{}` for
 * `--scope global` would silently return every user's/agent's/session's facts instead of only
 * global-scoped ones. `globalOnlyScopeFilter()`'s sentinel agentId is the established idiom for
 * expressing "global only" under that same read-path semantic (see
 * services/memory-corpus-supplement.ts and friends).
 */
export function buildHybridSearchScopeFilter(scope?: string, scopeTarget?: string): ScopeFilter | undefined {
  if (!scope) return undefined;
  if (scope === "global") return globalOnlyScopeFilter();
  const filter: ScopeFilter = {};
  if (scope === "user") filter.userId = scopeTarget || null;
  else if (scope === "agent") filter.agentId = scopeTarget || null;
  else if (scope === "session") filter.sessionId = scopeTarget || null;
  return filter;
}

/** Apply optional CLI filters to merged hybrid search results (category/entity/key/source/tier). */
export function entryMatchesHybridSearchFilters(
  entry: MemoryEntry,
  opts?: {
    category?: string;
    entity?: string;
    key?: string;
    source?: string;
    tier?: string;
  },
): boolean {
  if (!opts) return true;
  if (opts.category && entry.category !== opts.category) return false;
  if (opts.entity != null && opts.entity !== "" && entry.entity !== opts.entity) return false;
  if (opts.key != null && opts.key !== "" && entry.key !== opts.key) return false;
  if (opts.source != null && opts.source !== "" && entry.source !== opts.source) return false;
  if (opts.tier != null && opts.tier !== "" && entry.tier !== opts.tier) return false;
  return true;
}

export type AuditHealthReport = {
  schemaVersion: 1;
  generatedAt: string;
  /** "ok" when no warnings and no generation errors; "partial" when degraded (warnings, timeouts, or non-fatal errors). */
  status: "ok" | "partial" | "failed";
  /** @deprecated Use `status` instead. Kept for backward compatibility. */
  ok: boolean;
  warningCount: number;
  errorCount: number;
  activeFacts: number;
  /** Age (in days) of the oldest active fact. Used to gate sparse-store warnings (#1193). */
  storeAgeDays: number;
  canonicalEmbeddings: number;
  vectorless: number;
  vectorlessBySource: Array<{ source: string; count: number }>;
  procedures: {
    total: number;
    validated: number;
    promoted: number;
    validatedNotPromoted: number;
    blocked: number;
    topBlockReason: string | null;
    /** Breakdown of blocked (validated, not-promoted) procedures by block reason. */
    byBlockReason: Record<ProcedurePromotionBlockReason, number>;
  };
  graphHubs: Array<{
    id: string;
    outDegree: number;
    textPreview: string | null;
    overCap: boolean;
    eventTypeHistogram: Record<string, number>;
  }>;
  structuralEligibleWarmFacts: number;
  patternBloat: {
    implicitFeedbackPatterns: number;
    /** Top 5 leading-token prefixes for implicit-feedback rows (legacy category=pattern and trajectory lessons, #1193, #1736). */
    implicitFeedbackPrefixHistogram: Array<{ prefix: string; count: number }>;
  };
  entityStopwordMatches: Array<{ entity: string; count: number }>;
  /** Top entities with configured stop-words removed (retrieval-aligned view, #1193). */
  topEntitiesFiltered: Array<{ entity: string; count: number }>;
  storage: {
    sqliteBytes: number | null;
    walBytes: number | null;
    shmBytes: number | null;
    /** LanceDB directory size on disk in bytes (#1193). */
    lanceBytes: number | null;
  };
  storageGrowth: {
    lastSampleAt: number | null;
    delta7d: {
      sqliteBytes: number | null;
      lanceBytes: number | null;
      linkCount: number | null;
      factCount: number | null;
    } | null;
    /** Lance bytes per week derived from delta7d (null when unknown). */
    lanceBytesPerWeekDelta: number | null;
  };
  implicitFeedbackSignalNoise: {
    rowsPerDay30d: Record<string, number>;
    paraphraseRatio: number | null;
  };
  tiers: Record<string, number>;
  decay: Record<string, number>;
  /**
   * Stickiness ratio: `(stable + permanent) / activeFacts`. Surfaced separately from `decay` so
   * dashboards can render a single number and gate the 60% warning (#1193).
   */
  stableStickiness: { stablePermanent: number; activeFacts: number; ratio: number };
  vectorIntegrity: {
    score: number;
    degraded: boolean;
    degradedReason: string | null;
    vectorlessRatio: number;
    orphanSignals: {
      sqliteFactsWithoutCanonicalEmbedding: number;
    };
  };
  vectorLifecycleSlo: {
    targets: {
      maxVectorlessRatio: number;
      minIntegrityScore: number;
    };
    breaches: Array<{ key: "vectorless_ratio" | "integrity_score"; actual: number; target: number }>;
    /** Metrics from the last completed `reembed-vectorless --apply` run, if available. */
    lastReembedProgress: ReembedVectorlessLastRunMetrics | null;
  };
  categories: {
    configured: string[];
    present: string[];
    /** Per-category drift counts so the JSON consumer doesn't need to re-query (#1193). */
    unknown: Array<{ category: string; count: number }>;
  };
  sources: Record<string, number>;
  implicitFeedbackTrajectorySignals: number;
  graphHubGuard: {
    configuredCap: number | null | undefined;
    effectiveCap: number | null;
    connectedProbe: GraphConnectedStats;
    expansionProbe: GraphExpansionStats;
  } | null;
  /**
   * Entity enrichment backlog summary (#1806). `null` when the query could not run (timeout/budget).
   * `estimatedRunsRemaining` uses the default enrichment limit of 200 for ETA computation.
   */
  entityEnrichmentBacklog: {
    total: number;
    byTier: { hot: number; warm: number; structural: number; cold: number; unknown: number };
    estimatedRunsRemaining: number;
  } | null;
  warnings: string[];
  remediation: string[];
  /** Errors encountered during report generation (e.g., timeouts, query failures). */
  errors: Array<{ section: string; message: string }>;
  /** Credentials vault encryption status summary. Null when vault is disabled. */
  credentials: {
    encryptedAtRest: boolean;
    kdfVersion: number;
    entryCount: number;
    migrationRequired: boolean;
  } | null;
  /** Optional operator budget used for audit-health command execution. */
  timeoutMs?: number;
  /** Elapsed wall-clock time spent building the report. */
  elapsedMs?: number;
};

export function countImplicitFeedbackTrajectorySignals(factsDb: ManageBindings["factsDb"]): number {
  const raw = factsDb.getRawDb?.();
  if (!raw) return 0;
  const row = raw
    .prepare(
      `SELECT COUNT(*) as cnt FROM facts WHERE source = 'implicit-feedback' AND superseded_at IS NULL AND ${SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER}`,
    )
    .get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function buildAuditHealthReport(
  factsDb: ManageBindings["factsDb"],
  getMemoryCategories: () => readonly string[],
  entityStopWords: readonly string[] = [],
  graphHubDegreeCap?: number | null,
  options?: {
    lanceBytes?: number | null;
    preReportErrors?: Array<{ section: string; message: string }>;
    preReportWarnings?: string[];
    timeoutMs?: number;
    startedAtMs?: number;
    deadlineMs?: number;
    degradedState?: { active: boolean; reason: string | null };
    credentialsStatus?: {
      encryptedAtRest: boolean;
      kdfVersion: number;
      entryCount: number;
      migrationRequired: boolean;
    } | null;
    lastReembedProgress?: ReembedVectorlessLastRunMetrics | null;
  },
): AuditHealthReport {
  const startedAtMs = options?.startedAtMs ?? Date.now();
  const deadlineMs = options?.deadlineMs;
  const errors: Array<{ section: string; message: string }> = [...(options?.preReportErrors ?? [])];
  const timeoutRecorded = new Set<string>();
  const hasBudget = (section: string): boolean => {
    if (deadlineMs == null || Date.now() <= deadlineMs) return true;
    if (!timeoutRecorded.has(section)) {
      timeoutRecorded.add(section);
      errors.push({
        section,
        message: `Skipped: audit-health timeout budget exceeded${options?.timeoutMs ? ` (${options.timeoutMs}ms)` : ""}`,
      });
    }
    return false;
  };
  const capForHubListing = graphHubDegreeCap === undefined ? 500 : graphHubDegreeCap;
  const activeFacts = factsDb.getCount();
  const canonicalEmbeddings = factsDb.countCanonicalEmbeddings();
  const procedures = factsDb.proceduresCount();
  const validated = factsDb.proceduresValidatedCount();
  const promoted = factsDb.proceduresPromotedCount();
  const tiers = factsDb.statsBreakdownByTier();
  const decay = factsDb.statsBreakdownByDecayClass();
  const present = factsDb.uniqueMemoryCategories().slice().sort();
  const configured = [...getMemoryCategories()].slice().sort();
  const configuredSet = new Set(configured);
  const sources = factsDb.statsBySource();
  const implicitFeedbackTrajectorySignals = countImplicitFeedbackTrajectorySignals(factsDb);
  const vectorless = factsDb.countVectorlessActiveFacts();
  const vectorlessBySource = factsDb.vectorlessActiveFactsBySource(10);
  const procedureTriage = factsDb.triageProcedures({ status: "validated", notPromoted: true, limit: 10_000 });
  const raw = factsDb.getRawDb?.();

  // #1193: surface per-category drift counts directly so JSON consumers do not need to re-query.
  const unknown: Array<{ category: string; count: number }> = (() => {
    const drift = present.filter((category: string) => !configuredSet.has(category));
    if (drift.length === 0) return [];
    if (!raw || !hasBudget("categories.unknown")) return drift.map((category) => ({ category, count: 0 }));
    return drift.map((category) => {
      const row = raw
        .prepare(`SELECT COUNT(*) AS cnt FROM facts WHERE COALESCE(category, 'other') = ? AND superseded_at IS NULL`)
        .get(category) as { cnt: number } | undefined;
      return { category, count: Number(row?.cnt ?? 0) };
    });
  })();
  const unconfiguredCategories = unknown.filter((row) => {
    const mappedTarget = LEGACY_CATEGORY_REMAPS[row.category];
    return !mappedTarget || !configuredSet.has(mappedTarget);
  });

  // #1193: store age (days) gates sparse-store warnings — a brand-new install with hot=0 is
  // expected, and the operator should not get a "memory is broken" warning during the first
  // two weeks while the store warms up.
  const oldestRow =
    raw != null
      ? (raw.prepare("SELECT MIN(created_at) AS oldest FROM facts WHERE superseded_at IS NULL").get() as
          | { oldest: number | null }
          | undefined)
      : undefined;
  const nowSecForAge = Math.floor(Date.now() / 1000);
  const storeAgeDays = oldestRow?.oldest != null ? Math.max(0, (nowSecForAge - oldestRow.oldest) / 86400) : 0;
  const graphHubs =
    raw && hasBudget("graphHubs")
      ? (
          raw
            .prepare(
              `SELECT ml.source_fact_id AS id, COUNT(*) AS cnt, SUBSTR(f.text, 1, 120) AS text_preview
             FROM memory_links ml
             LEFT JOIN facts f ON f.id = ml.source_fact_id
            WHERE ml.link_type != 'CONTRADICTS'
            GROUP BY ml.source_fact_id
            ORDER BY cnt DESC
            LIMIT 10`,
            )
            .all() as Array<{ id: string; cnt: number; text_preview: string | null }>
        ).map((row) => {
          const eventTypeHistogram: Record<string, number> = {};
          if (raw) {
            const pr = raw.prepare("SELECT provenance_json FROM facts WHERE id = ?").get(row.id) as
              | { provenance_json: string | null }
              | undefined;
            if (pr?.provenance_json) {
              try {
                const parsed = JSON.parse(pr.provenance_json) as { sourceEvents?: Array<{ eventType?: string }> };
                for (const ev of parsed.sourceEvents ?? []) {
                  const t = typeof ev.eventType === "string" && ev.eventType ? ev.eventType : "unknown";
                  eventTypeHistogram[t] = (eventTypeHistogram[t] ?? 0) + 1;
                }
              } catch {
                /* ignore malformed provenance */
              }
            }
          }
          return {
            id: row.id,
            outDegree: Number(row.cnt ?? 0),
            textPreview: row.text_preview ?? null,
            overCap: capForHubListing != null && Number(row.cnt ?? 0) > capForHubListing,
            eventTypeHistogram,
          };
        })
      : [];
  const structuralEligibleWarmFacts = raw
    ? Number(
        (
          raw
            .prepare(
              `SELECT COUNT(*) AS cnt FROM facts
              WHERE superseded_at IS NULL
                AND (expires_at IS NULL OR expires_at > ?)
                AND TRIM(COALESCE(key, '')) != ''
                AND TRIM(COALESCE(value, '')) != ''
                AND NOT (key = 'implicit_feedback_signal')
                AND COALESCE(tier, 'warm') = 'warm'`,
            )
            .get(Math.floor(Date.now() / 1000)) as { cnt: number } | undefined
        )?.cnt ?? 0,
      )
    : 0;
  const implicitFeedbackPatterns = raw
    ? Number(
        (
          raw
            .prepare(
              `SELECT COUNT(*) AS cnt FROM facts
              WHERE superseded_at IS NULL
                AND category = 'pattern'
                AND source = 'implicit-feedback'`,
            )
            .get() as { cnt: number } | undefined
        )?.cnt ?? 0,
      )
    : 0;
  // #1193, #1736: aggregate the leading 6 tokens of implicit-feedback rows (legacy category=pattern
  // and modern trajectory lessons) to surface "should never store" duplicate prefixes (e.g. paraphrases
  // of the same self-correction) without scanning every row.
  // LIMIT added to prevent hanging on long-lived stores with thousands of implicit-feedback patterns.
  const implicitFeedbackPrefixHistogram: Array<{ prefix: string; count: number }> = (() => {
    if (!raw || !hasBudget("implicitFeedbackPrefixHistogram")) return [];
    const cap = IMPLICIT_FEEDBACK_HISTOGRAM_SAMPLE_CAP;
    try {
      // Fetch cap + 1 rows so we only flag truncation when another row exists (exactly `cap` rows is not truncated).
      // Include both legacy category=pattern rows and modern trajectory lesson rows (#1736).
      const rows = raw
        .prepare(
          `SELECT text FROM facts
           WHERE superseded_at IS NULL AND source = 'implicit-feedback'
             AND (category = 'pattern' OR (${SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER}))
           LIMIT ?`,
        )
        .all(cap + 1) as Array<{ text: string | null }>;
      const truncated = rows.length > cap;
      const forAgg = truncated ? rows.slice(0, cap) : rows;
      if (forAgg.length === 0) return [];
      const counts = new Map<string, number>();
      for (const row of forAgg) {
        const text = (row.text ?? "").trim().toLowerCase();
        if (!text) continue;
        const tokens = text.split(/\s+/).slice(0, 6).join(" ");
        const prefix = tokens.length > 0 ? tokens.slice(0, 80) : "<empty>";
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
      const result = [...counts.entries()]
        .map(([prefix, count]) => ({ prefix, count }))
        .filter((row) => row.count >= 2)
        .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix))
        .slice(0, 5);
      if (truncated) {
        const totalSampled = Number(
          (
            raw
              .prepare(
                `SELECT COUNT(*) AS cnt FROM facts
                 WHERE superseded_at IS NULL AND source = 'implicit-feedback'
                   AND (category = 'pattern' OR (${SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER}))`,
              )
              .get() as { cnt: number } | undefined
          )?.cnt ?? 0,
        );
        errors.push({
          section: "implicitFeedbackPrefixHistogram",
          message: `Truncated: histogram sampled first ${cap} of ${totalSampled} implicit-feedback row(s)`,
        });
      }
      return result;
    } catch (err) {
      errors.push({
        section: "implicitFeedbackPrefixHistogram",
        message: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  })();
  const entityStopwordMatches = factsDb
    .topEntities(50)
    .filter((row) => isEntityStopWord(row.entity, entityStopWords))
    .slice(0, 10);
  const topEntitiesFiltered = factsDb.topEntitiesFiltered(10, entityStopWords);
  const storageBytes = factsDb.estimateStorageBytes?.();
  const lanceBytes = options?.lanceBytes ?? null;
  const nowSecReport = Math.floor(Date.now() / 1000);

  let storageGrowth: AuditHealthReport["storageGrowth"] = {
    lastSampleAt: null,
    delta7d: null,
    lanceBytesPerWeekDelta: null,
  };
  if (raw && hasBudget("storageGrowth")) {
    recordStorageGrowthSample(factsDb, lanceBytes);
    const lastRow = raw
      .prepare("SELECT recorded_at FROM storage_growth_history ORDER BY recorded_at DESC LIMIT 1")
      .get() as { recorded_at: number } | undefined;
    const latestSnap = raw
      .prepare(
        "SELECT sqlite_bytes, lance_bytes, link_count, fact_count, recorded_at FROM storage_growth_history ORDER BY recorded_at DESC LIMIT 1",
      )
      .get() as
      | {
          sqlite_bytes: number | null;
          lance_bytes: number | null;
          link_count: number | null;
          fact_count: number;
          recorded_at: number;
        }
      | undefined;
    const cutoff7d = nowSecReport - 7 * 86400;
    const baselineSnap = raw
      .prepare(
        "SELECT sqlite_bytes, lance_bytes, link_count, fact_count, recorded_at FROM storage_growth_history WHERE recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1",
      )
      .get(cutoff7d) as
      | {
          sqlite_bytes: number | null;
          lance_bytes: number | null;
          link_count: number | null;
          fact_count: number;
          recorded_at: number;
        }
      | undefined;

    let delta7d: AuditHealthReport["storageGrowth"]["delta7d"] = null;
    if (latestSnap && baselineSnap && latestSnap.recorded_at !== baselineSnap.recorded_at) {
      delta7d = {
        sqliteBytes:
          latestSnap.sqlite_bytes != null && baselineSnap.sqlite_bytes != null
            ? latestSnap.sqlite_bytes - baselineSnap.sqlite_bytes
            : null,
        lanceBytes:
          latestSnap.lance_bytes != null && baselineSnap.lance_bytes != null
            ? latestSnap.lance_bytes - baselineSnap.lance_bytes
            : null,
        linkCount:
          latestSnap.link_count != null && baselineSnap.link_count != null
            ? latestSnap.link_count - baselineSnap.link_count
            : null,
        factCount: latestSnap.fact_count - baselineSnap.fact_count,
      };
    }
    const ageWeeks =
      latestSnap && baselineSnap && latestSnap.recorded_at !== baselineSnap.recorded_at
        ? (latestSnap.recorded_at - baselineSnap.recorded_at) / (7 * 86400)
        : 0;
    const lanceBytesPerWeekDelta =
      delta7d?.lanceBytes != null && ageWeeks > 0 ? Math.round(delta7d.lanceBytes / ageWeeks) : null;
    storageGrowth = { lastSampleAt: lastRow?.recorded_at ?? null, delta7d, lanceBytesPerWeekDelta };
  }

  const implicitFeedbackSignalNoise: AuditHealthReport["implicitFeedbackSignalNoise"] =
    raw && hasBudget("implicitFeedbackSignalNoise")
      ? (() => {
          const since30d = nowSecReport - 30 * 86400;
          const perDayRows = raw
            .prepare(
              `SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS cnt FROM facts
             WHERE source = 'implicit-feedback' AND superseded_at IS NULL AND created_at >= ?
             GROUP BY day`,
            )
            .all(since30d) as Array<{ day: string; cnt: number }>;
          const rowsPerDay30d: Record<string, number> = {};
          for (const r of perDayRows) rowsPerDay30d[String(r.day)] = Number(r.cnt ?? 0);
          const pr = raw
            .prepare(
              `SELECT COUNT(*) AS total, COUNT(DISTINCT normalized_hash) AS dist FROM facts
             WHERE source = 'implicit-feedback' AND superseded_at IS NULL AND created_at >= ?`,
            )
            .get(since30d) as { total: number; dist: number };
          const paraphraseRatio = pr.total > 0 ? pr.dist / pr.total : null;
          return { rowsPerDay30d, paraphraseRatio };
        })()
      : { rowsPerDay30d: {}, paraphraseRatio: null };

  // #1193: stickiness flag is `(stable + permanent) / activeFacts > 0.6`. The previous 50%
  // stable-only rule fired for healthy stores (because `permanent` decisions are normal).
  const stablePermanentCount = (decay.stable ?? 0) + (decay.permanent ?? 0);
  const stableStickinessRatio = activeFacts > 0 ? stablePermanentCount / activeFacts : 0;
  const stableStickiness = {
    stablePermanent: stablePermanentCount,
    activeFacts,
    ratio: stableStickinessRatio,
  };
  const vectorlessRatio = activeFacts > 0 ? vectorless / activeFacts : 0;
  const degraded = options?.degradedState?.active === true;
  const degradedReason = options?.degradedState?.reason ?? null;
  let integrityScore = 100;
  integrityScore -= Math.min(60, Math.round(vectorlessRatio * 100));
  if (degraded) integrityScore -= 30;
  if (errors.length > 0) integrityScore -= Math.min(20, errors.length * 5);
  integrityScore = Math.max(0, Math.min(100, integrityScore));
  const vectorLifecycleSloTargets = {
    maxVectorlessRatio: 0.02,
    minIntegrityScore: 85,
  } as const;
  const vectorLifecycleSloBreaches: AuditHealthReport["vectorLifecycleSlo"]["breaches"] = [];
  if (vectorlessRatio > vectorLifecycleSloTargets.maxVectorlessRatio) {
    vectorLifecycleSloBreaches.push({
      key: "vectorless_ratio",
      actual: Number(vectorlessRatio.toFixed(4)),
      target: vectorLifecycleSloTargets.maxVectorlessRatio,
    });
  }
  if (integrityScore < vectorLifecycleSloTargets.minIntegrityScore) {
    vectorLifecycleSloBreaches.push({
      key: "integrity_score",
      actual: integrityScore,
      target: vectorLifecycleSloTargets.minIntegrityScore,
    });
  }

  const warnings: string[] = [...(options?.preReportWarnings ?? [])];
  // #1193: gate hot=0/structural=0 warnings on storeAgeDays > 14 to avoid false positives during
  // the first 14 days of a fresh install (no facts have aged into warm/cold yet).
  if (storeAgeDays > 14) {
    if ((tiers.hot ?? 0) === 0)
      warnings.push("No HOT tier facts detected; tiering may not be promoting active memory.");
    if ((tiers.structural ?? 0) === 0)
      warnings.push("No STRUCTURAL tier facts detected; key/value facts may be stuck in warm tier.");
  }
  if (activeFacts > 0 && stableStickinessRatio > 0.6) {
    warnings.push(
      `${(stableStickinessRatio * 100).toFixed(1)}% of active facts are stable+permanent — decay reclassifier may need to run.`,
    );
  }
  if (unconfiguredCategories.length > 0)
    warnings.push(
      `Unconfigured categories present in DB: ${unconfiguredCategories.map((u) => `${u.category}=${u.count}`).join(", ")}`,
    );
  if (graphHubs.some((hub) => hub.overCap))
    warnings.push(
      `${graphHubs.filter((hub) => hub.overCap).length} graph hub(s) exceed degree cap ${capForHubListing}.`,
    );
  if (structuralEligibleWarmFacts > 100)
    warnings.push(
      `${structuralEligibleWarmFacts} warm fact(s) qualify for structural tier (non-empty key+value; implicit_feedback_signal excluded) but are not structural yet.`,
    );
  if (implicitFeedbackPatterns > 1000)
    warnings.push(`${implicitFeedbackPatterns} implicit-feedback pattern fact(s) may indicate pattern bloat.`);
  if (implicitFeedbackPrefixHistogram.length > 0 && implicitFeedbackPrefixHistogram[0].count >= 10)
    warnings.push(
      `Implicit-feedback patterns share a "${implicitFeedbackPrefixHistogram[0].prefix}…" prefix ${implicitFeedbackPrefixHistogram[0].count}× — likely paraphrase duplicates.`,
    );
  if (entityStopwordMatches.length > 0)
    warnings.push(
      `Top entities include stop-word-like labels: ${entityStopwordMatches.map((row) => row.entity).join(", ")}.`,
    );
  if (vectorless > 0) warnings.push(`${vectorless} active non-kv fact(s) are missing canonical embeddings.`);
  if (degraded)
    warnings.push(
      `Vector store is in degraded mode${degradedReason ? ` (reason: ${degradedReason})` : ""}; semantic retrieval may be unavailable.`,
    );
  if (vectorLifecycleSloBreaches.length > 0)
    warnings.push(
      `Vector lifecycle SLO breach(es): ${vectorLifecycleSloBreaches.map(formatVectorLifecycleSloBreach).join("; ")}`,
    );
  if (procedureTriage.summary.total > 0) {
    const reasonBreakdown = Object.entries(procedureTriage.summary.byReason)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    warnings.push(`${procedureTriage.summary.total} validated procedure(s) are not promoted (${reasonBreakdown}).`);
  }
  const remediation: string[] = [];
  if ((tiers.hot ?? 0) === 0 || (tiers.structural ?? 0) === 0 || structuralEligibleWarmFacts > 0)
    remediation.push("Run `openclaw hybrid-mem retier --apply`.");
  if (graphHubs.some((hub) => hub.overCap))
    remediation.push(
      "Run `openclaw hybrid-mem graph repair --collapse-event-hubs --apply` and keep graph hub guards enabled.",
    );
  if (unconfiguredCategories.length > 0)
    remediation.push("Run `openclaw hybrid-mem categories audit`, then `categories remap --apply` where appropriate.");
  if (activeFacts > 0 && stableStickinessRatio > 0.6) {
    remediation.push(
      "Run `openclaw hybrid-mem decay reclassify --dry-run --stable-only`, then `openclaw hybrid-mem decay reclassify --apply --stable-only` if the report looks correct.",
    );
  }
  if (vectorless > 0) remediation.push("Run `openclaw hybrid-mem reembed-vectorless --apply`.");
  if (degraded) remediation.push("Run `openclaw hybrid-mem storage repair` and validate LanceDB connectivity.");
  if (procedureTriage.summary.total > 0) {
    remediation.push(
      "Run `openclaw hybrid-mem procedures triage --not-promoted` and `generate-auto-skills` where appropriate.",
    );
    if ((procedureTriage.summary.byReason.low_recall ?? 0) > 0)
      remediation.push(
        "Low-recall procedures need more successful uses before promotion; retrain or merge duplicates via `openclaw hybrid-mem procedures triage --not-promoted --reason low_recall`.",
      );
  }
  if (
    implicitFeedbackPatterns > 1000 ||
    (implicitFeedbackPrefixHistogram.length > 0 && implicitFeedbackPrefixHistogram[0].count >= 10)
  ) {
    remediation.push(
      "Run `openclaw hybrid-mem reflect-meta --collapse-implicit-feedback --include-legacy` (omit `--dry-run` to apply mutations).",
    );
  }
  if (entityStopwordMatches.length > 0) {
    remediation.push(
      "Run `openclaw hybrid-mem entities clean --stopwords --apply` to null stop-word entity labels from existing facts.",
    );
  }

  // #1806: entity enrichment backlog — warn when eta_runs exceeds threshold.
  const ENTITY_ENRICHMENT_DEFAULT_LIMIT = 200;
  const ENTITY_ENRICHMENT_ETA_WARN_THRESHOLD = 100;
  let entityEnrichmentBacklog: AuditHealthReport["entityEnrichmentBacklog"] = null;
  if (hasBudget("entityEnrichmentBacklog")) {
    try {
      const backlogSummary = factsDb.getEntityEnrichmentBacklogSummary(24);
      const estimatedRunsRemaining = Math.ceil(backlogSummary.total / ENTITY_ENRICHMENT_DEFAULT_LIMIT);
      entityEnrichmentBacklog = {
        total: backlogSummary.total,
        byTier: backlogSummary.byTier,
        estimatedRunsRemaining,
      };
      if (estimatedRunsRemaining > ENTITY_ENRICHMENT_ETA_WARN_THRESHOLD) {
        warnings.push(
          `Entity enrichment backlog: ${backlogSummary.total} fact(s) pending enrichment (eta_runs=${estimatedRunsRemaining} at limit=${ENTITY_ENRICHMENT_DEFAULT_LIMIT}).`,
        );
        remediation.push(
          `Run \`openclaw hybrid-mem enrich-entities --limit ${ENTITY_ENRICHMENT_DEFAULT_LIMIT} --adaptive-catch-up\` or increase the limit to clear the backlog faster.`,
        );
      }
    } catch (err) {
      // Non-fatal: backlog query failure does not block the audit report, but --strict-errors
      // still needs to see it — a silently-swallowed error here previously made the report
      // look clean even though a section failed to run.
      errors.push({
        section: "entityEnrichmentBacklog",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let graphHubGuard: AuditHealthReport["graphHubGuard"] = null;
  if (raw && hasBudget("graphHubGuard")) {
    const probeRow = raw.prepare("SELECT id FROM facts WHERE superseded_at IS NULL LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (probeRow?.id) {
      const connectedProbe: GraphConnectedStats = { nodesConsidered: 0, nodesSkipped: 0, hubsSkipped: 0 };
      factsDb.getConnectedFactIds([probeRow.id], 2, { hubDegreeCap: graphHubDegreeCap, stats: connectedProbe });
      const entry = factsDb.getById(probeRow.id);
      if (entry) {
        const { stats: expansionProbe } = expandGraph(factsDb, [{ factId: probeRow.id, score: 1, entry }], {
          maxDepth: 2,
          maxExpandedResults: 20,
          hubDegreeCap: graphHubDegreeCap,
        });
        graphHubGuard = {
          configuredCap: graphHubDegreeCap,
          effectiveCap: resolveGraphHubDegreeCap(graphHubDegreeCap),
          connectedProbe,
          expansionProbe,
        };
      }
    }
  }

  const status: AuditHealthReport["status"] = errors.length > 0 || warnings.length > 0 ? "partial" : "ok";

  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    status,
    ok: warnings.length === 0 && errors.length === 0,
    warningCount: warnings.length,
    errorCount: errors.length,
    activeFacts,
    storeAgeDays: Number(storeAgeDays.toFixed(2)),
    canonicalEmbeddings,
    vectorless,
    vectorlessBySource,
    procedures: {
      total: procedures,
      validated,
      promoted,
      validatedNotPromoted: Math.max(0, validated - promoted),
      blocked: procedureTriage.summary.total,
      topBlockReason: procedureTriage.summary.topReason,
      byBlockReason: procedureTriage.summary.byReason,
    },
    graphHubs,
    structuralEligibleWarmFacts,
    patternBloat: { implicitFeedbackPatterns, implicitFeedbackPrefixHistogram },
    entityStopwordMatches,
    topEntitiesFiltered,
    storage: {
      sqliteBytes: storageBytes?.sqliteBytes ?? null,
      walBytes: storageBytes?.walBytes ?? null,
      shmBytes: storageBytes?.shmBytes ?? null,
      lanceBytes,
    },
    storageGrowth,
    implicitFeedbackSignalNoise,
    tiers,
    decay,
    stableStickiness,
    vectorIntegrity: {
      score: integrityScore,
      degraded,
      degradedReason,
      vectorlessRatio: Number(vectorlessRatio.toFixed(4)),
      orphanSignals: {
        sqliteFactsWithoutCanonicalEmbedding: vectorless,
      },
    },
    vectorLifecycleSlo: {
      targets: vectorLifecycleSloTargets,
      breaches: vectorLifecycleSloBreaches,
      lastReembedProgress: options?.lastReembedProgress ?? null,
    },
    categories: { configured, present, unknown },
    sources,
    implicitFeedbackTrajectorySignals,
    graphHubGuard,
    entityEnrichmentBacklog,
    warnings,
    remediation,
    errors,
    credentials: options?.credentialsStatus ?? null,
    timeoutMs: options?.timeoutMs,
    elapsedMs: Date.now() - startedAtMs,
  };
}

export function printAuditHealthMarkdown(report: AuditHealthReport): void {
  console.log("# Hybrid-memory audit health");
  console.log("");
  console.log(`Status: ${report.status}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Schema version: ${report.schemaVersion}`);
  console.log(`Active facts: ${report.activeFacts}`);
  console.log(`Store age (days): ${report.storeAgeDays.toFixed(1)}`);
  console.log(`Canonical embeddings: ${report.canonicalEmbeddings}`);
  console.log(`Vectorless active non-kv facts: ${report.vectorless}`);
  console.log(
    `Vector integrity score: ${report.vectorIntegrity.score}/100 (degraded=${report.vectorIntegrity.degraded ? "yes" : "no"}; vectorlessRatio=${report.vectorIntegrity.vectorlessRatio})`,
  );
  if (report.vectorIntegrity.degradedReason) {
    console.log(`Vector degraded reason: ${report.vectorIntegrity.degradedReason}`);
  }
  if (report.vectorLifecycleSlo.breaches.length > 0) {
    console.log(
      `Vector lifecycle SLO breaches: ${report.vectorLifecycleSlo.breaches.map(formatVectorLifecycleSloBreach).join(", ")}`,
    );
    const lrp = report.vectorLifecycleSlo.lastReembedProgress;
    if (lrp) {
      const slo = lrp.vectorSloRepair;
      console.log(
        `Last reembed run (${lrp.ts}): embedded=${lrp.embedded}, after=${lrp.after}, ratio=${(slo.vectorlessRatioAfter * 100).toFixed(2)}%, toClear=${slo.vectorlessToClearForSlo}, ~${slo.estimatedRunsToReachSlo} run(s) to SLO at limit ${slo.recommendedLimitNextRun}`,
      );
    }
  }
  if (report.vectorlessBySource.length > 0) {
    console.log(`Vectorless by source: ${report.vectorlessBySource.map((r) => `${r.source}=${r.count}`).join(", ")}`);
  }
  console.log(
    `Procedures: ${report.procedures.total} (validated: ${report.procedures.validated}, promoted: ${report.procedures.promoted}, blocked: ${report.procedures.blocked}${report.procedures.topBlockReason ? ` by ${report.procedures.topBlockReason}` : ""})`,
  );
  console.log(`Tiers: ${JSON.stringify(report.tiers)}`);
  console.log(`Decay: ${JSON.stringify(report.decay)}`);
  console.log(
    `Unknown categories: ${report.categories.unknown.length ? report.categories.unknown.map((u) => `${u.category}=${u.count}`).join(", ") : "none"}`,
  );
  console.log(
    `Stable+permanent stickiness: ${report.stableStickiness.stablePermanent}/${report.stableStickiness.activeFacts} (${(
      report.stableStickiness.ratio * 100
    ).toFixed(1)}%)`,
  );
  console.log(`Graph hubs over cap: ${report.graphHubs.filter((hub) => hub.overCap).length}`);
  if (report.graphHubs.length > 0) {
    // #1193: TTY summary now mirrors the JSON `top 10`, not the previous truncated 3.
    console.log(
      `Top graph hubs: ${report.graphHubs
        .slice(0, 10)
        .map((hub) => `${hub.id.slice(0, 8)}=${hub.outDegree}`)
        .join(", ")}`,
    );
  }
  console.log(`Structural-eligible warm facts: ${report.structuralEligibleWarmFacts}`);
  console.log(`Implicit-feedback pattern facts: ${report.patternBloat.implicitFeedbackPatterns}`);
  if (report.patternBloat.implicitFeedbackPrefixHistogram.length > 0) {
    console.log(
      `Implicit-feedback prefix histogram: ${report.patternBloat.implicitFeedbackPrefixHistogram
        .map((row) => `"${row.prefix}"=${row.count}`)
        .join(", ")}`,
    );
  }
  if (report.topEntitiesFiltered.length > 0) {
    console.log(
      `Top entities (retrieval view, stop-words removed): ${report.topEntitiesFiltered.map((row) => `${row.entity}=${row.count}`).join(", ")}`,
    );
  }
  if (report.entityStopwordMatches.length > 0) {
    console.log(
      `Entity stop-word matches: ${report.entityStopwordMatches.map((row) => `${row.entity}=${row.count}`).join(", ")}`,
    );
  }
  if (report.storage.sqliteBytes != null) console.log(`SQLite bytes: ${report.storage.sqliteBytes}`);
  if (report.storage.lanceBytes != null) console.log(`Lance bytes: ${report.storage.lanceBytes}`);
  if (report.storageGrowth.lastSampleAt != null) {
    const lanceWeekly = report.storageGrowth.lanceBytesPerWeekDelta;
    const lanceWeeklyStr = lanceWeekly != null ? `; lance/week=${lanceWeekly}` : "";
    console.log(
      `Storage growth (last sample unix): ${report.storageGrowth.lastSampleAt}; 7d delta: ${JSON.stringify(report.storageGrowth.delta7d)}${lanceWeeklyStr}`,
    );
  }
  console.log(
    `Implicit-feedback signal noise (30d): paraphraseRatio=${String(report.implicitFeedbackSignalNoise.paraphraseRatio)} days=${Object.keys(report.implicitFeedbackSignalNoise.rowsPerDay30d).length}`,
  );
  console.log(`Implicit-feedback trajectory signals: ${report.implicitFeedbackTrajectorySignals}`);
  if (report.graphHubGuard) {
    const g = report.graphHubGuard;
    console.log(
      `Graph hub guard probe (cap=${String(g.configuredCap)} effective=${String(g.effectiveCap)}): connected considered=${g.connectedProbe.nodesConsidered} skipped=${g.connectedProbe.nodesSkipped} hubsSkipped=${g.connectedProbe.hubsSkipped}; expansion considered=${g.expansionProbe.nodesConsidered} skipped=${g.expansionProbe.nodesSkipped} hubsSkipped=${g.expansionProbe.hubsSkipped}`,
    );
  }
  if (report.entityEnrichmentBacklog != null) {
    const eb = report.entityEnrichmentBacklog;
    console.log(
      `Entity enrichment backlog: total=${eb.total} eta_runs=${eb.estimatedRunsRemaining} (hot=${eb.byTier.hot}, warm=${eb.byTier.warm}, structural=${eb.byTier.structural}, cold=${eb.byTier.cold})`,
    );
  }
  if (report.credentials != null) {
    const c = report.credentials;
    const encLabel = c.encryptedAtRest
      ? `encrypted (kdf_version=${c.kdfVersion})`
      : `plaintext (kdf_version=${c.kdfVersion})`;
    console.log(`Credentials vault: ${encLabel}, entries=${c.entryCount}, migration_required=${c.migrationRequired}`);
  }
  console.log("");
  if (report.errors.length > 0) {
    console.log("Errors:");
    for (const error of report.errors) console.log(`- [${error.section}] ${error.message}`);
    console.log("");
  }
  if (report.warnings.length === 0) {
    console.log("Warnings: none");
  } else {
    console.log("Warnings:");
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }
  if (report.remediation.length > 0) {
    console.log("");
    console.log("Remediation:");
    for (const hint of report.remediation) console.log(`- ${hint}`);
  }
}
