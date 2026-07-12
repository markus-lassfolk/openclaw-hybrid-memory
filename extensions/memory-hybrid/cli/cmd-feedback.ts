/**
 * Feedback & Learning CLI Handlers
 *
 * Implements feedback-related CLI commands:
 *   - extract-implicit-feedback — scan sessions for implicit positive/negative signals
 *   - cross-agent-learning      — generalise lessons across agent memory databases
 *   - tool-effectiveness        — compute and report tool usage effectiveness scores
 *   - cost-report               — show LLM cost breakdown by feature or model
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { FactsDB, ReinforcementContext } from "../backends/facts-db.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
  isCompactVerbosity,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { chatCompleteWithRetryDetailed } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { runCrossAgentLearning } from "../services/cross-agent-learning.js";
import { capturePluginError } from "../services/error-reporter.js";
import { resolveExtractSessionFilePaths } from "../services/extract-session-paths.js";
import { getEffectivenessReport, runClosedLoopAnalysis } from "../services/feedback-effectiveness.js";
import { classifyAndFilterCorrectionIncidents } from "../services/feedback-signal-classifier.js";
import { extractImplicitSignals, parseSessionTurns } from "../services/implicit-feedback-extract.js";
import { getModeCostEstimates } from "../services/model-pricing.js";
import type { CorrectionIncident } from "../services/self-correction-extract.js";
import {
  computeToolEffectiveness,
  formatToolEffectivenessReport,
  generateMonthlyReport,
  ToolEffectivenessStore,
} from "../services/tool-effectiveness.js";
import { analyzeTrajectoriesWithLLM, buildTrajectories, serializeTrajectory } from "../services/trajectory-tracker.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { formatDateUtc, formatTimestampUtc, formatTimestampUtcFromMs, nowSec } from "../utils/dates.js";
import { getEnv } from "../utils/env-manager.js";
import { getMaintenanceRunAbortSignal, maintenanceRunDeadlineReached } from "../utils/maintenance-run-deadline.js";
import { loadPrompt } from "../utils/prompt-loader.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { runSelfCorrectionRunForCli } from "./cmd-selfcorrection.js";
import type { HandlerContext } from "./handlers.js";
import { resolveScanMaintenanceOverrides } from "./maintenance-overrides.js";

const IMPLICIT_FEEDBACK_LESSON_TAGS = ["implicit-feedback", "trajectory", "feedback"];

/** Comma-safe tag predicate for trajectory lesson rows (avoids substring false positives). */
const SQL_TRAJECTORY_LESSON_TAGS = `(
  (',' || COALESCE(tags,'') || ',') LIKE '%,implicit-feedback,%'
  AND (',' || COALESCE(tags,'') || ',') LIKE '%,trajectory,%'
  AND (',' || COALESCE(tags,'') || ',') LIKE '%,feedback,%'
)`;

/**
 * Modern key + legacy rows: null-key trajectory lessons, including older pattern-shaped rows that only
 * carried a trajectory tag (no implicit-feedback/feedback tag triple). Negative self-correction rows
 * are excluded via the `negative` tag.
 */
export const SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER = `(
  key = 'implicit_feedback_signal'
  OR (
    (key IS NULL OR TRIM(COALESCE(key, '')) = '')
    AND source = 'implicit-feedback'
    AND (',' || COALESCE(tags,'') || ',') NOT LIKE '%,negative,%'
    AND (
      (${SQL_TRAJECTORY_LESSON_TAGS})
      OR (
        (category = 'pattern' OR category = 'technical')
        AND (',' || COALESCE(tags,'') || ',') LIKE '%,trajectory,%'
      )
    )
  )
)`;

const LESSON_DEDUPE_STOPWORDS = new Set([
  "and",
  "are",
  "each",
  "for",
  "from",
  "has",
  "have",
  "into",
  "that",
  "the",
  "then",
  "this",
  "when",
  "with",
]);

function normalizeLessonToken(token: string): string {
  let normalized = token.trim();
  if (normalized.endsWith("ed") && normalized.length > 5) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("ies") && normalized.length > 5) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (normalized.endsWith("es") && normalized.length > 4) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("s") && normalized.length > 4) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizeLessonTokens(text: string): Set<string> {
  const out = new Set<string>();
  const rawTokens = text
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  for (const raw of rawTokens) {
    if (LESSON_DEDUPE_STOPWORDS.has(raw)) continue;
    let stem = normalizeLessonToken(raw);
    if (!stem || stem.length < 2) continue;
    if (LESSON_DEDUPE_STOPWORDS.has(stem) && stem !== raw) {
      stem = raw;
    }
    if (LESSON_DEDUPE_STOPWORDS.has(stem)) continue;
    out.add(stem);
  }
  return out;
}

function tokenJaccard(a: string, b: string): number {
  const left = normalizeLessonTokens(a);
  const right = normalizeLessonTokens(b);
  return tokenJaccardFromSets(left, right);
}

function tokenJaccardFromSets(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

function getImplicitFeedbackLessonsStoredToday(rawDb: ReturnType<HandlerContext["factsDb"]["getRawDb"]>): number {
  if (!rawDb) return 0;
  const startOfDaySec = Math.floor(Date.now() / 86400000) * 86400;
  const row = rawDb
    .prepare(
      `SELECT COUNT(*) as cnt FROM facts WHERE source = 'implicit-feedback' AND ${SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER} AND created_at >= ? AND superseded_at IS NULL`,
    )
    .get(startOfDaySec) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function findSimilarImplicitFeedbackLesson(
  rawDb: ReturnType<HandlerContext["factsDb"]["getRawDb"]>,
  lesson: string,
  threshold: number,
): string | null {
  if (!rawDb) return null;
  const prefix = lesson.trim().slice(0, 80);
  const rows = rawDb
    .prepare(
      `SELECT id, text FROM facts
       WHERE source = 'implicit-feedback'
         AND superseded_at IS NULL
         AND ${SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER}
       ORDER BY created_at DESC
       LIMIT 2000`,
    )
    .all() as Array<{ id: string; text: string }>;
  for (const row of rows) {
    if (row.text === lesson || (prefix.length >= 20 && row.text.startsWith(prefix))) return row.id;
    if (tokenJaccard(row.text, lesson) >= threshold) return row.id;
  }
  return null;
}

function markImplicitFeedbackLessonRecalled(
  rawDb: ReturnType<HandlerContext["factsDb"]["getRawDb"]>,
  factId: string,
): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIsoAt = formatTimestampUtc(nowSec);
  rawDb
    ?.prepare(
      "UPDATE facts SET recall_count = recall_count + 1, access_count = access_count + 1, last_accessed = ?, last_accessed_at = ? WHERE id = ?",
    )
    .run(nowSec, nowIsoAt, factId);
}

/** Rows matching this OR-branch are legacy implicit-feedback bloat (category=pattern). Use with --include-legacy collapse. */
export const SQL_IMPLICIT_LEGACY_PATTERN_ROWS = `(category = 'pattern' AND source = 'implicit-feedback')`;

function buildImplicitFeedbackCleanupFilter(includeLegacy: boolean): string {
  if (includeLegacy) {
    return `(${SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER} OR ${SQL_IMPLICIT_LEGACY_PATTERN_ROWS})`;
  }
  return SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER;
}

export type ImplicitFeedbackCollapseStatus = "no_candidates" | "no_changes" | "partial" | "collapsed";

/** Operator-facing collapse outcome for `reflect-meta --collapse-implicit-feedback` (#1736). */
export function implicitFeedbackCollapseStatus(scanned: number, collapsed: number): ImplicitFeedbackCollapseStatus {
  if (scanned === 0) return "no_candidates";
  if (collapsed === 0) return "no_changes";
  if (collapsed < scanned) return "partial";
  return "collapsed";
}

/** Semantic no-op outcomes for collapse maintenance in non-dry-run mode. */
export function isSemanticNoOpImplicitFeedbackCollapseStatus(status: ImplicitFeedbackCollapseStatus): boolean {
  return status === "no_candidates" || status === "no_changes";
}

export function cleanupImplicitFeedbackDuplicates(
  factsDb: FactsDB,
  opts: {
    threshold?: number;
    limit?: number;
    afterRowid?: number;
    /** When true, report collapsible rows without superseding/reinforcing. */
    dryRun?: boolean;
    /** Leaders from prior paging batches so near-duplicates across windows still collapse. */
    seedCanonical?: ReadonlyArray<{ id: string; text: string }>;
    /** When true, also collapse legacy `category=pattern` implicit-feedback rows into canonical signals. */
    includeLegacy?: boolean;
    /** Optional progress callback for long-running synchronous scans. */
    onProgress?: (progress: { scanned: number; total: number; collapsed: number }) => void;
    /** Callback cadence in scanned rows. */
    reportEvery?: number;
    /** Optional wall-clock budget check to stop processing early. Returns true if budget exceeded. */
    wallClockCheck?: () => boolean;
  } = {},
): {
  scanned: number;
  collapsed: number;
  resumeAfterRowid: number | null;
  carryCanonical: Array<{ id: string; text: string }>;
  interrupted: boolean;
} {
  type CanonicalEntry = { id: string; text: string; tokens: Set<string> };
  const rawDb = factsDb.getRawDb();
  if (!rawDb) {
    return {
      scanned: 0,
      collapsed: 0,
      resumeAfterRowid: null,
      carryCanonical: [...(opts.seedCanonical ?? [])],
      interrupted: false,
    };
  }
  const threshold = opts.threshold ?? 0.7;
  const limit = opts.limit ?? 1000;
  if (limit <= 0) {
    return {
      scanned: 0,
      collapsed: 0,
      resumeAfterRowid: null,
      carryCanonical: [...(opts.seedCanonical ?? [])],
      interrupted: false,
    };
  }
  const afterRowid = opts.afterRowid ?? 0;
  const dryRun = opts.dryRun === true;
  const rowFilter = buildImplicitFeedbackCleanupFilter(opts.includeLegacy === true);
  const rows = rawDb
    .prepare(
      `SELECT rowid as rowid, id, text, recall_count as recallCount, access_count as accessCount, created_at as createdAt
       FROM facts
       WHERE source = 'implicit-feedback' AND superseded_at IS NULL AND ${rowFilter}
         AND (@afterRowid = 0 OR rowid > @afterRowid)
       ORDER BY rowid ASC
       LIMIT @limit`,
    )
    .all({ "@afterRowid": afterRowid, "@limit": limit }) as Array<{
    rowid: number;
    id: string;
    text: string;
    recallCount: number;
    accessCount: number;
    createdAt: number;
  }>;
  let collapsed = 0;
  let scanned = 0;
  const reportEvery = Math.max(1, opts.reportEvery ?? 250);
  // Keep carry above legacy (~2000 at limit=250) so 10k+ paged scans can still match late duplicates,
  // while capping token index growth and memory overhead in large runs.
  const CANONICAL_WINDOW_SIZE = Math.min(25_000, Math.max(12_000, limit * 12));
  const canonical: CanonicalEntry[] = [...(opts.seedCanonical ?? [])]
    .slice(-CANONICAL_WINDOW_SIZE)
    .map((c) => ({ id: c.id, text: c.text, tokens: normalizeLessonTokens(c.text) }));
  const exactTextIndex = new Map<string, number>();
  const canonicalTokenIndex = new Map<string, Set<number>>();
  for (const [index, entry] of canonical.entries()) {
    if (!exactTextIndex.has(entry.text)) {
      exactTextIndex.set(entry.text, index);
    }
    for (const token of entry.tokens) {
      const tokenEntries = canonicalTokenIndex.get(token);
      if (tokenEntries) {
        tokenEntries.add(index);
      } else {
        canonicalTokenIndex.set(token, new Set([index]));
      }
    }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIsoAt = formatTimestampUtc(nowSec);
  const reinforce = rawDb.prepare(
    "UPDATE facts SET recall_count = recall_count + ?, access_count = access_count + ?, last_accessed = ?, last_accessed_at = ? WHERE id = ?",
  );
  const supersedeStmt = rawDb.prepare(
    "UPDATE facts SET superseded_at = ?, superseded_by = ?, valid_until = ? WHERE id = ? AND superseded_at IS NULL",
  );
  let supersededAny = false;
  let interrupted = false;
  const scanRows = () => {
    for (const row of rows) {
      // Check wall-clock budget periodically
      if (opts.wallClockCheck?.()) {
        interrupted = true;
        break;
      }
      scanned++;
      const rowTokens = normalizeLessonTokens(row.text);
      const candidateIndices = new Set<number>();
      for (const token of rowTokens) {
        const tokenEntries = canonicalTokenIndex.get(token);
        if (!tokenEntries) continue;
        for (const candidateIndex of tokenEntries) {
          candidateIndices.add(candidateIndex);
        }
      }
      // Preserve prior behavior: when multiple candidates match, choose the earliest canonical row.
      let earliestMatchIndex: number | null = null;
      const exactMatchIndex = exactTextIndex.get(row.text);
      if (exactMatchIndex != null) {
        earliestMatchIndex = exactMatchIndex;
      }
      for (const candidateIndex of candidateIndices) {
        const candidate = canonical[candidateIndex];
        if (!candidate || tokenJaccardFromSets(candidate.tokens, rowTokens) < threshold) continue;
        if (earliestMatchIndex == null || candidateIndex < earliestMatchIndex) {
          earliestMatchIndex = candidateIndex;
        }
      }
      const match = earliestMatchIndex != null ? canonical[earliestMatchIndex] : undefined;
      if (!match) {
        const index = canonical.push({ id: row.id, text: row.text, tokens: rowTokens }) - 1;
        if (!exactTextIndex.has(row.text)) {
          exactTextIndex.set(row.text, index);
        }
        for (const token of rowTokens) {
          const tokenEntries = canonicalTokenIndex.get(token);
          if (tokenEntries) {
            tokenEntries.add(index);
          } else {
            canonicalTokenIndex.set(token, new Set([index]));
          }
        }
        if (scanned % reportEvery === 0 || scanned === rows.length) {
          opts.onProgress?.({ scanned, total: rows.length, collapsed });
        }
        continue;
      }
      if (dryRun) {
        collapsed++;
        if (scanned % reportEvery === 0 || scanned === rows.length) {
          opts.onProgress?.({ scanned, total: rows.length, collapsed });
        }
        continue;
      }
      const sup = supersedeStmt.run(nowSec, match.id, nowSec, row.id);
      if ((sup.changes ?? 0) > 0) {
        supersededAny = true;
        reinforce.run(Math.max(0, row.recallCount ?? 0), Math.max(0, row.accessCount ?? 0), nowSec, nowIsoAt, match.id);
        collapsed++;
      }
      if (scanned % reportEvery === 0 || scanned === rows.length) {
        opts.onProgress?.({ scanned, total: rows.length, collapsed });
      }
    }
  };
  if (dryRun) {
    scanRows();
  } else {
    rawDb.prepare("BEGIN").run();
    try {
      scanRows();
      rawDb.prepare("COMMIT").run();
    } catch (err) {
      rawDb.prepare("ROLLBACK").run();
      throw err;
    }
  }
  if (supersededAny) {
    factsDb.invalidateSupersededTextsCache();
  }
  // When interrupted, return the actual scanned count and the last row actually processed,
  // not the full batch size and last row in the batch.
  const lastProcessedRow = interrupted && scanned > 0 ? rows[scanned - 1] : rows[rows.length - 1];
  return {
    scanned,
    collapsed,
    resumeAfterRowid: lastProcessedRow ? lastProcessedRow.rowid : null,
    carryCanonical: canonical.slice(-CANONICAL_WINDOW_SIZE).map((c) => ({ id: c.id, text: c.text })),
    interrupted,
  };
}

// ---------------------------------------------------------------------------
// extract-implicit-feedback
// ---------------------------------------------------------------------------

/** Minimum wall-clock remaining before scheduling another trajectory LLM call. */
export const TRAJECTORY_LLM_MIN_BUDGET_MS = 1000;

/** Per-trajectory LLM call wall-clock cap (Issue #1953). */
export const TRAJECTORY_PER_CALL_BUDGET_MS = 30_000;

/** Max concurrent trajectory LLM analyses per session (Issue #1953). */
export const TRAJECTORY_LLM_CONCURRENCY = 4;

/** Resolve per-trajectory LLM budget from remaining run wall-clock (Issue #1953). */
export function resolveTrajectoryLlmBudgetMs(remainingWallClockMs: number): number {
  if (remainingWallClockMs < TRAJECTORY_LLM_MIN_BUDGET_MS) return 0;
  return Math.min(TRAJECTORY_PER_CALL_BUDGET_MS, Math.max(1, Math.floor(remainingWallClockMs)));
}

/** Remaining milliseconds until an absolute deadline (0 when expired). */
export function remainingDeadlineMs(deadlineMs: number, nowMs: number = Date.now()): number {
  return Math.max(0, deadlineMs - nowMs);
}

/** Timeout for the next LLM attempt within a per-trajectory deadline (0 when expired). */
export function trajectoryCallTimeoutMs(deadlineMs: number, nowMs: number = Date.now()): number {
  const remaining = remainingDeadlineMs(deadlineMs, nowMs);
  return remaining > 0 ? Math.max(1, remaining) : 0;
}

/** Propagate a source abort signal into a target controller (first abort wins). Returns a disposer. */
export function propagateAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const onAbort = () => {
    if (!target.signal.aborted) {
      target.abort(source.reason ?? new Error("aborted"));
    }
  };
  if (source.aborted) {
    onAbort();
    return () => {};
  }
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

/** Run async work over items with a bounded worker pool. */
export async function runWithConcurrencyLimit<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
  opts?: { shouldStop?: () => boolean },
): Promise<TResult[]> {
  if (items.length === 0) return [];
  const results: TResult[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (opts?.shouldStop?.()) return;
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );
  return results;
}

export type ExtractImplicitFeedbackStopReason =
  | "maxWallClock"
  | "maxSessions"
  | "maxSignals"
  | "maxTrajectories"
  | "reinforcementError";

class ImplicitFeedbackWallClockExceededError extends Error {
  constructor() {
    super("implicit-feedback wall-clock budget exceeded");
  }
}

export interface ExtractImplicitFeedbackProgressSnapshot {
  stage: "scan-sessions" | "cleanup-duplicates" | "closed-loop" | "done";
  sessionsDiscovered: number;
  sessionsVisited: number;
  sessionsProcessed: number;
  sessionsReadErrors: number;
  sessionsTooShort: number;
  currentSession?: string;
  signalsExtracted: number;
  positiveCount: number;
  negativeCount: number;
  trajectoriesBuilt: number;
  cleanupCollapsed: number;
  cleanupScanned: number;
  cleanupBatches: number;
  partial?: boolean;
  partialReason?: ExtractImplicitFeedbackStopReason;
  sessionsDeferred?: number;
  backlogSessionsEstimate?: number;
  backlogSignalsEstimate?: number;
  backlogTrajectoriesEstimate?: number;
}

/**
 * Extract implicit feedback signals from recent sessions.
 * Signals are routed to the reinforcement pipeline (positive) or stored as
 * technical implicit_feedback_signal facts for self-correction (negative). Trajectories and closed-loop
 * analysis are run as subsequent phases when not disabled.
 */
export async function runExtractImplicitFeedbackForCli(
  ctx: HandlerContext,
  opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    full?: boolean;
    force?: boolean;
    includeTrajectories?: boolean;
    includeClosedLoop?: boolean;
    onProgress?: (snapshot: ExtractImplicitFeedbackProgressSnapshot) => void;
  },
): Promise<{
  signalsExtracted: number;
  positiveCount: number;
  negativeCount: number;
  trajectoriesBuilt: number;
  sessionsScanned: number;
  sessionsVisited: number;
  sessionsProcessed: number;
  sessionsSkipped: number;
  sessionsDeferred: number;
  backlogSessionsEstimate: number;
  backlogSignalsEstimate: number;
  backlogTrajectoriesEstimate: number;
  partial: boolean;
  partialReason?: ExtractImplicitFeedbackStopReason;
  closedLoopReport?: string;
  skipped?: boolean;
}> {
  const { bypassWatermark } = resolveScanMaintenanceOverrides(opts);
  const { factsDb, vectorDb, cfg, logger, openai } = ctx;
  const SCAN_TYPE = "extract-implicit-feedback";
  const days = opts.days ?? 3;

  // Get scan cursor for incremental mode
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Determine which files to scan based on override flags and cursor
  let filePaths: string[];
  if (!bypassWatermark && cursor && cursor.lastSessionTs > 0) {
    // Incremental mode: resume from the stored cursor, not the moving day window.
    // A capped backlog may take longer than `days` to drain; using the day window
    // first would permanently strand old-but-unprocessed sessions after the cursor.
    const cursorFloor = Math.max(0, cursor.lastSessionTs - 1);
    const allFiles = resolveExtractSessionFilePaths(cfg, 0, cursorFloor);
    const incrementalCandidates: Array<{ path: string; mtime: number; fname: string }> = [];
    for (const path of allFiles) {
      try {
        const stat = statSync(path);
        incrementalCandidates.push({ path, mtime: stat.mtimeMs, fname: basename(path) });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:incremental-stat",
          severity: "info",
          subsystem: "implicit-feedback",
        });
      }
    }
    filePaths = incrementalCandidates
      .filter(({ mtime, fname }) => {
        // Skip files before the cursor watermark
        if (mtime < cursor.lastSessionTs) return false;
        // If same mtime, use filename to determine if we've processed this file
        if (mtime === cursor.lastSessionTs) {
          if (cursor.lastSessionFile) {
            return fname.localeCompare(cursor.lastSessionFile) > 0;
          }
          // Legacy cursors without a filename cannot safely order peers in the same
          // mtime tier. Treat that tier as already covered to avoid re-routing
          // signals/reinforcement for files that may already have been processed.
          return false;
        }
        return true;
      })
      // Sort by mtime ascending, then by filename to ensure deterministic processing order
      .sort((a, b) => {
        const mtimeDiff = a.mtime - b.mtime;
        if (mtimeDiff !== 0) return mtimeDiff;
        return a.fname.localeCompare(b.fname);
      })
      .map((entry) => entry.path);
    if (opts.verbose && cursor.lastSessionFile) {
      logger?.info?.(
        `memory-hybrid: ${SCAN_TYPE} incremental — resuming after ${cursor.lastSessionFile} (${filePaths.length} files to process)`,
      );
    }
  } else {
    // Full mode: process all files in the date range
    filePaths = resolveExtractSessionFilePaths(cfg, days);
    // Sort by mtime ascending, then by filename to ensure deterministic processing order
    filePaths.sort((a, b) => {
      let statA, statB;
      try {
        statA = statSync(a);
      } catch {
        return 1;
      }
      try {
        statB = statSync(b);
      } catch {
        return -1;
      }
      const mtimeDiff = statA.mtimeMs - statB.mtimeMs;
      if (mtimeDiff !== 0) return mtimeDiff;
      return basename(a).localeCompare(basename(b));
    });
    if (opts.verbose && !bypassWatermark) {
      logger?.info?.(`memory-hybrid: ${SCAN_TYPE} full scan — ${filePaths.length} files to process`);
    }
  }

  const progress: ExtractImplicitFeedbackProgressSnapshot = {
    stage: "scan-sessions",
    sessionsDiscovered: filePaths.length,
    sessionsVisited: 0,
    sessionsProcessed: 0,
    sessionsReadErrors: 0,
    sessionsTooShort: 0,
    currentSession: undefined,
    signalsExtracted: 0,
    positiveCount: 0,
    negativeCount: 0,
    trajectoriesBuilt: 0,
    cleanupCollapsed: 0,
    cleanupScanned: 0,
    cleanupBatches: 0,
  };

  const emitProgress = (): void => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress({ ...progress });
    } catch {
      // Progress callbacks must never affect extraction.
    }
  };

  emitProgress();

  const implicitCfg = cfg.implicitFeedback ?? {
    enabled: true,
    minConfidence: 0.5,
    signalTypes: undefined,
    rephraseThreshold: 0.8,
    topicChangeThreshold: 0.3,
    terseResponseRatio: 0.4,
    feedToReinforcement: true,
    feedToSelfCorrection: true,
    maxLessonsPerDay: 50,
    lessonDedupeJaccard: 0.7,
    autoCleanup: true,
    cleanupLimit: 1000,
  };
  let bridgeIncidents: CorrectionIncident[] = [];
  const bridgeMinConfidence = implicitCfg.selfCorrectionBridgeMinConfidence ?? 0.7;

  if (implicitCfg.enabled === false) {
    progress.stage = "done";
    emitProgress();
    return {
      signalsExtracted: 0,
      positiveCount: 0,
      negativeCount: 0,
      trajectoriesBuilt: 0,
      sessionsScanned: 0,
      sessionsVisited: 0,
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      sessionsDeferred: 0,
      backlogSessionsEstimate: 0,
      backlogSignalsEstimate: 0,
      backlogTrajectoriesEstimate: 0,
      partial: false,
    };
  }

  let totalSignals = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let trajectoriesBuilt = 0;
  let partial = false;
  let partialReason: ExtractImplicitFeedbackStopReason | undefined;
  let sessionsDeferred = 0;
  let lastProcessedFilePath: string | undefined;

  const rawDb = factsDb.getRawDb();
  const reinforcementAlreadyRecordedStmt = rawDb
    ? rawDb.prepare(
        `SELECT 1
         FROM reinforcement_log
         WHERE fact_id = ?
           AND signal = 'positive'
           AND session_file IS ?
           AND topic IS ?
           AND query_snippet IS ?
         LIMIT 1`,
      )
    : null;
  const reinforcementAlreadyRecordedBySessionStmt = rawDb
    ? rawDb.prepare(
        `SELECT 1
         FROM reinforcement_log
         WHERE fact_id = ?
           AND signal = 'positive'
           AND session_file IS ?
         LIMIT 1`,
      )
    : null;

  // Capping limits from config
  const maxSessionsPerRun = implicitCfg.maxSessionsPerRun ?? 50;
  const maxSignalsPerRun = implicitCfg.maxSignalsPerRun ?? 100;
  const maxTrajectoriesPerRun = implicitCfg.maxTrajectoriesPerRun ?? 50;
  // 240s, not 300 (#2041): an external verification harness commonly wraps a step in a fixed 300s
  // timeout, so a soft internal deadline set to exactly that value leaves zero margin for this
  // function's own graceful-stop path (final progress emit, trajectory/session bookkeeping, DB
  // commit, process exit) to run before the external timeout kills the process with an opaque
  // exit=124 instead of the actionable partial result this cap exists to produce.
  const maxWallClockSeconds = implicitCfg.maxWallClockSeconds ?? 240;
  const startTimeMs = Date.now();

  const computeBacklogEstimates = (deferredSessions: number) => ({
    backlogSessionsEstimate: deferredSessions,
    backlogSignalsEstimate:
      deferredSessions > 0 ? Math.ceil((totalSignals / Math.max(1, progress.sessionsProcessed)) * deferredSessions) : 0,
    backlogTrajectoriesEstimate:
      deferredSessions > 0
        ? Math.ceil((trajectoriesBuilt / Math.max(1, progress.sessionsProcessed)) * deferredSessions)
        : 0,
  });

  const markPartialProgress = (
    reason: ExtractImplicitFeedbackStopReason,
    deferredSessions = filePaths.length - progress.sessionsVisited,
  ): void => {
    partial = true;
    partialReason = reason;
    sessionsDeferred = deferredSessions;
    const backlog = computeBacklogEstimates(deferredSessions);
    progress.partial = true;
    progress.partialReason = reason;
    progress.sessionsDeferred = deferredSessions;
    progress.backlogSessionsEstimate = backlog.backlogSessionsEstimate;
    progress.backlogSignalsEstimate = backlog.backlogSignalsEstimate;
    progress.backlogTrajectoriesEstimate = backlog.backlogTrajectoriesEstimate;
    emitProgress();
  };

  const wallClockLimitReached = (): boolean =>
    maxWallClockSeconds > 0 && (Date.now() - startTimeMs) / 1000 >= maxWallClockSeconds;
  const remainingWallClockMs = (): number => {
    if (maxWallClockSeconds <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, maxWallClockSeconds * 1000 - (Date.now() - startTimeMs));
  };
  const alreadyRecordedPositiveReinforcement = (factId: string, context: ReinforcementContext): boolean => {
    if (cfg.reinforcement?.trackContext === false) {
      return reinforcementAlreadyRecordedBySessionStmt?.get(factId, context.sessionFile ?? null) != null;
    }
    return (
      reinforcementAlreadyRecordedStmt?.get(
        factId,
        context.sessionFile ?? null,
        context.topic ?? null,
        context.querySnippet ?? null,
      ) != null
    );
  };

  const deferredIncludingCurrentSession = (): number => Math.max(0, filePaths.length - progress.sessionsVisited + 1);

  const applyPendingPositiveReinforcement = rawDb
    ? createTransaction(
        rawDb,
        (
          pending: Array<{
            factId: string;
            quoteSnippet: string;
            context: ReinforcementContext;
            boostAmount: number;
          }>,
        ) => {
          const trackContext = cfg.reinforcement?.trackContext !== false;
          const maxEventsPerFact = cfg.reinforcement?.maxEventsPerFact ?? 50;
          // Snapshot dedupe against pre-existing reinforcement rows only.
          // We intentionally avoid re-checking after each insert so trackContext=false
          // batches can apply multiple distinct boosts for the same fact/session.
          const skipByExisting = pending.map((item) => alreadyRecordedPositiveReinforcement(item.factId, item.context));
          for (const [index, item] of pending.entries()) {
            if (wallClockLimitReached()) {
              throw new ImplicitFeedbackWallClockExceededError();
            }
            if (skipByExisting[index]) continue;
            factsDb.reinforceFact(item.factId, item.quoteSnippet, item.context, {
              trackContext,
              maxEventsPerFact,
              boostAmount: item.boostAmount,
            });
            if (wallClockLimitReached()) {
              throw new ImplicitFeedbackWallClockExceededError();
            }
          }
        },
      )
    : null;

  for (const filePath of filePaths) {
    // Check if we've hit any caps
    if (wallClockLimitReached()) {
      markPartialProgress("maxWallClock");
      break;
    }
    if (maintenanceRunDeadlineReached()) {
      markPartialProgress("maxWallClock");
      break;
    }
    // BUG FIX #2: Check against sessionsVisited to ensure session cap includes skipped sessions
    if (maxSessionsPerRun > 0 && progress.sessionsVisited >= maxSessionsPerRun) {
      markPartialProgress("maxSessions");
      break;
    }
    if (maxSignalsPerRun > 0 && totalSignals >= maxSignalsPerRun) {
      markPartialProgress("maxSignals");
      break;
    }
    if (maxTrajectoriesPerRun > 0 && trajectoriesBuilt >= maxTrajectoriesPerRun) {
      markPartialProgress("maxTrajectories");
      break;
    }

    progress.sessionsVisited++;
    const sessionFile = basename(filePath);
    progress.currentSession = sessionFile;
    emitProgress();
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").split("\n");
    } catch (err) {
      progress.sessionsReadErrors++;
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "runExtractImplicitFeedbackForCli:read-file",
        severity: "info",
        subsystem: "implicit-feedback",
      });
      emitProgress();
      continue;
    }

    const turns = parseSessionTurns(lines);
    if (turns.length < 3) {
      progress.sessionsTooShort++;
      emitProgress();
      lastProcessedFilePath = filePath;
      continue;
    }

    /**
     * Shared daily quota for negative signals + trajectory lessons. Seeded from DB once per session
     * file; each store path re-reads `getImplicitFeedbackLessonsStoredToday` before quota-gated writes
     * so counts stay accurate after earlier phases in the same file.
     */
    let lessonsStoredTodaySession = rawDb ? getImplicitFeedbackLessonsStoredToday(rawDb) : 0;

    const trajectories =
      opts.includeTrajectories !== false && !opts.dryRun && rawDb ? buildTrajectories(turns, sessionFile) : [];
    const pendingPositiveReinforcement: Array<{
      factId: string;
      quoteSnippet: string;
      context: ReinforcementContext;
      boostAmount: number;
    }> = [];
    const pendingPositiveReinforcementKeys = new Set<string>();

    // Phase 1: Extract implicit signals
    const signals = extractImplicitSignals(turns, implicitCfg, sessionFile);

    if (opts.verbose) {
      for (const sig of signals) {
        logger?.info?.(
          `[${sessionFile}] ${sig.type} (${sig.polarity}, conf ${sig.confidence.toFixed(2)}): ${sig.context.userMessage.slice(0, 60)}`,
        );
      }
    }

    // If adding this session would exceed a per-run cap after prior work, defer the
    // current session without advancing the cursor past it. If this single session
    // alone exceeds the cap, process it anyway so one oversized transcript cannot
    // stall the incremental cursor forever.
    if (maxSignalsPerRun > 0 && totalSignals > 0 && totalSignals + signals.length > maxSignalsPerRun) {
      markPartialProgress("maxSignals", deferredIncludingCurrentSession());
      break;
    }
    if (
      maxTrajectoriesPerRun > 0 &&
      trajectoriesBuilt > 0 &&
      trajectoriesBuilt + trajectories.length > maxTrajectoriesPerRun
    ) {
      markPartialProgress("maxTrajectories", deferredIncludingCurrentSession());
      break;
    }

    // Check wall clock limit before tallying extracted signals to avoid overcounting
    // signals that are extracted but never stored or routed.
    if (wallClockLimitReached()) {
      markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
      break;
    }

    totalSignals += signals.length;
    for (const sig of signals) {
      if (sig.polarity === "positive") positiveCount++;
      else if (sig.polarity === "negative") negativeCount++;
    }

    progress.signalsExtracted = totalSignals;
    progress.positiveCount = positiveCount;
    progress.negativeCount = negativeCount;
    progress.trajectoriesBuilt = trajectoriesBuilt;
    emitProgress();

    if (!opts.dryRun && rawDb) {
      // Store raw signals in implicit_signals table
      try {
        const insert = rawDb.prepare(`
          INSERT OR IGNORE INTO implicit_signals (session_file, signal_type, confidence, polarity, user_message, agent_message, preceding_turns, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'implicit')
        `);
        for (const sig of signals) {
          try {
            insert.run(
              sig.context.sessionFile,
              sig.type,
              sig.confidence,
              sig.polarity,
              sig.context.userMessage.slice(0, 500),
              sig.context.agentMessage.slice(0, 500),
              sig.context.precedingTurns,
            );
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "runExtractImplicitFeedbackForCli:insert-signal",
              severity: "info",
              subsystem: "implicit-feedback",
            });
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:store-signals",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }

    // Check wall clock limit before reinforcement to prevent partial reinforcement
    // that would be replayed on the next run, causing duplicate reinforcement entries.
    if (wallClockLimitReached()) {
      markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
      break;
    }

    // Queue positive signals for reinforcement and apply them only after the whole
    // session finishes. This keeps retries idempotent when a wall-clock cap interrupts
    // later phases and lets us roll back the whole reinforcement batch if the budget
    // expires mid-batch.
    if (!opts.dryRun && implicitCfg.feedToReinforcement !== false && signals.length > 0) {
      const minConf = implicitCfg.minConfidence ?? 0.5;
      const positiveSignals = signals.filter((s) => s.polarity === "positive" && s.confidence >= minConf);
      for (const sig of positiveSignals) {
        if (wallClockLimitReached()) {
          markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
          break;
        }
        try {
          const searchQuery = sig.context.agentMessage || sig.context.userMessage;
          const matches = factsDb.search(searchQuery, 3);
          const querySnippet = sig.context.userMessage.slice(0, 200);
          const context: ReinforcementContext = {
            querySnippet,
            topic: sig.type,
            sessionFile: sig.context.sessionFile,
          };
          for (const match of matches) {
            if (wallClockLimitReached()) {
              markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
              break;
            }
            const dedupeKey = `${match.entry.id}\u0000${context.sessionFile ?? ""}\u0000${context.topic ?? ""}\u0000${querySnippet}`;
            if (pendingPositiveReinforcementKeys.has(dedupeKey)) continue;
            const alreadyReinforcedForSignal = alreadyRecordedPositiveReinforcement(match.entry.id, context);
            if (alreadyReinforcedForSignal) continue;
            pendingPositiveReinforcement.push({
              factId: match.entry.id,
              quoteSnippet: sig.context.userMessage,
              context,
              boostAmount: 0.5 * sig.confidence,
            });
            pendingPositiveReinforcementKeys.add(dedupeKey);
          }
          if (partial && partialReason === "maxWallClock") break;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runExtractImplicitFeedbackForCli:queue-reinforcement",
            severity: "info",
            subsystem: "implicit-feedback",
          });
        }
      }
      if (partial && partialReason === "maxWallClock") {
        break;
      }
    }

    // Route negative signals to self-correction as technical implicit_feedback_signal facts (same dedupe/quota as trajectory lessons).
    if (!opts.dryRun && implicitCfg.feedToSelfCorrection !== false && signals.length > 0) {
      const minConf = implicitCfg.minConfidence ?? 0.5;
      const maxLessonsPerDay = implicitCfg.maxLessonsPerDay ?? 50;
      const lessonDedupeJaccard = implicitCfg.lessonDedupeJaccard ?? 0.7;
      const negativeSignals = signals.filter((s) => s.polarity === "negative" && s.confidence >= minConf);
      for (const sig of negativeSignals) {
        if (
          implicitCfg.triggerSelfCorrectionRun &&
          sig.confidence >= bridgeMinConfidence &&
          bridgeIncidents.length < (implicitCfg.selfCorrectionBridgeMaxIncidents ?? 5)
        ) {
          let followingAssistant = "";
          const userTurnIndex = sig.context.precedingTurns;
          if (userTurnIndex + 1 < turns.length && turns[userTurnIndex + 1].role === "assistant") {
            followingAssistant = turns[userTurnIndex + 1].content;
          }
          bridgeIncidents.push({
            userMessage: sig.context.userMessage,
            precedingAssistant: sig.context.agentMessage,
            followingAssistant: followingAssistant.slice(0, 500),
            sessionFile: sig.context.sessionFile,
            timestamp: formatTimestampUtcFromMs(sig.context.timestamp),
          });
        }
        if (wallClockLimitReached()) {
          markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
          break;
        }
        try {
          lessonsStoredTodaySession = rawDb ? getImplicitFeedbackLessonsStoredToday(rawDb) : lessonsStoredTodaySession;
          const text = `[Implicit ${sig.type}] "${sig.context.userMessage.slice(0, 200)}"`;
          const similarId = rawDb != null ? findSimilarImplicitFeedbackLesson(rawDb, text, lessonDedupeJaccard) : null;
          if (similarId) {
            if (rawDb) markImplicitFeedbackLessonRecalled(rawDb, similarId);
            continue;
          }
          if (factsDb.hasDuplicate(text, "implicit-feedback")) continue;
          if (lessonsStoredTodaySession >= maxLessonsPerDay) continue;
          const storeResult = factsDb.storeWithResult({
            text,
            category: "technical",
            importance: Math.max(0.3, sig.confidence * 0.6),
            entity: null,
            key: "implicit_feedback_signal",
            value: text.slice(0, 200),
            source: "implicit-feedback",
            tags: ["implicit-feedback", "negative", sig.type],
            decayClass: "normal",
          });
          if (storeResult.skipped) {
            continue;
          }
          if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
            continue;
          }
          // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
          await cleanupEvictedVector({
            vectorDb: vectorDb,
            evictedFactId: storeResult.evictedFactId,
            logger: logger,
            context: "implicit-feedback",
          });
          lessonsStoredTodaySession++;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runExtractImplicitFeedbackForCli:feed-self-correction",
            severity: "info",
            subsystem: "implicit-feedback",
          });
        }
      }
      // If wall clock limit was reached during negative signal processing, exit session loop
      if (partial && partialReason === "maxWallClock") {
        break;
      }
    }

    // Check wall clock limit after signal storage and reinforcement
    if (wallClockLimitReached()) {
      markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
      break;
    }

    // Phase 2: Process trajectories (already built earlier for cap check)
    if (trajectories.length > 0 && opts.includeTrajectories !== false && !opts.dryRun && rawDb) {
      try {
        const insertTraj = rawDb.prepare(`
          INSERT OR REPLACE INTO feedback_trajectories
            (id, session_file, turns_json, outcome, outcome_signal, key_pivot, lessons_json, topic, tools_used, turn_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const findTrajectoryBySessionAndTurns = rawDb.prepare(
          `SELECT id
           FROM feedback_trajectories
           WHERE session_file = ? AND turns_json = ?
           LIMIT 1`,
        );
        if (implicitCfg.trajectoryLLMAnalysis && trajectories.length > 0) {
          const prompt = loadPrompt("trajectory-analyze");
          const nanoPref = getLLMModelPreference(getCronModelConfig(cfg), "nano");
          const model = nanoPref[0] ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
          const fallbackModels = nanoPref.length > 1 ? nanoPref.slice(1) : (cfg.distill?.fallbackModels ?? []);
          const runWallClockAbort = new AbortController();
          let stopTrajectoryLlm = false;
          const shouldStopTrajectoryLlm = (): boolean => stopTrajectoryLlm || runWallClockAbort.signal.aborted;
          const wallClockWatchdog = setInterval(() => {
            if (wallClockLimitReached()) {
              stopTrajectoryLlm = true;
              runWallClockAbort.abort(new Error("implicit-feedback wall-clock budget exceeded"));
            }
          }, 250);
          try {
            await runWithConcurrencyLimit(
              trajectories,
              TRAJECTORY_LLM_CONCURRENCY,
              async (traj) => {
                if (shouldStopTrajectoryLlm()) return;
                if (wallClockLimitReached()) {
                  stopTrajectoryLlm = true;
                  runWallClockAbort.abort(new Error("implicit-feedback wall-clock budget exceeded"));
                  return;
                }
                const llmBudgetMs = resolveTrajectoryLlmBudgetMs(remainingWallClockMs());
                if (llmBudgetMs === 0) {
                  // Stop scheduling new calls, but do not abort in-flight workers that already
                  // claimed budget — remaining wall-clock may be <1s while calls finish.
                  stopTrajectoryLlm = true;
                  return;
                }
                const deadlineMs = Date.now() + llmBudgetMs;
                const perCallAbort = new AbortController();
                const perCallTimeout = setTimeout(
                  () => perCallAbort.abort(new Error("implicit-feedback trajectory LLM budget exceeded")),
                  llmBudgetMs,
                );
                const disposeRunAbortLink = propagateAbortSignal(runWallClockAbort.signal, perCallAbort);
                const maintenanceAbort = getMaintenanceRunAbortSignal();
                const disposeMaintenanceAbortLink = maintenanceAbort
                  ? propagateAbortSignal(maintenanceAbort, perCallAbort)
                  : () => {};
                const chatFn = async (opts: { model?: string; messages: Array<{ role: string; content: string }> }) => {
                  const userMessage = opts.messages.find((m) => m.role === "user");
                  if (!userMessage) throw new Error("No user message found");
                  const timeoutMs = trajectoryCallTimeoutMs(deadlineMs);
                  if (timeoutMs === 0 || perCallAbort.signal.aborted || runWallClockAbort.signal.aborted) {
                    throw new Error("implicit-feedback trajectory LLM budget exceeded");
                  }
                  const detail = await chatCompleteWithRetryDetailed({
                    model: opts.model ?? model,
                    content: userMessage.content,
                    temperature: 0.2,
                    maxTokens: 4000,
                    openai,
                    fallbackModels,
                    label: "memory-hybrid: trajectory-analyze",
                    feature: CostFeature.trajectoryAnalyze,
                    timeoutMs,
                    timeoutMsPerModel: () => trajectoryCallTimeoutMs(deadlineMs),
                    signal: perCallAbort.signal,
                  });
                  return detail.content;
                };
                try {
                  const llmAnalysis = await analyzeTrajectoriesWithLLM(traj, prompt, chatFn);
                  if (llmAnalysis) {
                    traj.lessonsExtracted = [llmAnalysis.keyLesson, ...llmAnalysis.patterns];
                    if (llmAnalysis.pivotTurn !== null) {
                      traj.keyPivot = llmAnalysis.pivotTurn;
                    }
                    if (llmAnalysis.outcome) {
                      traj.outcome = llmAnalysis.outcome;
                    }
                  }
                } catch (err) {
                  if (wallClockLimitReached() || runWallClockAbort.signal.aborted) {
                    stopTrajectoryLlm = true;
                    return;
                  }
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    operation: "runExtractImplicitFeedbackForCli:llm-trajectory-analysis",
                    severity: "info",
                    subsystem: "implicit-feedback",
                  });
                } finally {
                  clearTimeout(perCallTimeout);
                  disposeRunAbortLink();
                  disposeMaintenanceAbortLink();
                }
                if (wallClockLimitReached()) {
                  stopTrajectoryLlm = true;
                  runWallClockAbort.abort(new Error("implicit-feedback wall-clock budget exceeded"));
                }
              },
              { shouldStop: shouldStopTrajectoryLlm },
            );
          } finally {
            clearInterval(wallClockWatchdog);
          }
        }

        for (const traj of trajectories) {
          try {
            // Check wall clock limit before persisting each trajectory
            if (wallClockLimitReached()) {
              markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
              break;
            }

            const row = serializeTrajectory(traj);
            const existingTrajectory = findTrajectoryBySessionAndTurns.get(row.session_file, row.turns_json) as
              | { id: string }
              | undefined;
            const trajectoryId = existingTrajectory?.id ?? row.id;
            const evictedFactIds: string[] = [];

            rawDb.prepare("BEGIN").run();
            try {
              if (wallClockLimitReached()) {
                throw new ImplicitFeedbackWallClockExceededError();
              }
              insertTraj.run(
                trajectoryId,
                row.session_file,
                row.turns_json,
                row.outcome,
                row.outcome_signal,
                row.key_pivot,
                row.lessons_json,
                row.topic,
                row.tools_used,
                row.turn_count,
              );
              // Store trajectory lessons as implicit-feedback signals, not reflection patterns.
              const maxLessonsPerDay = implicitCfg.maxLessonsPerDay ?? 50;
              const lessonDedupeJaccard = implicitCfg.lessonDedupeJaccard ?? 0.7;
              for (const lesson of traj.lessonsExtracted) {
                if (wallClockLimitReached()) {
                  throw new ImplicitFeedbackWallClockExceededError();
                }
                lessonsStoredTodaySession = rawDb
                  ? getImplicitFeedbackLessonsStoredToday(rawDb)
                  : lessonsStoredTodaySession;
                const trimmedLesson = lesson.trim();
                if (!trimmedLesson) continue;
                const similarId =
                  rawDb != null ? findSimilarImplicitFeedbackLesson(rawDb, trimmedLesson, lessonDedupeJaccard) : null;
                if (similarId || factsDb.hasDuplicate(trimmedLesson, "implicit-feedback")) {
                  if (similarId && rawDb) markImplicitFeedbackLessonRecalled(rawDb, similarId);
                  continue;
                }
                if (lessonsStoredTodaySession >= maxLessonsPerDay) continue;
                try {
                  const storeResult = factsDb.storeWithResult({
                    text: trimmedLesson,
                    category: "technical",
                    importance: 0.5,
                    entity: null,
                    key: "implicit_feedback_signal",
                    value: trimmedLesson.slice(0, 200),
                    source: "implicit-feedback",
                    tags: IMPLICIT_FEEDBACK_LESSON_TAGS,
                    decayClass: "normal",
                  });
                  if (storeResult.skipped) {
                    continue;
                  }
                  if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
                    continue;
                  }
                  if (storeResult.evictedFactId) {
                    evictedFactIds.push(storeResult.evictedFactId);
                  }
                  lessonsStoredTodaySession++;
                } catch (err) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    operation: "runExtractImplicitFeedbackForCli:store-lesson",
                    severity: "info",
                    subsystem: "implicit-feedback",
                  });
                }
              }
              if (wallClockLimitReached()) {
                throw new ImplicitFeedbackWallClockExceededError();
              }
              rawDb.prepare("COMMIT").run();
            } catch (err) {
              rawDb.prepare("ROLLBACK").run();
              if (err instanceof ImplicitFeedbackWallClockExceededError) {
                markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
                break;
              }
              throw err;
            }

            trajectoriesBuilt++;
            progress.trajectoriesBuilt = trajectoriesBuilt;

            // Count trajectory outcomes as implicit signals when turn-level heuristics found none.
            if (rawDb) {
              const polarity =
                traj.outcome === "success" || traj.outcome === "partial"
                  ? "positive"
                  : traj.outcome === "failure"
                    ? "negative"
                    : "neutral";
              const summary =
                traj.lessonsExtracted.find((l) => l.trim().length > 0)?.trim() ??
                `Trajectory ${traj.outcome}: ${traj.outcomeSignal}`;
              if (polarity !== "neutral" && summary.length > 0) {
                try {
                  const insertSignal = rawDb.prepare(`
                    INSERT OR IGNORE INTO implicit_signals (session_file, signal_type, confidence, polarity, user_message, agent_message, preceding_turns, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'trajectory')
                  `);
                  const changes = insertSignal.run(
                    traj.sessionFile,
                    `trajectory_${traj.outcomeSignal}`,
                    traj.outcome === "success" ? 0.65 : traj.outcome === "partial" ? 0.55 : 0.5,
                    polarity,
                    summary.slice(0, 500),
                    (traj.topic ?? "").slice(0, 500),
                    traj.keyPivot ?? 0,
                  ).changes;
                  if (changes > 0) {
                    totalSignals++;
                    if (polarity === "positive") positiveCount++;
                    else negativeCount++;
                    progress.signalsExtracted = totalSignals;
                    progress.positiveCount = positiveCount;
                    progress.negativeCount = negativeCount;
                  }
                } catch (err) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    operation: "runExtractImplicitFeedbackForCli:trajectory-signal",
                    severity: "info",
                    subsystem: "implicit-feedback",
                  });
                }
              }
            }

            emitProgress();

            // Keep vector maintenance outside the SQL transaction.
            // Note: We don't check wall clock here because evicted vector cleanup must complete
            // after a successful commit to avoid orphaned vectors. Cleanup is typically fast.
            for (const evictedFactId of new Set(evictedFactIds)) {
              await cleanupEvictedVector({
                vectorDb: vectorDb,
                evictedFactId,
                logger: logger,
                context: "implicit-feedback",
              });
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "runExtractImplicitFeedbackForCli:insert-trajectory",
              severity: "info",
              subsystem: "implicit-feedback",
            });
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:build-trajectories",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }

    // Check if wall clock limit was hit during trajectory processing
    if (partial && partialReason === "maxWallClock") {
      break;
    }

    if (pendingPositiveReinforcement.length > 0) {
      try {
        applyPendingPositiveReinforcement?.(pendingPositiveReinforcement);
      } catch (err) {
        if (err instanceof ImplicitFeedbackWallClockExceededError) {
          markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
          break;
        }
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:feed-reinforcement",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
        markPartialProgress("reinforcementError", deferredIncludingCurrentSession());
        break;
      }
    }

    // If budget expires after trajectory/reinforcement work but before finalizing
    // this session, defer it so the cursor does not advance past partially-finished work.
    if (wallClockLimitReached()) {
      markPartialProgress("maxWallClock", deferredIncludingCurrentSession());
      break;
    }

    // Mark session as processed after both Phase 1 (signal extraction) and Phase 2 (trajectories) complete.
    // This ensures the cursor only advances past sessions that have been fully processed.
    progress.sessionsProcessed++;
    lastProcessedFilePath = filePath;
    emitProgress();

    if (wallClockLimitReached()) {
      const remainingDeferred = filePaths.length - progress.sessionsVisited;
      if (remainingDeferred > 0) {
        markPartialProgress("maxWallClock", remainingDeferred);
      }
      break;
    }
  }

  if (!opts.dryRun && implicitCfg.autoCleanup !== false && rawDb) {
    if (wallClockLimitReached()) {
      if (!partial) markPartialProgress("maxWallClock");
    } else {
      try {
        progress.stage = "cleanup-duplicates";
        emitProgress();
        const cleanupLimit = implicitCfg.cleanupLimit ?? 1000;
        const threshold = implicitCfg.lessonDedupeJaccard ?? 0.7;
        let afterRowid = 0;
        let totalCollapsed = 0;
        let totalScanned = 0;
        let batches = 0;
        let carryCanonical: Array<{ id: string; text: string }> | undefined;
        for (;;) {
          if (wallClockLimitReached()) {
            if (!partial) markPartialProgress("maxWallClock");
            break;
          }
          const cleanup = cleanupImplicitFeedbackDuplicates(factsDb, {
            threshold,
            limit: cleanupLimit,
            afterRowid,
            seedCanonical: carryCanonical,
            wallClockCheck: wallClockLimitReached,
          });
          totalCollapsed += cleanup.collapsed;
          totalScanned += cleanup.scanned;
          batches++;
          carryCanonical = cleanup.carryCanonical;
          progress.cleanupCollapsed = totalCollapsed;
          progress.cleanupScanned = totalScanned;
          progress.cleanupBatches = batches;
          emitProgress();
          if (wallClockLimitReached()) {
            if (!partial) markPartialProgress("maxWallClock");
            break;
          }
          if (cleanup.interrupted) {
            if (!partial) markPartialProgress("maxWallClock");
            break;
          }
          if (cleanup.scanned < cleanupLimit || cleanup.resumeAfterRowid == null) break;
          afterRowid = cleanup.resumeAfterRowid;
        }
        if (opts.verbose && totalCollapsed > 0) {
          logger?.info?.(`Implicit-feedback cleanup: collapsed ${totalCollapsed} near-duplicate signal fact(s)`);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:cleanup-duplicates",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }
  }

  // Phase 3: Closed-loop analysis
  let closedLoopReport: string | undefined;
  if (opts.includeClosedLoop !== false && !opts.dryRun) {
    if (wallClockLimitReached()) {
      if (!partial) markPartialProgress("maxWallClock");
    } else {
      try {
        progress.stage = "closed-loop";
        emitProgress();
        const clCfg = cfg.closedLoop ?? { enabled: true };
        if (clCfg.enabled !== false) {
          const report = runClosedLoopAnalysis(factsDb, clCfg, { wallClockCheck: wallClockLimitReached });
          if (report.interrupted) {
            if (!partial) markPartialProgress("maxWallClock");
          }
          if (wallClockLimitReached()) {
            if (!partial) markPartialProgress("maxWallClock");
          }
          if (report.rulesAnalyzed > 0) {
            if (opts.verbose) {
              closedLoopReport = getEffectivenessReport(factsDb);
            }
            logger?.info?.(
              `Closed-loop: analyzed ${report.rulesAnalyzed} rules, deprecated ${report.deprecated}, boosted ${report.boosted}`,
            );
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:closed-loop",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }
  }

  progress.stage = "done";
  emitProgress();

  if (!opts.dryRun && implicitCfg.triggerSelfCorrectionRun && bridgeIncidents.length > 0 && !wallClockLimitReached()) {
    if (implicitCfg.llmSignalAnalysis !== false) {
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "maintenance");
      try {
        const filtered = await classifyAndFilterCorrectionIncidents({
          incidents: bridgeIncidents,
          openai,
          model: defaultModel,
          fallbackModels,
          minConfidence: implicitCfg.selfCorrectionBridgeMinConfidence ?? 0.7,
          batchSize: implicitCfg.llmSignalBatchSize ?? 10,
          factsDb,
          logger: {
            info: (msg) => logger?.info?.(msg),
            warn: (msg) => logger?.warn?.(msg),
          },
        });
        bridgeIncidents = filtered.incidents;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:llm-signal-bridge",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }
  }

  if (!opts.dryRun && implicitCfg.triggerSelfCorrectionRun && bridgeIncidents.length > 0 && !wallClockLimitReached()) {
    const cap = implicitCfg.selfCorrectionBridgeMaxIncidents ?? 5;
    const incidents = bridgeIncidents.slice(0, cap);
    const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
    try {
      const bridgeRes = await runSelfCorrectionRunForCli(ctx, { incidents, workspace, dryRun: false });
      logger?.info?.(
        `memory-hybrid: implicit-feedback self-correction bridge status=${bridgeRes.status ?? "unknown"} analysed=${bridgeRes.analysed} autoFixed=${bridgeRes.autoFixed}`,
      );
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "runExtractImplicitFeedbackForCli:self-correction-bridge",
        severity: "warning",
        subsystem: "implicit-feedback",
      });
    }
  }

  // Update scan cursor with the last fully processed session
  if (!opts.dryRun && lastProcessedFilePath && progress.sessionsProcessed > 0 && progress.sessionsReadErrors === 0) {
    const shouldAdvanceCursor =
      !partial ||
      partialReason === "maxSessions" ||
      partialReason === "maxSignals" ||
      partialReason === "maxTrajectories" ||
      partialReason === "maxWallClock" ||
      (partialReason === "reinforcementError" && progress.sessionsProcessed > 0);
    if (shouldAdvanceCursor) {
      const stat = statSync(lastProcessedFilePath);
      const lastSessionTs = stat.mtimeMs;
      const lastSessionFile = basename(lastProcessedFilePath);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs, progress.sessionsProcessed, lastSessionFile);
    }
  }

  // Calculate backlog estimates
  const backlog = computeBacklogEstimates(sessionsDeferred);

  return {
    signalsExtracted: totalSignals,
    positiveCount,
    negativeCount,
    trajectoriesBuilt,
    sessionsScanned: filePaths.length,
    sessionsVisited: progress.sessionsVisited,
    sessionsProcessed: progress.sessionsProcessed,
    sessionsSkipped: progress.sessionsReadErrors + progress.sessionsTooShort,
    sessionsDeferred,
    backlogSessionsEstimate: partial ? backlog.backlogSessionsEstimate : 0,
    backlogSignalsEstimate: partial ? backlog.backlogSignalsEstimate : 0,
    backlogTrajectoriesEstimate: partial ? backlog.backlogTrajectoriesEstimate : 0,
    partial,
    partialReason,
    closedLoopReport,
  };
}

// ---------------------------------------------------------------------------
// cross-agent-learning
// ---------------------------------------------------------------------------

export interface CrossAgentLearningCliResult {
  agentsScanned: number;
  lessonsConsidered: number;
  generalisedStored: number;
  provenanceRecorded: number;
  skippedDuplicates: number;
  errors: number;
}

/**
 * Run cross-agent learning: scan peer agent databases and generalise shared lessons.
 */
export async function runCrossAgentLearningForCli(
  ctx: HandlerContext,
  opts: { verbose?: boolean } = {},
): Promise<CrossAgentLearningCliResult> {
  const { factsDb, cfg } = ctx;
  const caCfg = cfg.crossAgentLearning;

  if (!caCfg?.enabled) {
    return {
      agentsScanned: 0,
      lessonsConsidered: 0,
      generalisedStored: 0,
      provenanceRecorded: 0,
      skippedDuplicates: 0,
      errors: 0,
    };
  }

  // Build OpenAI proxy
  const openai = ctx.openai;

  const result = await runCrossAgentLearning(factsDb, openai, caCfg, ctx.logger ?? {}, {
    verbose: opts.verbose === true,
  });

  // Record savings: each generalised pattern avoids re-learning by other agents
  if (result.generalisedStored > 0 && ctx.costTracker) {
    ctx.costTracker.recordSavings({
      feature: "cross-agent-learning",
      action: "generalised pattern stored",
      countAvoided: result.generalisedStored,
      estimatedSavingUsd: result.generalisedStored * 0.001,
      note: `${result.agentsScanned} agent(s) scanned, ${result.skippedDuplicates} duplicates skipped`,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// tool-effectiveness
// ---------------------------------------------------------------------------

export function resolveToolEffectivenessCliDbPaths(sqlitePath: string): {
  workflowDbPath: string;
  effectivenessDbPath: string;
} {
  return {
    workflowDbPath: join(dirname(sqlitePath), "workflow-traces.db"),
    effectivenessDbPath: sqlitePath.replace(/(\.[^.]+)?$/, "-tool-effectiveness.db"),
  };
}

function resolveLegacyWorkflowDbPath(sqlitePath: string): string {
  const sqliteBaseName = basename(sqlitePath);
  const extIndex = sqliteBaseName.lastIndexOf(".");
  const sqliteStem = extIndex > 0 ? sqliteBaseName.slice(0, extIndex) : sqliteBaseName;
  return join(dirname(sqlitePath), `${sqliteStem}-workflows.db`);
}

/** Helper to check if a DB path has valid workflow traces. */
function hasValidWorkflowTraces(dbPath: string): boolean {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_traces'`)
        .get() as { name: string } | undefined;
      if (!tableExists) return false;

      const rows = db.prepare("SELECT tool_sequence FROM workflow_traces").all() as { tool_sequence: string }[];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.tool_sequence) as unknown;
          if (!Array.isArray(parsed)) continue;
          const nonEmptyTools = parsed.filter(
            (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
          );
          if (nonEmptyTools.length > 0) return true;
        } catch {}
      }
      return false;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function explainToolEffectivenessNoData(
  sqlitePath: string,
  workflowDbPath: string,
  workflowTrackingEnabled: boolean,
): string {
  if (!existsSync(workflowDbPath)) {
    const legacyWorkflowDbPath = resolveLegacyWorkflowDbPath(sqlitePath);
    if (existsSync(legacyWorkflowDbPath) && hasValidWorkflowTraces(legacyWorkflowDbPath)) {
      return `workflow path mismatch: found legacy workflow DB at ${legacyWorkflowDbPath}, expected ${workflowDbPath}`;
    }
    if (!workflowTrackingEnabled) {
      return "workflow tracking is disabled (workflowTracking.enabled=false)";
    }
    return `workflow traces DB not found at ${workflowDbPath}`;
  }

  // Bug fix: Even when new DB exists, check if it's empty and legacy DB has actual traces
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workflowDbPath, { readOnly: true });
    try {
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_traces'`)
        .get() as { name: string } | undefined;

      if (!tableExists) {
        // No table yet - check for legacy DB with actual workflow traces
        const legacyWorkflowDbPath = resolveLegacyWorkflowDbPath(sqlitePath);
        if (existsSync(legacyWorkflowDbPath) && hasValidWorkflowTraces(legacyWorkflowDbPath)) {
          return `workflow path mismatch: found legacy workflow DB at ${legacyWorkflowDbPath}, expected ${workflowDbPath}`;
        }
        if (!workflowTrackingEnabled) {
          return "workflow tracking is disabled (workflowTracking.enabled=false)";
        }
        return "no workflow traces recorded yet";
      }

      const rowCount = (db.prepare("SELECT COUNT(*) as count FROM workflow_traces").get() as { count: number }).count;

      if (rowCount === 0) {
        // Empty table - check for legacy DB with actual workflow traces
        const legacyWorkflowDbPath = resolveLegacyWorkflowDbPath(sqlitePath);
        if (existsSync(legacyWorkflowDbPath) && hasValidWorkflowTraces(legacyWorkflowDbPath)) {
          return `workflow path mismatch: found legacy workflow DB at ${legacyWorkflowDbPath}, expected ${workflowDbPath}`;
        }
        if (!workflowTrackingEnabled) {
          return "workflow tracking is disabled (workflowTracking.enabled=false)";
        }
        return "no workflow traces recorded yet";
      }

      // Classify trace rows so zero-score explanations can distinguish
      // invalid/empty rows from below-threshold scoring.
      const rows = db.prepare("SELECT tool_sequence FROM workflow_traces").all() as { tool_sequence: string }[];
      let rowsWithNonEmptyTools = 0;
      let rowsWithInvalidOrEmptyTools = 0;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.tool_sequence) as unknown;
          if (!Array.isArray(parsed)) {
            rowsWithInvalidOrEmptyTools++;
            continue;
          }
          const nonEmptyTools = parsed.filter(
            (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
          );
          if (nonEmptyTools.length > 0) rowsWithNonEmptyTools++;
          else rowsWithInvalidOrEmptyTools++;
        } catch {
          rowsWithInvalidOrEmptyTools++;
        }
      }

      if (rowsWithNonEmptyTools === 0) {
        // Only check for legacy DB migration when current DB has no valid traces.
        // If we have valid traces but zero scored tools, the issue is threshold-related.
        const legacyWorkflowDbPath = resolveLegacyWorkflowDbPath(sqlitePath);
        if (existsSync(legacyWorkflowDbPath) && hasValidWorkflowTraces(legacyWorkflowDbPath)) {
          return `workflow path mismatch: found legacy workflow DB at ${legacyWorkflowDbPath}, expected ${workflowDbPath}`;
        }
        return "workflow traces exist but all have invalid or empty tool sequences";
      }

      if (rowsWithInvalidOrEmptyTools > 0) {
        return "workflow traces include invalid or empty tool sequences and no tools meet minimum call threshold for scoring";
      }

      // Has valid non-empty traces but none met scoring criteria (e.g., below minCalls threshold)
      return "workflow traces exist but no tools meet minimum call threshold for scoring";
    } finally {
      db.close();
    }
  } catch (err) {
    // Database exists but cannot be read - report the error
    const errMsg = err instanceof Error ? err.message : String(err);
    return `failed to read workflow traces DB: ${errMsg}`;
  }
}

/**
 * Compute and format a tool effectiveness report.
 */
export async function runToolEffectivenessForCli(
  ctx: HandlerContext,
  opts: { verbose?: boolean } = {},
): Promise<string> {
  const { cfg } = ctx;
  const teCfg = cfg.toolEffectiveness;

  if (teCfg?.enabled === false) {
    return "Tool effectiveness scoring is disabled (toolEffectiveness.enabled = false).";
  }

  if (opts.verbose) {
    (ctx.logger?.info ?? console.log)("memory-hybrid: tool-effectiveness — computing scores from workflow traces…");
  }
  // Derive the workflow store DB path from the sqlite path
  const resolvedSqlitePath =
    ctx.resolvedSqlitePath ?? cfg.sqlitePath ?? join(homedir(), ".openclaw", "memory", "memory.db");
  const { workflowDbPath, effectivenessDbPath } = resolveToolEffectivenessCliDbPaths(resolvedSqlitePath);

  let effStore: ToolEffectivenessStore;
  try {
    effStore = new ToolEffectivenessStore(effectivenessDbPath);
  } catch (err) {
    const baseError = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `tool-effectiveness: failed to open effectiveness DB at ${effectivenessDbPath} (workflowDb=${workflowDbPath}): ${baseError.message}`,
      { cause: baseError },
    );
  }
  try {
    const report = await computeToolEffectiveness(workflowDbPath, effStore, teCfg ?? {}, ctx.logger ?? {});

    // Gap 3 (#263): Generate monthly report, gated to once per calendar month
    const month = formatDateUtc(nowSec()).slice(0, 7); // YYYY-MM
    const monthlyKey = `tool-effectiveness-monthly-${month}`;
    try {
      const rawDb = ctx.factsDb.getRawDb();
      const existing = rawDb
        .prepare("SELECT id FROM facts WHERE key = ? AND superseded_at IS NULL LIMIT 1")
        .get(monthlyKey);
      if (!existing) {
        await generateMonthlyReport(effStore, ctx.factsDb, { embeddings: ctx.embeddings, vectorDb: ctx.vectorDb });
      }
    } catch (mrErr) {
      capturePluginError(mrErr instanceof Error ? mrErr : new Error(String(mrErr)), {
        operation: "tool-effectiveness-monthly-report-check",
        subsystem: "tool-effectiveness",
        severity: "info",
      });
    }

    if (report.toolsScored === 0) {
      return `No tool effectiveness data available (${explainToolEffectivenessNoData(
        resolvedSqlitePath,
        workflowDbPath,
        cfg.workflowTracking?.enabled === true,
      )}).`;
    }

    return formatToolEffectivenessReport(report);
  } finally {
    effStore.close();
  }
}

// ---------------------------------------------------------------------------
// cost-report
// ---------------------------------------------------------------------------

export interface CostReportCliOpts {
  days?: number;
  model?: boolean;
  feature?: string;
  csv?: boolean;
  /** Output format: "pretty" (default, emoji + percentages) or "compact" (terse, no emoji). */
  format?: "pretty" | "compact";
  /** Show config-mode cost estimate table instead of live data. */
  modes?: boolean;
}

/**
 * Show LLM cost breakdown by feature (or model with --model flag).
 * Issue #270.
 */
export function runCostReportForCli(
  ctx: HandlerContext,
  opts: CostReportCliOpts,
  sink: { log: (msg: string) => void },
): void {
  const { costTracker } = ctx;
  const { log } = sink;
  const days = opts.days ?? 7;
  const verbosity = ctx.cfg.verbosity ?? "normal";
  // quiet: only totals (compact layout); normal/verbose: full per-feature breakdown with savings
  const compact = opts.format === "compact" || isCompactVerbosity(verbosity);

  // --modes: show config-mode cost estimate table (no live data needed)
  if (opts.modes) {
    const estimates = getModeCostEstimates();
    if (!compact) {
      log("");
      log("📊 Config-Mode Cost Estimates ($/month, estimated)");
      log("   Based on typical usage with the default cheapest model (gpt-4.1-nano).");
      log("   Actual costs depend on your volume, model choices, and feature config.");
      log("");
    } else {
      log("───── Config-Mode Cost Estimates ─────");
    }
    const modeW = 12;
    const descW = 58;
    const costW = 20;
    const header = ["Mode".padEnd(modeW), "Description".padEnd(descW), "Est. $/month".padStart(costW)].join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const e of estimates) {
      const costRange = `$${e.monthlyLow.toFixed(2)} – $${e.monthlyHigh.toFixed(2)}`;
      log([e.mode.padEnd(modeW), e.description.padEnd(descW), costRange.padStart(costW)].join("  "));
      if (!compact) {
        log(`${"".padEnd(modeW)}  Features: ${e.features.join(", ")}`);
        log("");
      }
    }
    if (!compact) {
      log("Set mode: openclaw hybrid-mem config-mode <mode>");
    }
    return;
  }

  if (!costTracker) {
    if (!ctx.cfg.costTracking?.enabled) {
      log("Cost tracking is disabled.");
      log("Enable it: openclaw hybrid-mem config-set costTracking enabled");
    } else {
      log("Cost tracking is not available (costTracker not initialized).");
    }
    return;
  }

  function fmtNum(n: number): string {
    return n.toLocaleString("en-US");
  }
  function fmtCost(n: number): string {
    return `$${n.toFixed(4)}`;
  }
  function pct(part: number, total: number): string {
    if (total === 0) return "  0%";
    return `${Math.round((part / total) * 100)}%`.padStart(4);
  }

  if (opts.model) {
    // Model breakdown
    const breakdown = costTracker.getModelBreakdown(days);
    if (breakdown.length === 0) {
      if (compact) {
        log(`No LLM cost data in the last ${days} days.`);
      } else {
        log(`\n✅ Cost tracking is active — no data yet for the last ${days} days.`);
        log("   Data appears after your first LLM calls (~1 hour of typical use).");
      }
      return;
    }
    if (opts.csv) {
      log("model,calls,input_tokens,output_tokens,est_cost_usd");
      for (const r of breakdown) {
        log(`${r.model},${r.calls},${r.inputTokens},${r.outputTokens},${r.estimatedCostUsd.toFixed(6)}`);
      }
      return;
    }
    const total = breakdown.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        estimatedCostUsd: acc.estimatedCostUsd + r.estimatedCostUsd,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    );
    if (!compact) {
      log(`\n📊 LLM Cost Report — by Model (last ${days} days)`);
      log(`💰 Total: ${fmtCost(total.estimatedCostUsd)} across ${total.calls} calls`);
      log("");
    } else {
      log(`\n───── LLM Cost by Model (last ${days} days) ─────`);
    }
    const colW = [Math.max(20, ...breakdown.map((r) => r.model.length)) + 2, 8, 12, 12, 12, 5];
    const header = [
      "Model".padEnd(colW[0]!),
      "Calls".padStart(colW[1]!),
      "In-Tokens".padStart(colW[2]!),
      "Out-Tokens".padStart(colW[3]!),
      "Est. Cost".padStart(colW[4]!),
      ...(compact ? [] : ["  %".padStart(colW[5]!)]),
    ].join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const r of breakdown) {
      log(
        [
          r.model.padEnd(colW[0]!),
          String(r.calls).padStart(colW[1]!),
          fmtNum(r.inputTokens).padStart(colW[2]!),
          fmtNum(r.outputTokens).padStart(colW[3]!),
          fmtCost(r.estimatedCostUsd).padStart(colW[4]!),
          ...(compact ? [] : [pct(r.estimatedCostUsd, total.estimatedCostUsd).padStart(colW[5]!)]),
        ].join("  "),
      );
    }
    log("─".repeat(header.length));
    log(
      [
        "Total".padEnd(colW[0]!),
        String(total.calls).padStart(colW[1]!),
        fmtNum(total.inputTokens).padStart(colW[2]!),
        fmtNum(total.outputTokens).padStart(colW[3]!),
        fmtCost(total.estimatedCostUsd).padStart(colW[4]!),
        ...(compact ? [] : ["100%".padStart(colW[5]!)]),
      ].join("  "),
    );
  } else {
    // Feature breakdown
    const report = costTracker.getReport({ days, feature: opts.feature });
    const savingsReport = costTracker.getSavingsReport(days);

    // Build a savings lookup by feature for fast join
    const savingsByFeature = new Map<string, number>();
    for (const s of savingsReport.features) {
      savingsByFeature.set(s.feature, s.estimatedSavingUsd);
    }

    if (report.features.length === 0) {
      if (compact) {
        log(`No LLM cost data in the last ${days} days.`);
      } else {
        log(`\n✅ Cost tracking is active — no data yet for the last ${days} days.`);
        log("   Costs will appear here after your first LLM calls (~1 hour of typical use).");
      }
      // Still show savings if any exist (value delivered without cost)
      if (savingsReport.total.estimatedSavingUsd > 0 && !compact) {
        log(
          `\n💚 Automation savings (last ${days} days): ${fmtCost(savingsReport.total.estimatedSavingUsd)} (${savingsReport.total.countAvoided} ops avoided)`,
        );
      }
      return;
    }
    if (opts.csv) {
      log("feature,calls,input_tokens,output_tokens,est_cost_usd,est_savings_usd,net_cost_usd");
      for (const r of report.features) {
        const savings = savingsByFeature.get(r.feature) ?? 0;
        log(
          `${r.feature},${r.calls},${r.inputTokens},${r.outputTokens},${r.estimatedCostUsd.toFixed(6)},${savings.toFixed(6)},${(r.estimatedCostUsd - savings).toFixed(6)}`,
        );
      }
      return;
    }

    const totalSavings = savingsReport.total.estimatedSavingUsd;
    const netCost = report.total.estimatedCostUsd - totalSavings;

    if (!compact) {
      const featureCount = report.features.length;
      log(`\n📊 LLM Cost Report — last ${days} days`);
      log(
        `💰 Gross cost: ${fmtCost(report.total.estimatedCostUsd)} across ${featureCount} feature${featureCount === 1 ? "" : "s"} (${report.total.calls} LLM calls)`,
      );
      if (totalSavings > 0) {
        log(`💚 Automation savings: ${fmtCost(totalSavings)} (${savingsReport.total.countAvoided} ops avoided)`);
        log(`📉 Net cost: ${fmtCost(Math.max(0, netCost))}`);
      }
      log("");
    } else {
      log(`\n───── LLM Cost Report (last ${days} days) ─────`);
    }

    const hasSavings = totalSavings > 0;
    // Column widths: Feature | Calls | In-Tokens | Out-Tokens | Est.Cost | [Savings] | [Net] | [%]
    const colW = [
      Math.max(20, ...report.features.map((r) => r.feature.length)) + 2,
      8,
      12,
      12,
      12,
      ...(hasSavings ? [12, 12] : []),
      ...(compact ? [] : [5]),
    ];
    const headerParts = [
      "Feature".padEnd(colW[0]!),
      "Calls".padStart(colW[1]!),
      "In-Tokens".padStart(colW[2]!),
      "Out-Tokens".padStart(colW[3]!),
      "Est. Cost".padStart(colW[4]!),
    ];
    if (hasSavings) {
      headerParts.push("Savings".padStart(colW[5]!));
      headerParts.push("Net Cost".padStart(colW[6]!));
    }
    if (!compact) {
      headerParts.push("  %".padStart(colW[hasSavings ? 7 : 5]!));
    }
    const header = headerParts.join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const r of report.features) {
      const savings = savingsByFeature.get(r.feature) ?? 0;
      const net = Math.max(0, r.estimatedCostUsd - savings);
      const parts = [
        r.feature.padEnd(colW[0]!),
        String(r.calls).padStart(colW[1]!),
        fmtNum(r.inputTokens).padStart(colW[2]!),
        fmtNum(r.outputTokens).padStart(colW[3]!),
        fmtCost(r.estimatedCostUsd).padStart(colW[4]!),
      ];
      if (hasSavings) {
        parts.push((savings > 0 ? `-$${savings.toFixed(4)}` : "").padStart(colW[5]!));
        parts.push(fmtCost(net).padStart(colW[6]!));
      }
      if (!compact) {
        parts.push(pct(r.estimatedCostUsd, report.total.estimatedCostUsd).padStart(colW[hasSavings ? 7 : 5]!));
      }
      log(parts.join("  "));
    }
    log("─".repeat(header.length));
    const totalParts = [
      "Total".padEnd(colW[0]!),
      String(report.total.calls).padStart(colW[1]!),
      fmtNum(report.total.inputTokens).padStart(colW[2]!),
      fmtNum(report.total.outputTokens).padStart(colW[3]!),
      fmtCost(report.total.estimatedCostUsd).padStart(colW[4]!),
    ];
    if (hasSavings) {
      totalParts.push(`-$${totalSavings.toFixed(4)}`.padStart(colW[5]!));
      totalParts.push(fmtCost(Math.max(0, netCost)).padStart(colW[6]!));
    }
    if (!compact) {
      totalParts.push("100%".padStart(colW[hasSavings ? 7 : 5]!));
    }
    log(totalParts.join("  "));
    log("");
    // Unknown-model warning
    if (report.unknownModelCalls > 0) {
      log(
        `⚠️  ${report.unknownModelCalls} call(s) used unrecognized models (cost unknown): ${report.unknownModels.join(", ")}`,
      );
    }
    // Model summary line
    const modelBreakdown = costTracker.getModelBreakdown(days);
    if (modelBreakdown.length > 0) {
      const modelSummary = modelBreakdown.map((m) => `${m.model} (${m.calls} calls)`).join(", ");
      log(`Models used: ${modelSummary}`);
    }
    // Savings breakdown if any (and we have savings not already shown inline)
    if (!hasSavings && savingsReport.features.length > 0) {
      log("");
      log(
        `💚 Automation savings (last ${days} days): ${fmtCost(savingsReport.total.estimatedSavingUsd)} (${savingsReport.total.countAvoided} ops avoided)`,
      );
    }
  }
  log("");
  log("ℹ️  Costs are estimates based on published model pricing. Actual costs may vary.");
  log("   Embedding calls are not included in this report.");
}
