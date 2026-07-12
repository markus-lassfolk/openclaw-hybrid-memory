/**
 * Dream Cycle Service — Automated nightly reflection + pruning pipeline (Issue #143).
 *
 * Sequence (verbose `step N:` numbers are assigned in runtime order so skipped optional phases do not leave gaps):
 *  prune / decay / orphaned links → episodic consolidation + event log maintenance → reflection (patterns) →
 *  optional reflect-rules (if enough patterns) → MEMORY_INDEX refresh → prune log tables → FTS5 optimize →
 *  optional VACUUM → digest summary.
 *
 * Designed to be cheap ($0.003/night target) using a Flash-tier model.
 * Self-contained — does not require an active agent session.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";
import type { EventLog, EventLogEntry, EventType } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryCategory, MemoryEntry } from "../types/memory.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { CONSOLIDATED_FACT_DECAY_CLASS } from "../utils/consolidation-controls.js";
import { formatCompactRunIdUtc, formatTimestampUtcFromMs, nowIso } from "../utils/dates.js";
import { emitDreamCycleComplete } from "./change-feed-emit.js";
import { type DreamCycleProposalBridgeInput, runDreamCycleProposalBridge } from "./dream-cycle-proposal-bridge.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { decayEpisodeCausalLinks } from "./episode-causal-inference.js";
import { capturePluginError } from "./error-reporter.js";
import { emitFeatureTelemetry } from "./feature-telemetry.js";
import { writeMemoryIndex } from "./memory-index.js";
import type { ProvenanceService } from "./provenance.js";
import {
  countActivePatternFactsForMaintenance,
  type ReflectionConfig,
  runReflection,
  runReflectionRules,
} from "./reflection.js";
import { cleanupEvictedVector, deleteVectorsForFactIds, reconcileOrphanVectors } from "./vector-maintenance.js";
import { isWorkshopEnabled } from "./workshop-config.js";
import { syncWorkshopProposedEvents, withWorkshopDefaults } from "./workshop-service.js";

/** Prune modes for the dream cycle. */
export type DreamCyclePruneMode = "expired" | "decay" | "both";

/** Configuration for the nightly dream cycle. */
export interface DreamCycleConfig {
  enabled: boolean;
  schedule: string;
  reflectWindowDays: number;
  pruneMode: DreamCyclePruneMode;
  model: string;
  /** Fallback models for reflection steps, in preference order. */
  fallbackModels?: string[];
  consolidateAfterDays: number;
  /** Archive consolidated event log entries older than this many days. */
  eventLogArchivalDays: number;
  /** Directory for compressed JSONL archives. */
  eventLogArchivePath: string;
  /** Delete unconsolidated event log entries older than this many days. */
  maxUnconsolidatedAgeDays: number;
  /** Maximum events to merge into one consolidated fact. Default: 200. */
  maxEventsPerConsolidation: number;
  /**
   * Retention window for log tables (recall_log, reinforcement_log, feedback_trajectories).
   * Rows older than this many days are deleted. 0 = disabled. Default: 30.
   */
  logRetentionDays: number;
  /**
   * When true, run wal_checkpoint(TRUNCATE) + VACUUM after the cycle to reclaim freed space.
   * Default: true.
   */
  vacuumOnCycle: boolean;
  /**
   * When true, run the source-/importance-aware decay reclassifier (#1189) as part of the
   * nightly cycle. Defaults to true; operators can opt out by setting it to false.
   */
  reclassifyDecayOnCycle?: boolean;
  /** Inactivity threshold in days for the recall-based demotion path. Default: 90. */
  reclassifyInactiveDays?: number;
  /** Recall count required to promote a fact to a longer-lived class. Default: 3. */
  reclassifyPromoteRecallCount?: number;
  /** When true, log episodic consolidation / reflection / memory-index detail (CLI `--verbose`). */
  verbose?: boolean;
  /**
   * Episodic consolidation filter on `event.eventType` (#1185). Built-in deny list always includes
   * session/heartbeat/transport lifecycle types unless removed via config.
   */
  episodicConsolidationEventTypes?: {
    /** When non-empty, only these event types are eligible (after deny). */
    allow?: string[];
    /** Extra types to treat as noise (merged with built-in deny list). */
    deny?: string[];
  };
  /**
   * When true, enable reflection rules generation during the dream cycle.
   * Cost optimization: Set to false to save 30-40% of dream cycle LLM cost.
   * Default: true (enabled for backward compatibility).
   */
  enableReflectionRules?: boolean;
  /**
   * Directory where per-stage durable JSON artifacts are written (Issue #1827).
   * Each stage writes `stage-NN-<label>.json` with started/succeeded/failed status,
   * timing, and summary. Created automatically if it does not exist.
   * When unset (default), no artifact files are written.
   */
  stageArtifactDir?: string;
  /**
   * Run identifier for this dream cycle execution (Issue #1827).
   * When unset, a new run ID is generated. When set, the provided ID is used
   * for both the directory name and artifact `runId` field to ensure consistency.
   */
  runId?: string;
  /**
   * When true, WAL replay failed before the cycle started and episodic consolidation
   * is skipped to avoid operating on a stale SQLite view.
   */
  walFlushFailed?: boolean;
  /**
   * When true, run the wiki dream ingester as a post-cycle step.
   * Reads dream cycle artifacts and stores novel findings as facts.
   * Default: false.
   */
  ingestDreamFindings?: boolean;
  /**
   * When true, preview what the cycle would prune/consolidate/reflect/promote without mutating
   * facts, links, episodes, or proposals (#2089). Stages with no preview support are skipped and
   * reported as such rather than silently running with side effects. Default: false.
   */
  dryRun?: boolean;
}

/** Optional bridge context for auto-proposing reflection output (Phase 4). */
export type DreamCycleBridgeOpts = Pick<
  DreamCycleProposalBridgeInput,
  "cfg" | "proposalsDb" | "api" | "crystallizationStore" | "toolProposalStore" | "changeFeed"
> & { resolvedSqlitePath?: string; workflowStore?: import("../backends/workflow-store.js").WorkflowStore | null };

/** Result returned by a single dream cycle run. */
export interface DreamCycleResult {
  /** Facts removed by pruneExpired(). */
  factsPruned: number;
  /** Facts whose confidence was decayed (confidence halved). */
  factsDecayed: number;
  /** Orphaned memory_links rows removed. */
  linksPruned: number;
  /** Episodic event log entries successfully consolidated. */
  eventsConsolidated: number;
  /** New consolidated facts created from episodic events. */
  factsCreated: number;
  /** New patterns stored by runReflection(). */
  patternsFound: number;
  /** New rules stored by runReflectionRules(). */
  rulesGenerated: number;
  /** Reflect-rules diagnostics for zero/partial outcomes. */
  reflectionRulesDiagnostics?: {
    modelResponseChars: number;
    parseSuccess: boolean;
    parsedCandidates: number;
    rejectedDuplicates: number;
    rejectedLowConfidence: number;
    stored: number;
    zeroRulesReason?: string;
    status: "ok" | "partial" | "degraded";
  };
  /** Log table rows deleted by pruneLogTables() (Issue #573). */
  logRowsPruned: number;
  /** True when VACUUM + checkpoint was executed (Issue #573). */
  vacuumRan: boolean;
  /** Number of facts re-tiered by the source-/importance-aware reclassifier (#1189). */
  decayReclassified: number;
  /** Number of orphaned LanceDB vector entries removed during reconciliation. */
  orphanVectorsRemoved: number;
  /** Human-readable summary of the cycle. */
  digestSummary: string;
  /** True when the cycle was skipped because nightlyCycle.enabled = false. */
  skipped: boolean;
  /** False when any core stage recorded a failure (errors are also listed in failedStages). */
  success: boolean;
  /** Labels of core stages that failed (non-fatal stages still run afterward). */
  failedStages: string[];
  /** Number of dream findings ingested as facts by the wiki dream ingester post-step. */
  dreamFindingsIngested?: number;
  /**
   * True when this run was a preview (#2089) — counts reflect what would happen, but no facts,
   * links, episodes, proposals, or files were mutated. Stages with no preview support ran zero
   * work and reported 0/false for their counters.
   */
  dryRun?: boolean;
}

// Minimum patterns stored in one cycle before we also run reflect-rules.
const MIN_PATTERNS_FOR_RULES = 3;
export const DEFAULT_MAX_EVENTS_PER_CONSOLIDATION = 200;
const DREAM_STAGE_HEARTBEAT_MS = 60_000;
const EPISODIC_PROGRESS_HEARTBEAT_MS = 60_000;
/** Maximum characters used from the stage label in artifact filenames (Issue #1827). */
const STAGE_LABEL_MAX_LENGTH = 60;

/**
 * Returns a run identifier string that encodes the UTC timestamp and process PID,
 * suitable for directory names and artifact fields (Issue #1827).
 * Format: `YYYYMMDDTHHmmssZ-<pid>` e.g. `20260602T061400Z-12345`.
 */
export function makeDreamCycleRunId(): string {
  return `${formatCompactRunIdUtc()}-${process.pid}`;
}
const EPISODIC_PROGRESS_GROUP_INTERVAL = 25;
const SKIP_CONSOLIDATION_TEXT_PATTERNS = new Set([
  "heartbeat",
  "session_end",
  "session_start",
  "transport_connect",
  "transport_disconnect",
]);

/** Default deny list for `event.eventType` during episodic consolidation (#1185). */
export const DEFAULT_EPISODIC_CONSOLIDATION_EVENT_TYPE_DENY: ReadonlySet<EventType> = new Set([
  "session_start",
  "session_end",
  "heartbeat",
  "transport_connect",
  "transport_disconnect",
]);

export type EpisodicConsolidationEventTypeFilter = {
  allow?: string[];
  deny?: string[];
};

function isVectorBackendAvailable(vectorDb: Pick<VectorDB, "isLanceDbAvailable"> | unknown): boolean {
  const candidate = vectorDb as { isLanceDbAvailable?: () => boolean };
  if (typeof candidate.isLanceDbAvailable !== "function") return true;
  return candidate.isLanceDbAvailable();
}

function episodicDenySet(filter?: EpisodicConsolidationEventTypeFilter | null): Set<string> {
  const s = new Set<string>(DEFAULT_EPISODIC_CONSOLIDATION_EVENT_TYPE_DENY);
  for (const x of filter?.deny ?? []) {
    if (typeof x === "string" && x.trim().length > 0) s.add(x.trim());
  }
  return s;
}

/**
 * True when this event should not be merged into consolidated facts based on `eventType`
 * (allow/deny lists). Text-pattern skipping remains in {@link shouldSkipEpisodicConsolidation}.
 *
 * CRITICAL FIX (#5): Allow list now overrides deny list. If an event type is explicitly
 * in the allow list, it is accepted even if it's in the default deny set.
 */
export function shouldSkipEpisodicConsolidationByEventType(
  event: EventLogEntry,
  filter?: EpisodicConsolidationEventTypeFilter | null,
): boolean {
  const allow = filter?.allow?.map((x) => x.trim()).filter((x) => x.length > 0);
  // If allow list is specified and contains this event type, accept it (override deny).
  if (allow && allow.length > 0) {
    if (allow.includes(event.eventType)) return false;
    // If allow list is specified but doesn't contain this event type, reject it.
    return true;
  }
  // No allow list specified, check deny list.
  const deny = episodicDenySet(filter);
  if (deny.has(event.eventType)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Episodic consolidation helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract the primary text content from an event log entry.
 * Checks common content field names in priority order.
 */
export function extractEventText(event: EventLogEntry): string {
  const c = event.content;
  if (typeof c.text === "string" && c.text.trim().length > 0) return c.text.trim();
  if (typeof c.decision === "string" && c.decision.trim().length > 0) return c.decision.trim();
  if (typeof c.summary === "string" && c.summary.trim().length > 0) return c.summary.trim();
  if (typeof c.action === "string" && c.action.trim().length > 0) return c.action.trim();
  if (typeof c.description === "string" && c.description.trim().length > 0) return c.description.trim();
  // Fall back to any string value in the content object
  for (const v of Object.values(c)) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

/**
 * Group event log entries by their primary entity.
 * Events with no entities are grouped under the "__default__" key.
 * Callers should omit lifecycle/noise events (e.g. via `shouldSkipEpisodicConsolidation` and
 * `shouldSkipEpisodicConsolidationByEventType`) before calling.
 */
export function groupEventsByEntity(events: EventLogEntry[]): Map<string, EventLogEntry[]> {
  const groups = new Map<string, EventLogEntry[]>();
  for (const event of events) {
    const primaryEntity = event.entities?.[0] ?? "__default__";
    if (!groups.has(primaryEntity)) groups.set(primaryEntity, []);
    groups.get(primaryEntity)?.push(event);
  }
  return groups;
}

export function shouldSkipEpisodicConsolidation(event: EventLogEntry): boolean {
  const text = extractEventText(event).toLowerCase();
  for (const pattern of SKIP_CONSOLIDATION_TEXT_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

export const CONSOLIDATED_FACT_TEXT_MAX_LENGTH = 500;

/**
 * Build searchable text for a consolidated episodic fact, packing as many event
 * snippets as fit within {@link maxLength} (default 500).
 */
export function buildConsolidatedFactText(
  eventTexts: string[],
  entityLabel: string | null,
  maxLength = CONSOLIDATED_FACT_TEXT_MAX_LENGTH,
): string {
  if (eventTexts.length === 0) return "";
  if (eventTexts.length === 1) return eventTexts[0].slice(0, maxLength);

  const prefix = `[consolidated from ${eventTexts.length} events${entityLabel ? ` about ${entityLabel}` : ""}] `;
  let result = prefix;
  let lastRepresentedIndex = -1;
  for (let i = 0; i < eventTexts.length; i++) {
    const sep = lastRepresentedIndex >= 0 ? "; " : "";
    const snippet = eventTexts[i];
    const candidate = result + sep + snippet;
    if (candidate.length <= maxLength) {
      result = candidate;
      lastRepresentedIndex = i;
      continue;
    }
    const room = maxLength - result.length - sep.length;
    if (room > 10) {
      result += sep + snippet.slice(0, room);
      lastRepresentedIndex = i;
    }
    break;
  }
  const omitted = lastRepresentedIndex >= 0 ? eventTexts.length - (lastRepresentedIndex + 1) : eventTexts.length;
  if (omitted > 0) {
    const suffix = ` (+${omitted} more)`;
    const allowedBodyLen = maxLength - suffix.length;
    if (result.length > allowedBodyLen) {
      result = result.slice(0, allowedBodyLen).replace(/; [^;]*$/, "");
    }
    result += suffix;
  }
  return result.slice(0, maxLength);
}

/**
 * Build the digest summary string from cycle counts.
 * Exported so it can be tested independently.
 */
export function buildDigestSummary(counts: {
  factsPruned: number;
  factsDecayed: number;
  linksPruned?: number;
  eventsConsolidated: number;
  factsCreated: number;
  patternsFound: number;
  rulesGenerated: number;
  logRowsPruned?: number;
  vacuumRan?: boolean;
  decayReclassified?: number;
  orphanVectorsRemoved?: number;
  failedStages?: string[];
}): string {
  const parts: string[] = [];
  if (counts.factsPruned > 0) parts.push(`${counts.factsPruned} facts pruned`);
  if (counts.factsDecayed > 0) parts.push(`${counts.factsDecayed} facts decayed`);
  if (counts.decayReclassified && counts.decayReclassified > 0) {
    parts.push(`${counts.decayReclassified} facts re-tiered`);
  }
  if (counts.orphanVectorsRemoved && counts.orphanVectorsRemoved > 0) {
    parts.push(`${counts.orphanVectorsRemoved} orphaned vectors reconciled`);
  }
  if (counts.linksPruned && counts.linksPruned > 0) parts.push(`${counts.linksPruned} orphaned links removed`);
  if (counts.eventsConsolidated > 0) {
    parts.push(`${counts.eventsConsolidated} events consolidated into ${counts.factsCreated} facts`);
  }
  if (counts.patternsFound > 0) parts.push(`${counts.patternsFound} patterns extracted`);
  if (counts.rulesGenerated > 0) parts.push(`${counts.rulesGenerated} rules generated`);
  if (counts.logRowsPruned && counts.logRowsPruned > 0) parts.push(`${counts.logRowsPruned} log rows pruned`);
  if (counts.vacuumRan) parts.push("VACUUM ran");
  const failedStages = counts.failedStages?.filter((stage) => stage.length > 0) ?? [];
  if (failedStages.length > 0 && parts.length === 0) {
    return `Stages failed: ${failedStages.join(", ")}.`;
  }
  if (failedStages.length > 0) {
    parts.push(`${failedStages.length} stage(s) failed (${failedStages.join(", ")})`);
  }
  if (parts.length === 0) return "No changes.";
  return `${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Episodic consolidation
// ---------------------------------------------------------------------------

/**
 * Run episodic consolidation:
 *  1. Fetch unconsolidated event log entries older than consolidateAfterDays.
 *  2. Group by primary entity.
 *  3. For each group, create a consolidated fact with structured provenance_json.
 *  4. Mark all events as consolidated in the event log.
 *  5. Optionally embed and store consolidated facts in LanceDB so they are
 *     discoverable by semantic search (non-fatal; requires vectorDb + embeddings).
 *
 * Historical versions created one DERIVED_FROM graph edge per source event; new
 * consolidations keep that lineage on the fact row to avoid provenance mega-hubs.
 */
export async function runEpisodicConsolidation(
  factsDb: FactsDB,
  eventLog: EventLog,
  consolidateAfterDays: number,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  verbose?: boolean,
  maxEventsPerConsolidation = DEFAULT_MAX_EVENTS_PER_CONSOLIDATION,
  eventTypeFilter?: EpisodicConsolidationEventTypeFilter | null,
  vectorDb?: VectorDB | null,
  embeddings?: EmbeddingProvider | null,
): Promise<{ eventsConsolidated: number; factsCreated: number }> {
  const events = eventLog.getUnconsolidated(consolidateAfterDays);
  if (events.length === 0) {
    return { eventsConsolidated: 0, factsCreated: 0 };
  }

  let eventsConsolidated = 0;
  const skippedTextEvents = events.filter(shouldSkipEpisodicConsolidation);
  if (skippedTextEvents.length > 0) {
    try {
      eventsConsolidated += eventLog.markConsolidated(
        skippedTextEvents.map((e) => e.id),
        "SKIP:lifecycle_event",
      );
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — failed to mark lifecycle events as skipped: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-mark-lifecycle-skip",
        subsystem: "event-log",
      });
    }
  }

  const afterTextSkip = events.filter((event) => !shouldSkipEpisodicConsolidation(event));
  const skippedTypeEvents = afterTextSkip.filter((e) => shouldSkipEpisodicConsolidationByEventType(e, eventTypeFilter));
  if (skippedTypeEvents.length > 0) {
    try {
      eventsConsolidated += eventLog.markConsolidated(
        skippedTypeEvents.map((e) => e.id),
        "SKIP:event_type_filter",
      );
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — failed to mark event-type-filtered events as skipped: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-mark-event-type-skip",
        subsystem: "event-log",
      });
    }
  }

  const consolidatableEvents = afterTextSkip.filter(
    (event) => !shouldSkipEpisodicConsolidationByEventType(event, eventTypeFilter),
  );
  if (consolidatableEvents.length === 0) {
    return { eventsConsolidated, factsCreated: 0 };
  }

  const groups = groupEventsByEntity(consolidatableEvents);
  if (verbose) {
    logger.info(
      `memory-hybrid: dream-cycle — episodic consolidation: ${consolidatableEvents.length} consolidatable event(s) in ${groups.size} entity group(s) (≥${consolidateAfterDays}d); skipped ${skippedTextEvents.length} text-pattern noise + ${skippedTypeEvents.length} eventType-filtered`,
    );
  }
  let factsCreated = 0;
  const totalGroups = groups.size;
  let processedGroups = 0;
  const consolidationStartedAt = Date.now();
  let lastProgressLogAt = consolidationStartedAt;
  const maybeLogConsolidationProgress = (entity: string): void => {
    if (!verbose) return;
    const now = Date.now();
    const shouldLogByCount = processedGroups === 1 || processedGroups % EPISODIC_PROGRESS_GROUP_INTERVAL === 0;
    const shouldLogByTime = now - lastProgressLogAt >= EPISODIC_PROGRESS_HEARTBEAT_MS;
    if (!shouldLogByCount && !shouldLogByTime) return;
    lastProgressLogAt = now;
    const elapsedSec = Math.floor((now - consolidationStartedAt) / 1000);
    const safeEntity = entity === "__default__" ? "unattributed" : entity;
    logger.info(
      `memory-hybrid: dream-cycle — episodic consolidation progress ${processedGroups}/${totalGroups} group(s); eventsConsolidated=${eventsConsolidated}, factsCreated=${factsCreated}, currentEntity="${safeEntity}"; still running after ${elapsedSec}s`,
    );
  };

  for (const [entity, groupEvents] of groups) {
    if (groupEvents.length === 0) continue;
    processedGroups++;
    maybeLogConsolidationProgress(entity);

    if (entity === "__default__" && groupEvents.length > maxEventsPerConsolidation) {
      logger.info(
        `memory-hybrid: dream-cycle — default group has ${groupEvents.length} event(s); consolidating first ${maxEventsPerConsolidation}, skipping ${groupEvents.length - maxEventsPerConsolidation} excess`,
      );
    }

    const cappedGroupEvents = groupEvents.slice(0, maxEventsPerConsolidation);
    const excessEvents = groupEvents.slice(maxEventsPerConsolidation);

    // Collect text from all events in this group
    const eventTexts = cappedGroupEvents.map((e) => extractEventText(e)).filter((t) => t.length >= 3);

    if (eventTexts.length === 0) {
      // Mark events as consolidated with a namespaced skip sentinel to prevent re-processing.
      // 'SKIP:no_text' is clearly not a real fact UUID — no UUID-based query will match it.
      try {
        eventsConsolidated += eventLog.markConsolidated(
          cappedGroupEvents.map((e) => e.id),
          "SKIP:no_text",
        );
      } catch (err) {
        logger.warn(`memory-hybrid: dream-cycle — failed to mark no-text events as consolidated: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dream-cycle-mark-skip",
          subsystem: "event-log",
        });
      }
      continue;
    }

    // Build merged text for the consolidated fact
    const entityLabel = entity !== "__default__" ? entity : null;
    const mergedText = buildConsolidatedFactText(eventTexts, entityLabel);

    const consolidatedAt = Math.floor(Date.now() / 1000);
    const sourceEvents = cappedGroupEvents.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      text: extractEventText(event).slice(0, 300),
    }));

    // Create the consolidated fact. Issue #1195: store dream-cycle provenance on
    // the fact row instead of creating one DERIVED_FROM graph edge per event.
    // Historical DERIVED_FROM rows are left untouched by this forward migration;
    // deleting legacy provenance blindly is riskier than stopping new hub growth.
    let consolidatedFact: MemoryEntry | null = null;
    let factNewlyStored = false;
    let factEmbeddingStale = false;
    try {
      const storeResult = factsDb.storeWithResult({
        text: mergedText.slice(0, CONSOLIDATED_FACT_TEXT_MAX_LENGTH),
        category: "fact" as MemoryCategory,
        importance: 0.5,
        entity: entityLabel,
        key: "consolidated",
        value: null,
        source: "dream-cycle",
        decayClass: CONSOLIDATED_FACT_DECAY_CLASS,
        tags: ["dream-cycle", "consolidated"],
        extractionMethod: "consolidation",
        provenanceJson: JSON.stringify({
          method: "dream-cycle",
          consolidatedAt,
          sourceEventIds: sourceEvents.map((event) => event.id),
          sourceEvents,
        }),
      });
      if (storeResult.skipped) {
        try {
          eventsConsolidated += eventLog.markConsolidated(
            cappedGroupEvents.map((e) => e.id),
            "SKIP:pre_store_guard",
          );
        } catch (err) {
          logger.warn(`memory-hybrid: dream-cycle — failed to mark pre-store-guard skipped events: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "dream-cycle-mark-pre-store-skip",
            subsystem: "event-log",
          });
        }
        continue;
      }
      consolidatedFact = storeResult.entry;
      factNewlyStored = storeResult.newlyStored === true;
      factEmbeddingStale = storeResult.embeddingStale === true;
      if (storeResult.newlyStored || storeResult.embeddingStale) {
        if (vectorDb) {
          await cleanupEvictedVector({
            vectorDb,
            evictedFactId: storeResult.evictedFactId,
            logger,
            context: "dream-cycle",
          });
        }
      }
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — failed to store consolidated fact for entity "${entity}": ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-consolidate",
        subsystem: "facts-db",
      });
      try {
        eventsConsolidated += eventLog.markConsolidated(
          cappedGroupEvents.map((e) => e.id),
          "SKIP:store_failed",
        );
      } catch (markErr) {
        logger.warn(`memory-hybrid: dream-cycle — failed to mark store-failed events as skipped: ${markErr}`);
        capturePluginError(markErr instanceof Error ? markErr : new Error(String(markErr)), {
          operation: "dream-cycle-mark-store-failed-skip",
          subsystem: "event-log",
        });
      }
      continue;
    }

    // Mark all events in the group as consolidated into the new fact
    try {
      eventsConsolidated += eventLog.markConsolidated(
        cappedGroupEvents.map((e) => e.id),
        consolidatedFact.id,
      );
      if (factNewlyStored) {
        factsCreated++;
      }

      if (excessEvents.length > 0) {
        try {
          eventsConsolidated += eventLog.markConsolidated(
            excessEvents.map((e) => e.id),
            entity === "__default__" ? "SKIP:default_group_cap" : "SKIP:entity_group_cap",
          );
          logger.info(
            `memory-hybrid: dream-cycle — skipped ${excessEvents.length} excess event(s) for entity "${entity}": exceeds maxEventsPerConsolidation=${maxEventsPerConsolidation}`,
          );
        } catch (err) {
          logger.warn(`memory-hybrid: dream-cycle — failed to mark excess entity group events as skipped: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "dream-cycle-mark-entity-cap-skip",
            subsystem: "event-log",
          });
        }
      }
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — failed to mark events as consolidated: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-mark-consolidated",
        subsystem: "event-log",
      });
      try {
        if (consolidatedFact && factNewlyStored) factsDb.delete(consolidatedFact.id);
      } catch (cleanupErr) {
        logger.warn(
          `memory-hybrid: dream-cycle — failed to delete consolidated fact after mark failure: ${cleanupErr}`,
        );
      }
      continue;
    }

    logger.info(
      `memory-hybrid: dream-cycle — consolidated ${cappedGroupEvents.length} events${entityLabel ? ` for entity "${entityLabel}"` : ""} → fact ${consolidatedFact.id.slice(0, 8)}`,
    );

    // Embed and store the consolidated fact in LanceDB so it is discoverable by
    // semantic search.  This is non-fatal: the fact is already safely in SQLite.
    // Use the same truncated text for both the embedding call and the store payload
    // so the embedding always matches the text that will be returned by search.
    if (vectorDb && embeddings && (factNewlyStored || factEmbeddingStale)) {
      const persistedText =
        typeof consolidatedFact.text === "string" && consolidatedFact.text.trim().length > 0
          ? consolidatedFact.text.slice(0, 500)
          : mergedText.slice(0, 500);
      try {
        const vector = await embeddings.embed(persistedText);
        await vectorDb.store({
          id: consolidatedFact.id,
          text: persistedText,
          vector,
          importance: consolidatedFact.importance,
          category: consolidatedFact.category,
        });
      } catch (embedErr) {
        logger.warn(
          `memory-hybrid: dream-cycle — failed to embed consolidated fact ${consolidatedFact.id.slice(0, 8)} into LanceDB (non-fatal): ${embedErr}`,
        );
      }
    }
  }

  if (verbose) {
    const elapsedSec = Math.floor((Date.now() - consolidationStartedAt) / 1000);
    logger.info(
      `memory-hybrid: dream-cycle — episodic consolidation complete in ${elapsedSec}s; groups=${processedGroups}/${totalGroups}, eventsConsolidated=${eventsConsolidated}, factsCreated=${factsCreated}`,
    );
  }

  return { eventsConsolidated, factsCreated };
}

// ---------------------------------------------------------------------------
// Main dream cycle orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full nightly dream cycle:
 *  prune → consolidation → reflect → optional reflect-rules → memory index → log prune → FTS5 → optional VACUUM → digest.
 */
export async function runDreamCycle(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  eventLog: EventLog | null,
  config: DreamCycleConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  provenanceService?: ProvenanceService | null,
  bridge?: DreamCycleBridgeOpts,
): Promise<DreamCycleResult> {
  if (!config.enabled) {
    return {
      factsPruned: 0,
      factsDecayed: 0,
      linksPruned: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
      logRowsPruned: 0,
      vacuumRan: false,
      decayReclassified: 0,
      orphanVectorsRemoved: 0,
      digestSummary: "Dream cycle disabled.",
      skipped: true,
      success: true,
      failedStages: [],
      dryRun: config.dryRun === true,
    };
  }

  const dryRun = config.dryRun === true;
  logger.info(
    `memory-hybrid: dream-cycle — starting${dryRun ? " [DRY RUN — preview only, no mutations]" : ""} nightly cycle`,
  );
  const cycleStartedAt = Date.now();
  const v = !!config.verbose;
  const runId = config.runId ?? makeDreamCycleRunId();
  const skipForDryRun = (stageLabel: string): void => {
    logger.info(`memory-hybrid: dream-cycle [dry-run] — skipping ${stageLabel} (no preview support; would mutate)`);
  };
  const failedStages: string[] = [];
  const recordStageFailure = (stage: string, err: unknown): void => {
    if (!failedStages.includes(stage)) failedStages.push(stage);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: `dream-cycle-${stage.replace(/\s+/g, "-")}`,
      subsystem: "dream-cycle",
    });
  };
  if (config.walFlushFailed) {
    failedStages.push("wal pre-flush");
    logger.warn(
      "memory-hybrid: dream-cycle — WAL pre-flush failed; skipping episodic consolidation to avoid stale SQLite state",
    );
  }
  // Ensure stage artifact dir exists when configured.
  if (config.stageArtifactDir) {
    try {
      mkdirSync(config.stageArtifactDir, { recursive: true });
    } catch {
      // Non-fatal: artifact writes below will also fail gracefully.
    }
  }
  const writeStageArtifact = (stageNumber: number, label: string, payload: Record<string, unknown>): void => {
    if (!config.stageArtifactDir) return;
    try {
      const sanitized = label
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, STAGE_LABEL_MAX_LENGTH);
      const filename = `stage-${String(stageNumber).padStart(2, "0")}-${sanitized}.json`;
      const filePath = join(config.stageArtifactDir, filename);
      atomicWriteFile(filePath, JSON.stringify({ runId, stage: label, stageNumber, ...payload }, null, 2));
    } catch {
      // Artifact write failures are non-fatal.
    }
  };
  let stageCounter = 0;
  const beginStage = (
    label: string,
    opts?: { heartbeat?: boolean; progressSupplier?: () => string | undefined },
  ): {
    complete: (summary?: string) => void;
    fail: (err: unknown, summary?: string) => void;
  } => {
    const stageNumber = ++stageCounter;
    const startedAt = Date.now();
    logger.info(`memory-hybrid: dream-cycle — stage ${stageNumber} start: ${label}`);
    writeStageArtifact(stageNumber, label, { status: "started", startedAt: formatTimestampUtcFromMs(startedAt) });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (v && opts?.heartbeat === true) {
      heartbeat = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        const progress = opts?.progressSupplier?.();
        logger.info(
          `memory-hybrid: dream-cycle — stage ${stageNumber} still running after ${elapsedSec}s: ${label}${progress ? `; ${progress}` : ""}`,
        );
      }, DREAM_STAGE_HEARTBEAT_MS);
      heartbeat.unref?.();
    }
    const clearHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
    };
    return {
      complete: (summary?: string) => {
        clearHeartbeat();
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        logger.info(
          `memory-hybrid: dream-cycle — stage ${stageNumber} complete in ${elapsedSec}s: ${label}${summary ? `; ${summary}` : ""}`,
        );
        writeStageArtifact(stageNumber, label, {
          status: "succeeded",
          startedAt: formatTimestampUtcFromMs(startedAt),
          completedAt: nowIso(),
          elapsedSec,
          ...(summary != null ? { summary } : {}),
        });
      },
      fail: (err: unknown, summary?: string) => {
        clearHeartbeat();
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        logger.warn(`memory-hybrid: dream-cycle — stage ${stageNumber} failed after ${elapsedSec}s: ${label}: ${err}`);
        writeStageArtifact(stageNumber, label, {
          status: "failed",
          startedAt: formatTimestampUtcFromMs(startedAt),
          completedAt: nowIso(),
          elapsedSec,
          error: String(err),
          ...(summary != null ? { summary } : {}),
        });
      },
    };
  };
  const beginSubstep = (label: string): { complete: (summary?: string) => void } => {
    const startedAt = Date.now();
    if (v) logger.info(`memory-hybrid: dream-cycle — substep start: ${label}`);
    return {
      complete: (summary?: string) => {
        if (!v) return;
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        logger.info(
          `memory-hybrid: dream-cycle — substep complete in ${elapsedSec}s: ${label}${summary ? `; ${summary}` : ""}`,
        );
      },
    };
  };

  // ── Stage 1: Core pruning / decay / graph-vector maintenance ─────────────
  const stageCore = beginStage("core prune/decay/link/vector maintenance");
  let stageCoreError: unknown;
  let factsPruned = 0;
  let factsDecayed = 0;
  if (config.pruneMode === "expired" || config.pruneMode === "both") {
    if (dryRun) {
      try {
        factsPruned = factsDb.countExpired();
        logger.info(`memory-hybrid: dream-cycle [dry-run] — would prune ${factsPruned} expired fact(s)`);
      } catch (err) {
        stageCoreError ??= err;
        logger.warn(`memory-hybrid: dream-cycle [dry-run] — countExpired failed: ${err}`);
      }
    } else {
      try {
        const expiredPrune = factsDb.pruneExpiredWithDetails();
        factsPruned = expiredPrune.factsPruned;
        const vectorCleanup = await deleteVectorsForFactIds(vectorDb, expiredPrune.deletedFactIds, {
          operation: "dream-cycle-prune-expired",
          logger,
        });
        logger.info(`memory-hybrid: dream-cycle — pruned ${factsPruned} expired facts`);
        if (vectorCleanup.failed > 0) {
          logger.warn(
            `memory-hybrid: dream-cycle — expired vector cleanup partial: deleted ${vectorCleanup.deleted}/${vectorCleanup.attempted}, failed ${vectorCleanup.failed}`,
          );
          stageCoreError ??= new Error(
            `expired vector cleanup partial: deleted ${vectorCleanup.deleted}/${vectorCleanup.attempted}, failed ${vectorCleanup.failed}`,
          );
        }
      } catch (err) {
        stageCoreError ??= err;
        logger.warn(`memory-hybrid: dream-cycle — pruneExpired failed: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dream-cycle-prune-expired",
          subsystem: "facts-db",
        });
      }
    }
  }

  // ── Step 1a-pre: Reclassify decay classes BEFORE taking the decay snapshot ────
  // Running reclassification first ensures that listFactIdsToBeDeletedByDecayRun()
  // reflects up-to-date decay_class values.  Previously, reclassification ran in
  // Step 1c (after the decay snapshot), which caused newly re-tiered facts to be
  // missed by the per-batch vector cleanup, leaving orphaned LanceDB vectors until
  // the full Step 1e reconciliation caught them on a later cycle.
  let decayReclassified = 0;
  if (config.reclassifyDecayOnCycle !== false) {
    const reclassifyStep = beginSubstep("decay reclassify (source/importance/recall)");
    try {
      const report = factsDb.reclassifyDecayClasses({
        apply: !dryRun,
        inactiveDays: config.reclassifyInactiveDays ?? 90,
        promoteRecallCount: config.reclassifyPromoteRecallCount ?? 3,
      });
      decayReclassified = report.changed;
      if (decayReclassified > 0) {
        logger.info(
          `memory-hybrid: dream-cycle ${dryRun ? "[dry-run] — would re-tier" : "— decay reclassify:"} ${decayReclassified} facts re-tiered (scanned ${report.scanned}, stable+permanent ${(report.stablePermanentRatioBefore * 100).toFixed(1)}% → ${(report.stablePermanentRatioAfter * 100).toFixed(1)}%)`,
        );
      }
    } catch (err) {
      stageCoreError ??= err;
      logger.warn(`memory-hybrid: dream-cycle — reclassifyDecayClasses failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-reclassify-decay",
        subsystem: "facts-db",
      });
    }
    reclassifyStep.complete(`changed=${decayReclassified}`);
  }

  if (config.pruneMode === "decay" || config.pruneMode === "both") {
    if (dryRun) {
      try {
        const decayNowSec = Math.floor(Date.now() / 1000);
        factsDecayed = factsDb.listFactIdsToBeDeletedByDecayRun(decayNowSec).length;
        logger.info(`memory-hybrid: dream-cycle [dry-run] — would decay/delete ${factsDecayed} fact(s)`);
      } catch (err) {
        stageCoreError ??= err;
        logger.warn(`memory-hybrid: dream-cycle [dry-run] — listFactIdsToBeDeletedByDecayRun failed: ${err}`);
      }
    } else {
      try {
        const decayNowSec = Math.floor(Date.now() / 1000);
        const decayRun = factsDb.decayConfidenceWithDetails(decayNowSec);
        factsDecayed = decayRun.factsDecayed;
        const vectorCleanup = await deleteVectorsForFactIds(vectorDb, decayRun.deletedFactIds, {
          operation: "dream-cycle-decay",
          logger,
        });
        logger.info(`memory-hybrid: dream-cycle — decayed ${factsDecayed} facts`);
        if (vectorCleanup.failed > 0) {
          logger.warn(
            `memory-hybrid: dream-cycle — decay vector cleanup partial: deleted ${vectorCleanup.deleted}/${vectorCleanup.attempted}, failed ${vectorCleanup.failed}`,
          );
          stageCoreError ??= new Error(
            `decay vector cleanup partial: deleted ${vectorCleanup.deleted}/${vectorCleanup.attempted}, failed ${vectorCleanup.failed}`,
          );
        }
      } catch (err) {
        stageCoreError ??= err;
        logger.warn(`memory-hybrid: dream-cycle — decayConfidence failed: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dream-cycle-decay",
          subsystem: "facts-db",
        });
      }
    }
  }

  // ── Step 1b: Prune orphaned links ────────────────────────────────────────
  let linksPruned = 0;
  if (dryRun) {
    skipForDryRun("prune orphaned links");
  } else {
    try {
      linksPruned = factsDb.pruneOrphanedLinks();
      if (linksPruned > 0) {
        logger.info(`memory-hybrid: dream-cycle — pruned ${linksPruned} orphaned link(s)`);
      }
    } catch (err) {
      stageCoreError ??= err;
      logger.warn(`memory-hybrid: dream-cycle — pruneOrphanedLinks failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-prune-orphaned-links",
        subsystem: "facts-db",
      });
    }
  }

  // ── Step 1d: Refresh denormalized graph degrees (#1192) ──────────────────
  // Without this, every BFS hop runs `COUNT(*) FROM memory_links` against the same node, which
  // is O(edges) per call. A single nightly refresh keeps reads cheap while still adapting to
  // graph changes within a day.
  if (dryRun) {
    if (v) skipForDryRun("refresh fact degrees");
  } else if (typeof (factsDb as { refreshFactDegrees?: () => unknown }).refreshFactDegrees === "function") {
    const refreshDegreesStep = beginSubstep("refresh fact degrees");
    try {
      const result = (factsDb as { refreshFactDegrees: () => { updated: number } }).refreshFactDegrees();
      if (v) {
        logger.info(`memory-hybrid: dream-cycle — refreshed fact degrees for ${result.updated} facts`);
      }
    } catch (err) {
      stageCoreError ??= err;
      logger.warn(`memory-hybrid: dream-cycle — refreshFactDegrees failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-refresh-degrees",
        subsystem: "facts-db",
      });
    }
    refreshDegreesStep.complete();
  }

  // ── Step 1e: Reconcile LanceDB orphaned vectors ──────────────────────────
  // After SQLite pruning (pruneExpired, decayConfidence), any LanceDB vector whose
  // corresponding SQLite fact was hard-deleted is now an orphan.  Orphaned vectors
  // pollute semantic search results with stale or deleted facts.  We reconcile here
  // by deleting vector IDs that no longer have a corresponding SQLite fact.
  let orphanVectorsRemoved = 0;
  if (dryRun) {
    skipForDryRun("reconcile LanceDB orphaned vectors");
  } else {
    const vectorReconcileStep = beginSubstep("reconcile LanceDB orphaned vectors");
    try {
      const reconcile = await reconcileOrphanVectors(factsDb, vectorDb, {
        operation: "dream-cycle-orphan-vector-reconcile",
        logger,
      });
      orphanVectorsRemoved = reconcile.orphanVectorsRemoved;
      if (reconcile.orphansFound > 0 && reconcile.orphanVectorsRemoved > 0) {
        logger.info(
          `memory-hybrid: dream-cycle — removed ${reconcile.orphanVectorsRemoved} orphaned vector(s) from LanceDB`,
        );
      }
      if (reconcile.failed > 0) {
        logger.warn(
          `memory-hybrid: dream-cycle — orphan reconciliation partial: deleted ${reconcile.orphanVectorsRemoved}/${reconcile.orphansFound}, failed ${reconcile.failed}`,
        );
        stageCoreError ??= new Error(
          `orphan reconciliation partial: deleted ${reconcile.orphanVectorsRemoved}/${reconcile.orphansFound}, failed ${reconcile.failed}`,
        );
      }
      if (isVectorBackendAvailable(vectorDb)) {
        const vectorlessAfterReconcile = factsDb.countVectorlessActiveFacts();
        if (vectorlessAfterReconcile > 0) {
          logger.warn(
            `memory-hybrid: dream-cycle — detected ${vectorlessAfterReconcile} active SQLite fact(s) without vectors after reconciliation; run 'hybrid-mem reembed-vectorless --apply' to restore semantic recall coverage`,
          );
        }
      }
    } catch (err) {
      stageCoreError ??= err;
      logger.warn(`memory-hybrid: dream-cycle — vector reconciliation failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-orphan-vector-reconcile",
        subsystem: "vector-db",
      });
    }
    vectorReconcileStep.complete(`removed=${orphanVectorsRemoved}`);
  }
  {
    const summary = `factsPruned=${factsPruned}, factsDecayed=${factsDecayed}, linksPruned=${linksPruned}, decayReclassified=${decayReclassified}, orphanVectorsRemoved=${orphanVectorsRemoved}`;
    if (stageCoreError === undefined) stageCore.complete(summary);
    else stageCore.fail(stageCoreError, summary);
  }
  if (stageCoreError !== undefined) {
    recordStageFailure("core prune/decay/link/vector maintenance", stageCoreError);
  }

  if (dryRun) {
    skipForDryRun("episode causal link decay + undetected contradiction repair");
  } else {
    try {
      const causalDecay = decayEpisodeCausalLinks(factsDb.getRawDb());
      if (v && (causalDecay.updated > 0 || causalDecay.deleted > 0)) {
        logger.info(
          `memory-hybrid: dream-cycle — episode causal link decay: updated=${causalDecay.updated}, deleted=${causalDecay.deleted}`,
        );
      }
      const repair = factsDb.repairUndetectedContradictions(200);
      if (repair.pairsRepaired > 0 || repair.pairsFailed > 0) {
        emitFeatureTelemetry(logger, {
          feature: "contradiction_repair",
          operation: "dream_cycle_repair",
          outcome: repair.pairsFailed > 0 ? "degraded" : "ok",
          fields: {
            groups_scanned: repair.groupsScanned,
            pairs_repaired: repair.pairsRepaired,
            pairs_fallback: repair.pairsFallback,
            pairs_failed: repair.pairsFailed,
          },
        });
      }
      if (repair.pairsRepaired > 0) {
        logger.warn(
          `memory-hybrid: dream-cycle — repaired ${repair.pairsRepaired} undetected contradiction pair(s) across ${repair.groupsScanned} entity+key group(s)${repair.pairsFallback > 0 ? ` (${repair.pairsFallback} via store-time fallback)` : ""}`,
        );
      }
      if (repair.pairsFailed > 0) {
        logger.warn(
          `memory-hybrid: dream-cycle — ${repair.pairsFailed} contradiction pair(s) could not be repaired; will retry next dream cycle`,
        );
        capturePluginError(
          new Error(`contradiction repair partial failure: ${repair.pairsFailed} pair(s) unresolved`),
          {
            subsystem: "maintenance",
            operation: "contradiction-repair-partial",
            phase: "dream-cycle",
            severity: "warning",
            tags: {
              pairs_failed: repair.pairsFailed,
              pairs_fallback: repair.pairsFallback,
              pairs_repaired: repair.pairsRepaired,
            },
          },
        );
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "maintenance",
        operation: "contradiction-repair",
        phase: "dream-cycle",
      });
      logger.warn(`memory-hybrid: dream-cycle — episode causal/dec contradiction maintenance failed: ${err}`);
    }
  }

  // ── Stage 2: Episodic consolidation + event log maintenance ──────────────
  let eventsConsolidated = 0;
  let factsCreated = 0;
  let eventLogPhase = "consolidation";
  let stageEventLogError: unknown;
  const stageEventLog = beginStage("episodic consolidation + event log maintenance", {
    heartbeat: true,
    progressSupplier: () =>
      `phase=${eventLogPhase}; eventsConsolidated=${eventsConsolidated}; factsCreated=${factsCreated}`,
  });
  if (dryRun) {
    skipForDryRun("episodic consolidation + event log archival");
  } else if (eventLog && !config.walFlushFailed) {
    try {
      const consolidationResult = await runEpisodicConsolidation(
        factsDb,
        eventLog,
        config.consolidateAfterDays,
        logger,
        v,
        config.maxEventsPerConsolidation,
        config.episodicConsolidationEventTypes ?? null,
        vectorDb,
        embeddings,
      );
      eventsConsolidated = consolidationResult.eventsConsolidated;
      factsCreated = consolidationResult.factsCreated;
    } catch (err) {
      stageEventLogError ??= err;
      recordStageFailure("episodic consolidation", err);
      logger.warn(`memory-hybrid: dream-cycle — consolidation step failed: ${err}`);
    }
  } else if (eventLog && config.walFlushFailed && v) {
    logger.info("memory-hybrid: dream-cycle — skipping episodic consolidation (WAL pre-flush failed)");
  } else if (v) {
    logger.info("memory-hybrid: dream-cycle — no event log: skipping episodic consolidation");
  }

  // ── Step 2b: Archive stale event log entries ─────────────────────────────
  if (!dryRun && eventLog && config.eventLogArchivalDays > 0) {
    eventLogPhase = "archive-consolidated";
    try {
      const result = await eventLog.archiveConsolidated(config.eventLogArchivalDays, config.eventLogArchivePath);
      if (result.archived > 0) {
        logger.info(
          `memory-hybrid: dream-cycle — archived ${result.archived} consolidated event log entries older than ${config.eventLogArchivalDays} days`,
        );
      }
    } catch (err) {
      stageEventLogError ??= err;
      logger.warn(`memory-hybrid: dream-cycle — archiveConsolidated failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-archive",
        subsystem: "event-log",
      });
    }
  }

  // ── Step 2c: Clean up old unconsolidated events ──────────────────────────
  if (!dryRun && eventLog && config.maxUnconsolidatedAgeDays > 0 && !config.walFlushFailed) {
    eventLogPhase = "archive-old";
    const archiveAgeDays = Math.max(config.maxUnconsolidatedAgeDays, config.consolidateAfterDays);
    if (archiveAgeDays !== config.maxUnconsolidatedAgeDays && v) {
      logger.info(
        `memory-hybrid: dream-cycle — clamping maxUnconsolidatedAgeDays from ${config.maxUnconsolidatedAgeDays} to ${archiveAgeDays} (must be ≥ consolidateAfterDays=${config.consolidateAfterDays})`,
      );
    }
    try {
      const deleted = eventLog.archiveOld(archiveAgeDays, true);
      if (deleted > 0) {
        logger.info(
          `memory-hybrid: dream-cycle — deleted ${deleted} old event log entries (including unconsolidated) older than ${archiveAgeDays} days`,
        );
      }
    } catch (err) {
      stageEventLogError ??= err;
      logger.warn(`memory-hybrid: dream-cycle — archiveOld failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-archive-old",
        subsystem: "event-log",
      });
    }
  } else if (!dryRun && eventLog && config.walFlushFailed && config.maxUnconsolidatedAgeDays > 0 && v) {
    logger.info(
      "memory-hybrid: dream-cycle — skipping archiveOld for unconsolidated events (WAL pre-flush failed; would risk deleting unprocessed episodic data)",
    );
  }
  {
    const summary = `eventsConsolidated=${eventsConsolidated}, factsCreated=${factsCreated}`;
    if (stageEventLogError === undefined) stageEventLog.complete(summary);
    else stageEventLog.fail(stageEventLogError, summary);
  }
  if (stageEventLogError !== undefined) {
    recordStageFailure("episodic consolidation + event log maintenance", stageEventLogError);
  }

  // ── Stage 3: Reflection (patterns) ────────────────────────────────────────
  const patternIdsBeforeReflection = new Set(
    factsDb
      .getAll()
      .filter((f) => f.category === "pattern" && !f.supersededAt)
      .map((f) => f.id),
  );
  let patternsFound = 0;
  let stageReflectionError: unknown;
  const stageReflection = beginStage("reflection (patterns)", {
    heartbeat: true,
    progressSupplier: () => `phase=extract-patterns; patternsStored=${patternsFound}`,
  });
  const reflectionConfig: ReflectionConfig = {
    enabled: true,
    defaultWindow: config.reflectWindowDays,
    minObservations: 2,
  };
  try {
    const reflectionResult = await runReflection(
      factsDb,
      vectorDb,
      embeddings,
      openai,
      reflectionConfig,
      {
        window: config.reflectWindowDays,
        dryRun,
        model: config.model,
        fallbackModels: config.fallbackModels ?? [],
        verbose: v,
      },
      logger,
      provenanceService,
    );
    patternsFound = reflectionResult.patternsStored;
    logger.info(`memory-hybrid: dream-cycle — reflection complete: ${patternsFound} patterns stored`);
  } catch (err) {
    stageReflectionError ??= err;
    recordStageFailure("reflection (patterns)", err);
    logger.warn(`memory-hybrid: dream-cycle — reflection step failed: ${err}`);
  }
  {
    const summary = `patternsStored=${patternsFound}`;
    if (stageReflectionError === undefined) stageReflection.complete(summary);
    else stageReflection.fail(stageReflectionError, summary);
  }
  if (stageReflectionError !== undefined) {
    recordStageFailure("reflection (patterns)", stageReflectionError);
  }

  const livePatternCountForRules = countActivePatternFactsForMaintenance(factsDb);
  const patternGateForRules = Math.max(patternsFound, livePatternCountForRules);

  // ── Stage 4: Reflect-rules (optional) ─────────────────────────────────────
  const ruleIdsBeforeReflectRules = new Set(
    factsDb
      .getAll()
      .filter((f) => f.category === "rule" && !f.supersededAt)
      .map((f) => f.id),
  );
  let rulesGenerated = 0;
  let reflectionRulesDiagnostics: DreamCycleResult["reflectionRulesDiagnostics"];
  const enableReflectionRules = config.enableReflectionRules !== false; // default: true
  if (enableReflectionRules && patternGateForRules >= MIN_PATTERNS_FOR_RULES) {
    let stageReflectRulesError: unknown;
    const stageReflectRules = beginStage("reflect-rules", {
      heartbeat: true,
      progressSupplier: () => `phase=extract-rules; rulesStored=${rulesGenerated}`,
    });
    try {
      const rulesResult = await runReflectionRules(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        { dryRun, model: config.model, fallbackModels: config.fallbackModels ?? [], verbose: v },
        logger,
        provenanceService,
      );
      rulesGenerated = rulesResult.rulesStored;
      reflectionRulesDiagnostics = rulesResult.diagnostics;
      logger.info(
        `memory-hybrid: dream-cycle — reflect-rules complete: ${rulesGenerated} rules stored (status=${rulesResult.diagnostics.status}${rulesResult.diagnostics.zeroRulesReason ? `, zero_rules_reason=${rulesResult.diagnostics.zeroRulesReason}` : ""})`,
      );
      if (rulesResult.diagnostics.status === "degraded") {
        stageReflectRulesError = new Error(rulesResult.diagnostics.zeroRulesReason ?? "reflect_rules_degraded");
        recordStageFailure("reflect-rules", stageReflectRulesError);
      }
    } catch (err) {
      stageReflectRulesError ??= err;
      recordStageFailure("reflect-rules", err);
      logger.warn(`memory-hybrid: dream-cycle — reflect-rules step failed: ${err}`);
      reflectionRulesDiagnostics = {
        modelResponseChars: 0,
        parseSuccess: false,
        parsedCandidates: 0,
        rejectedDuplicates: 0,
        rejectedLowConfidence: 0,
        stored: 0,
        zeroRulesReason: "reflect_rules_threw",
        status: "degraded",
      };
    }
    {
      const summary = `rulesStored=${rulesGenerated}`;
      if (stageReflectRulesError === undefined) stageReflectRules.complete(summary);
      else stageReflectRules.fail(stageReflectRulesError, summary);
    }
  } else if (!enableReflectionRules) {
    reflectionRulesDiagnostics = {
      modelResponseChars: 0,
      parseSuccess: false,
      parsedCandidates: 0,
      rejectedDuplicates: 0,
      rejectedLowConfidence: 0,
      stored: 0,
      zeroRulesReason: "stage_disabled",
      status: "ok",
    };
    if (v) {
      logger.info("memory-hybrid: dream-cycle — reflection rules disabled (nightlyCycle.enableReflectionRules=false)");
    }
  } else {
    reflectionRulesDiagnostics = {
      modelResponseChars: 0,
      parseSuccess: false,
      parsedCandidates: 0,
      rejectedDuplicates: 0,
      rejectedLowConfidence: 0,
      stored: 0,
      zeroRulesReason: "stage_skipped_pattern_gate",
      status: "ok",
    };
    if (v) {
      logger.info(
        `memory-hybrid: dream-cycle — skipping reflect-rules (${patternsFound} stored this cycle, ${livePatternCountForRules} live patterns; need ≥${MIN_PATTERNS_FOR_RULES})`,
      );
    }
  }

  let bridgePersonaCreated = 0;
  let bridgeCrystallizationCreated = 0;
  let bridgeSkillBridged = 0;

  if (dryRun && bridge?.cfg?.nightlyCycle?.autoPropose === true) {
    skipForDryRun("auto-propose bridge (persona/crystallization/skill-workshop)");
  } else if (bridge?.cfg?.nightlyCycle?.autoPropose === true) {
    try {
      const newPatternFactIds = factsDb
        .getAll()
        .filter((f) => f.category === "pattern" && !f.supersededAt && !patternIdsBeforeReflection.has(f.id))
        .map((f) => f.id);
      const newRuleFactIds = factsDb
        .getAll()
        .filter((f) => f.category === "rule" && !f.supersededAt && !ruleIdsBeforeReflectRules.has(f.id))
        .map((f) => f.id);
      const bridgeResult = runDreamCycleProposalBridge({
        cfg: bridge.cfg,
        factsDb,
        proposalsDb: bridge.proposalsDb ?? null,
        crystallizationStore: bridge.crystallizationStore ?? null,
        toolProposalStore: bridge.toolProposalStore ?? null,
        patternsStored: patternsFound,
        rulesGenerated,
        newRuleFactIds,
        newPatternFactIds,
        logger,
        api: bridge.api,
        changeFeed: bridge.changeFeed,
      });
      bridgePersonaCreated = bridgeResult.personaProposalsCreated;
      bridgeCrystallizationCreated = bridgeResult.crystallizationProposalsCreated;
      bridgeSkillBridged = bridgeResult.skillWorkshopBridged;
      if (bridgePersonaCreated > 0 || bridgeCrystallizationCreated > 0 || bridgeSkillBridged > 0) {
        logger.info(
          `memory-hybrid: dream-cycle auto-propose — persona=${bridgePersonaCreated} crystallization=${bridgeCrystallizationCreated} skillWorkshop=${bridgeSkillBridged}`,
        );
      }
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle auto-propose bridge failed (non-fatal): ${err}`);
    }
  }

  // ── Stage 5: Refresh memory awareness index ───────────────────────────────
  if (dryRun) {
    skipForDryRun("MEMORY_INDEX.md refresh");
  } else {
    let stageMemoryIndexError: unknown;
    const stageMemoryIndex = beginStage("MEMORY_INDEX.md refresh", {
      heartbeat: true,
      progressSupplier: () => "phase=refresh-index",
    });
    try {
      await writeMemoryIndex(
        factsDb,
        openai,
        {
          model: config.model,
          fallbackModels: config.fallbackModels ?? [],
          recentWindowDays: config.reflectWindowDays,
          verbose: v,
        },
        logger,
      );
    } catch (err) {
      stageMemoryIndexError ??= err;
      recordStageFailure("MEMORY_INDEX.md refresh", err);
      logger.warn(`memory-hybrid: dream-cycle — memory index update failed: ${err}`);
    }
    if (stageMemoryIndexError === undefined) stageMemoryIndex.complete();
    else stageMemoryIndex.fail(stageMemoryIndexError);
  }

  // ── Stage 6: Operational table/index cleanup ──────────────────────────────
  let logRowsPruned = 0;
  let vacuumRan = false;
  let walCheckpointRan = false;
  if (dryRun) {
    skipForDryRun("prune operational logs + FTS optimize + vacuum");
  } else {
    let stageOperationalError: unknown;
    const stageOperational = beginStage("prune operational logs + FTS optimize + optional vacuum", {
      heartbeat: true,
      progressSupplier: () =>
        `phase=cleanup; logRowsPruned=${logRowsPruned}; vacuumRan=${vacuumRan ? "yes" : "no"}; walCheckpointRan=${walCheckpointRan ? "yes" : "no"}`,
    });
    if (config.logRetentionDays > 0) {
      try {
        logRowsPruned = factsDb.pruneLogTables(config.logRetentionDays);
        if (logRowsPruned > 0) {
          logger.info(
            `memory-hybrid: dream-cycle — pruned ${logRowsPruned} log rows older than ${config.logRetentionDays} days`,
          );
        }
      } catch (err) {
        stageOperationalError ??= err;
        logger.warn(`memory-hybrid: dream-cycle — pruneLogTables failed: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dream-cycle-prune-log-tables",
          subsystem: "facts-db",
        });
      }
    }

    // ── Stage 6b: FTS5 optimize ───────────────────────────────────────────────
    const optimizeFtsStep = beginSubstep("FTS5 optimize (facts search)");
    try {
      factsDb.optimizeFts();
      logger.info("memory-hybrid: dream-cycle — FTS5 index optimized");
    } catch (err) {
      stageOperationalError ??= err;
      logger.warn(`memory-hybrid: dream-cycle — optimizeFts failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-optimize-fts",
        subsystem: "facts-db",
      });
    }
    optimizeFtsStep.complete();

    // ── Step 5c: VACUUM + WAL checkpoint ────────────────────────────────────
    if (config.vacuumOnCycle) {
      const vacuumStep = beginSubstep("VACUUM + WAL checkpoint");
      try {
        // Cost optimization: Skip VACUUM when freed space < 10MB (low benefit, high I/O cost)
        const { freedMB } = factsDb.freelistSpaceStats();

        if (freedMB < 10) {
          // Preserve historical "checkpoint every cycle" behavior even when VACUUM is deferred.
          factsDb.checkpointWalTruncate();
          walCheckpointRan = true;
          logger.info(
            `memory-hybrid: dream-cycle — skipping VACUUM (only ${freedMB.toFixed(2)}MB freed space, threshold: 10MB); WAL checkpoint complete`,
          );
        } else {
          factsDb.vacuumAndCheckpoint();
          vacuumRan = true;
          walCheckpointRan = true;
          logger.info(
            `memory-hybrid: dream-cycle — VACUUM + WAL checkpoint complete (reclaimed ${freedMB.toFixed(2)}MB)`,
          );
        }
      } catch (err) {
        stageOperationalError ??= err;
        logger.warn(`memory-hybrid: dream-cycle — vacuumAndCheckpoint failed: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dream-cycle-vacuum",
          subsystem: "facts-db",
        });
      }
      vacuumStep.complete(`vacuumRan=${vacuumRan ? "yes" : "no"}, walCheckpointRan=${walCheckpointRan ? "yes" : "no"}`);
    }
    {
      const summary = `logRowsPruned=${logRowsPruned}, vacuumRan=${vacuumRan ? "yes" : "no"}, walCheckpointRan=${walCheckpointRan ? "yes" : "no"}`;
      if (stageOperationalError === undefined) stageOperational.complete(summary);
      else stageOperational.fail(stageOperationalError, summary);
    }
    if (stageOperationalError !== undefined) {
      recordStageFailure("prune operational logs + FTS optimize + optional vacuum", stageOperationalError);
    }
  }

  // ── Step 6: Digest summary ───────────────────────────────────────────────
  const digestSummary = `${dryRun ? "[DRY RUN — preview only] " : ""}${buildDigestSummary({
    factsPruned,
    factsDecayed,
    linksPruned,
    eventsConsolidated,
    factsCreated,
    patternsFound,
    rulesGenerated,
    logRowsPruned,
    vacuumRan,
    decayReclassified,
    orphanVectorsRemoved,
    failedStages,
  })}`;

  const success = failedStages.length === 0;
  const totalElapsedSec = Math.floor((Date.now() - cycleStartedAt) / 1000);
  if (success) {
    logger.info(`memory-hybrid: dream-cycle — complete in ${totalElapsedSec}s. ${digestSummary}`);
  } else {
    logger.warn(
      `memory-hybrid: dream-cycle — finished with ${failedStages.length} failed stage(s) in ${totalElapsedSec}s. ${digestSummary}`,
    );
  }

  if (dryRun && bridge?.changeFeed && bridge?.cfg) {
    skipForDryRun("change-feed prune + workshop sync + dream-cycle-complete event");
  } else if (bridge?.changeFeed && bridge?.cfg) {
    if (bridge.cfg.liveChangeFeed?.enabled !== false) {
      try {
        const pruned = bridge.changeFeed.pruneOlderThan(bridge.cfg.liveChangeFeed?.retentionDays ?? 90);
        if (pruned > 0) {
          logger.info(`memory-hybrid: dream-cycle — pruned ${pruned} old change-feed event(s)`);
        }
      } catch (err) {
        logger.warn(`memory-hybrid: dream-cycle — change-feed prune failed (non-fatal): ${err}`);
      }
      try {
        if (isWorkshopEnabled(bridge.cfg)) {
          const synced = syncWorkshopProposedEvents(
            withWorkshopDefaults({
              cfg: bridge.cfg,
              factsDb,
              proposalsDb: bridge.proposalsDb ?? null,
              crystallizationStore: bridge.crystallizationStore ?? null,
              toolProposalStore: bridge.toolProposalStore ?? null,
              workflowStore: bridge.workflowStore ?? null,
              resolvedSqlitePath: bridge.resolvedSqlitePath ?? "",
              changeFeed: bridge.changeFeed,
            }),
          );
          if (synced > 0) {
            logger.info(`memory-hybrid: dream-cycle — synced ${synced} workshop proposed change event(s)`);
          }
        }
      } catch (err) {
        logger.warn(`memory-hybrid: dream-cycle — workshop change-feed sync failed (non-fatal): ${err}`);
      }
    }
    emitDreamCycleComplete(bridge.changeFeed, bridge.cfg, {
      success,
      digestSummary,
      personaProposalsCreated: bridgePersonaCreated,
      crystallizationProposalsCreated: bridgeCrystallizationCreated,
      skillWorkshopBridged: bridgeSkillBridged,
    });
  }

  // Optional: Ingest dream cycle findings into facts for wiki surface
  let dreamFindingsIngested = 0;
  let dreamIngestSuccess = true;
  if (dryRun && config.ingestDreamFindings && config.stageArtifactDir && success) {
    skipForDryRun("dream findings ingest");
  } else if (config.ingestDreamFindings && config.stageArtifactDir && success) {
    try {
      const { ingestDreamFindings } = await import("./wiki-dream-ingester.js");
      const ingesterResult = await ingestDreamFindings({
        factsDb,
        dreamCycleLogDir: config.stageArtifactDir.replace(/\/[^/]+$/, ""),
        verbose: !!config.verbose,
      });
      dreamFindingsIngested = ingesterResult.findingsIngested;
      if (ingesterResult.errors.length > 0) {
        dreamIngestSuccess = false;
        logger.warn(
          `memory-hybrid: dream-cycle — dream findings ingest errors: ${ingesterResult.errors.slice(0, 3).join("; ")}`,
        );
      } else if (ingesterResult.findingsIngested > 0) {
        logger.info(
          `memory-hybrid: dream-cycle — ingested ${ingesterResult.findingsIngested} finding(s) from ${ingesterResult.runsProcessed} run(s)`,
        );
      }
    } catch (err) {
      dreamIngestSuccess = false;
      logger.warn?.(`memory-hybrid: dream-cycle — dream findings ingest failed: ${err}`);
    }
  }

  const finalSuccess = success && dreamIngestSuccess;
  const finalFailedStages =
    dreamIngestSuccess || !config.ingestDreamFindings ? failedStages : [...failedStages, "dream-findings-ingest"];

  return {
    factsPruned,
    factsDecayed,
    linksPruned,
    eventsConsolidated,
    factsCreated,
    patternsFound,
    rulesGenerated,
    reflectionRulesDiagnostics,
    logRowsPruned,
    vacuumRan,
    decayReclassified,
    orphanVectorsRemoved,
    digestSummary,
    dreamFindingsIngested,
    skipped: false,
    success: finalSuccess,
    failedStages: finalFailedStages,
    dryRun,
  };
}
