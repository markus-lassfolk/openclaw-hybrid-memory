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

import type OpenAI from "openai";
import type { EventLog, EventLogEntry } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryCategory } from "../types/memory.js";
import { CONSOLIDATED_FACT_DECAY_CLASS } from "../utils/consolidation-controls.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import { writeMemoryIndex } from "./memory-index.js";
import type { ProvenanceService } from "./provenance.js";
import {
  type ReflectionConfig,
  countActivePatternFactsForMaintenance,
  runReflection,
  runReflectionRules,
} from "./reflection.js";

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
  /** When true, log episodic consolidation / reflection / memory-index detail (CLI `--verbose`). */
  verbose?: boolean;
}

/** Result returned by a single dream cycle run. */
export interface DreamCycleResult {
  /** Facts removed by pruneExpired(). */
  factsPruned: number;
  /** Facts whose confidence was decayed. */
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
  /** Log table rows deleted by pruneLogTables() (Issue #573). */
  logRowsPruned: number;
  /** True when VACUUM + checkpoint was executed (Issue #573). */
  vacuumRan: boolean;
  /** Human-readable summary of the cycle. */
  digestSummary: string;
  /** True when the cycle was skipped because nightlyCycle.enabled = false. */
  skipped: boolean;
}

// Minimum patterns stored in one cycle before we also run reflect-rules.
const MIN_PATTERNS_FOR_RULES = 3;
export const DEFAULT_MAX_EVENTS_PER_CONSOLIDATION = 200;
const SKIP_CONSOLIDATION_TEXT_PATTERNS = new Set([
  "heartbeat",
  "session_end",
  "session_start",
  "transport_connect",
  "transport_disconnect",
]);

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
}): string {
  const parts: string[] = [];
  if (counts.factsPruned > 0) parts.push(`${counts.factsPruned} facts pruned`);
  if (counts.factsDecayed > 0) parts.push(`${counts.factsDecayed} facts decayed`);
  if (counts.linksPruned && counts.linksPruned > 0) parts.push(`${counts.linksPruned} orphaned links removed`);
  if (counts.eventsConsolidated > 0) {
    parts.push(`${counts.eventsConsolidated} events consolidated into ${counts.factsCreated} facts`);
  }
  if (counts.patternsFound > 0) parts.push(`${counts.patternsFound} patterns extracted`);
  if (counts.rulesGenerated > 0) parts.push(`${counts.rulesGenerated} rules generated`);
  if (counts.logRowsPruned && counts.logRowsPruned > 0) parts.push(`${counts.logRowsPruned} log rows pruned`);
  if (counts.vacuumRan) parts.push("VACUUM ran");
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
): Promise<{ eventsConsolidated: number; factsCreated: number }> {
  const events = eventLog.getUnconsolidated(consolidateAfterDays);
  if (events.length === 0) {
    return { eventsConsolidated: 0, factsCreated: 0 };
  }

  let eventsConsolidated = 0;
  const skippedEvents = events.filter(shouldSkipEpisodicConsolidation);
  if (skippedEvents.length > 0) {
    try {
      eventLog.markConsolidated(
        skippedEvents.map((e) => e.id),
        "SKIP:lifecycle_event",
      );
      eventsConsolidated += skippedEvents.length;
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — failed to mark lifecycle events as skipped: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-mark-lifecycle-skip",
        subsystem: "event-log",
      });
    }
  }

  const consolidatableEvents = events.filter((event) => !shouldSkipEpisodicConsolidation(event));
  if (consolidatableEvents.length === 0) {
    return { eventsConsolidated, factsCreated: 0 };
  }

  const groups = groupEventsByEntity(consolidatableEvents);
  if (verbose) {
    logger.info(
      `memory-hybrid: dream-cycle — episodic consolidation: ${consolidatableEvents.length} consolidatable event(s) in ${groups.size} entity group(s) (≥${consolidateAfterDays}d); skipped ${skippedEvents.length} lifecycle/noise event(s)`,
    );
  }
  let factsCreated = 0;

  for (const [entity, groupEvents] of groups) {
    if (groupEvents.length === 0) continue;

    if (entity === "__default__" && groupEvents.length > maxEventsPerConsolidation) {
      try {
        eventLog.markConsolidated(
          groupEvents.map((e) => e.id),
          "SKIP:default_group_cap",
        );
        eventsConsolidated += groupEvents.length;
        logger.info(
          `memory-hybrid: dream-cycle — skipped ${groupEvents.length} unattributed event(s): default group exceeds maxEventsPerConsolidation=${maxEventsPerConsolidation}`,
        );
      } catch (err) {
        logger.warn(`memory-hybrid: dream-cycle — failed to mark capped default group as skipped: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dream-cycle-mark-default-cap-skip",
          subsystem: "event-log",
        });
      }
      continue;
    }

    const cappedGroupEvents = groupEvents.slice(0, maxEventsPerConsolidation);
    const excessEvents = groupEvents.slice(maxEventsPerConsolidation);

    // Collect text from all events in this group
    const eventTexts = cappedGroupEvents.map((e) => extractEventText(e)).filter((t) => t.length >= 3);

    if (eventTexts.length === 0) {
      // Mark events as consolidated with a namespaced skip sentinel to prevent re-processing.
      // 'SKIP:no_text' is clearly not a real fact UUID — no UUID-based query will match it.
      try {
        eventLog.markConsolidated(
          cappedGroupEvents.map((e) => e.id),
          "SKIP:no_text",
        );
        eventsConsolidated += cappedGroupEvents.length;
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
    const mergedText =
      eventTexts.length === 1
        ? eventTexts[0]
        : `[consolidated from ${eventTexts.length} events${entityLabel ? ` about ${entityLabel}` : ""}] ${eventTexts.slice(0, 5).join("; ")}`;

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
    let consolidatedFact;
    try {
      consolidatedFact = factsDb.store({
        text: mergedText.slice(0, 500),
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
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — failed to store consolidated fact for entity "${entity}": ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-consolidate",
        subsystem: "facts-db",
      });
      continue;
    }

    // Mark all events in the group as consolidated into the new fact
    try {
      eventLog.markConsolidated(
        cappedGroupEvents.map((e) => e.id),
        consolidatedFact.id,
      );
      factsCreated++;
      eventsConsolidated += cappedGroupEvents.length;

      if (excessEvents.length > 0) {
        try {
          eventLog.markConsolidated(
            excessEvents.map((e) => e.id),
            "SKIP:entity_group_cap",
          );
          eventsConsolidated += excessEvents.length;
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
        factsDb.delete(consolidatedFact.id);
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
      digestSummary: "Dream cycle disabled.",
      skipped: true,
    };
  }

  logger.info("memory-hybrid: dream-cycle — starting nightly cycle");
  const v = !!config.verbose;
  let stepCounter = 0;
  const step = (label: string) => {
    if (v) logger.info(`memory-hybrid: dream-cycle — step ${++stepCounter}: ${label}`);
  };

  // ── Step 1: Prune ────────────────────────────────────────────────────────
  step("prune / decay / orphaned links");
  let factsPruned = 0;
  let factsDecayed = 0;
  if (config.pruneMode === "expired" || config.pruneMode === "both") {
    try {
      factsPruned = factsDb.pruneExpired();
      logger.info(`memory-hybrid: dream-cycle — pruned ${factsPruned} expired facts`);
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — pruneExpired failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-prune-expired",
        subsystem: "facts-db",
      });
    }
  }
  if (config.pruneMode === "decay" || config.pruneMode === "both") {
    try {
      factsDecayed = factsDb.decayConfidence();
      logger.info(`memory-hybrid: dream-cycle — decayed ${factsDecayed} facts`);
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — decayConfidence failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-decay",
        subsystem: "facts-db",
      });
    }
  }

  // ── Step 1b: Prune orphaned links ────────────────────────────────────────
  let linksPruned = 0;
  try {
    linksPruned = factsDb.pruneOrphanedLinks();
    if (linksPruned > 0) {
      logger.info(`memory-hybrid: dream-cycle — pruned ${linksPruned} orphaned link(s)`);
    }
  } catch (err) {
    logger.warn(`memory-hybrid: dream-cycle — pruneOrphanedLinks failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "dream-cycle-prune-orphaned-links",
      subsystem: "facts-db",
    });
  }

  // ── Step 2: Episodic consolidation ───────────────────────────────────────
  let eventsConsolidated = 0;
  let factsCreated = 0;
  step("episodic consolidation + event log maintenance");
  if (eventLog) {
    try {
      const consolidationResult = await runEpisodicConsolidation(
        factsDb,
        eventLog,
        config.consolidateAfterDays,
        logger,
        v,
        config.maxEventsPerConsolidation,
      );
      eventsConsolidated = consolidationResult.eventsConsolidated;
      factsCreated = consolidationResult.factsCreated;
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — consolidation step failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-consolidation",
        subsystem: "event-log",
      });
    }
  } else if (v) {
    logger.info("memory-hybrid: dream-cycle — no event log: skipping episodic consolidation");
  }

  // ── Step 2b: Archive stale event log entries ─────────────────────────────
  if (eventLog && config.eventLogArchivalDays > 0) {
    try {
      const result = await eventLog.archiveConsolidated(config.eventLogArchivalDays, config.eventLogArchivePath);
      if (result.archived > 0) {
        logger.info(
          `memory-hybrid: dream-cycle — archived ${result.archived} consolidated event log entries older than ${config.eventLogArchivalDays} days`,
        );
      }
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — archiveConsolidated failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-archive",
        subsystem: "event-log",
      });
    }
  }

  // ── Step 2c: Clean up old unconsolidated events ──────────────────────────
  if (eventLog && config.maxUnconsolidatedAgeDays > 0) {
    try {
      const deleted = eventLog.archiveOld(config.maxUnconsolidatedAgeDays, true);
      if (deleted > 0) {
        logger.info(
          `memory-hybrid: dream-cycle — deleted ${deleted} old event log entries (including unconsolidated) older than ${config.maxUnconsolidatedAgeDays} days`,
        );
      }
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — archiveOld failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-archive-old",
        subsystem: "event-log",
      });
    }
  }

  // ── Step 3: Reflect ───────────────────────────────────────────────────────
  step("reflection (patterns)");
  let patternsFound = 0;
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
        dryRun: false,
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
    logger.warn(`memory-hybrid: dream-cycle — reflection step failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "dream-cycle-reflect",
      subsystem: "reflection",
    });
  }

  const livePatternCountForRules = countActivePatternFactsForMaintenance(factsDb);
  const patternGateForRules = Math.max(patternsFound, livePatternCountForRules);

  // ── Step 4: Reflect-rules (optional) ────────────────────────────────────
  let rulesGenerated = 0;
  if (patternGateForRules >= MIN_PATTERNS_FOR_RULES) {
    step("reflect-rules");
    try {
      const rulesResult = await runReflectionRules(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        { dryRun: false, model: config.model, fallbackModels: config.fallbackModels ?? [], verbose: v },
        logger,
        provenanceService,
      );
      rulesGenerated = rulesResult.rulesStored;
      logger.info(`memory-hybrid: dream-cycle — reflect-rules complete: ${rulesGenerated} rules stored`);
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — reflect-rules step failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-reflect-rules",
        subsystem: "reflection",
      });
    }
  } else if (v) {
    logger.info(
      `memory-hybrid: dream-cycle — skipping reflect-rules (${patternsFound} stored this cycle, ${livePatternCountForRules} live patterns; need ≥${MIN_PATTERNS_FOR_RULES})`,
    );
  }

  // ── Step 4b: Refresh memory awareness index ─────────────────────────────
  step("MEMORY_INDEX.md refresh");
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
    logger.warn(`memory-hybrid: dream-cycle — memory index update failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "dream-cycle-memory-index",
      subsystem: "reflection",
    });
  }

  // ── Step 5: Prune log tables ─────────────────────────────────────────────
  step("prune operational log tables (recall/reinforcement/trajectories)");
  let logRowsPruned = 0;
  if (config.logRetentionDays > 0) {
    try {
      logRowsPruned = factsDb.pruneLogTables(config.logRetentionDays);
      if (logRowsPruned > 0) {
        logger.info(
          `memory-hybrid: dream-cycle — pruned ${logRowsPruned} log rows older than ${config.logRetentionDays} days`,
        );
      }
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — pruneLogTables failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-prune-log-tables",
        subsystem: "facts-db",
      });
    }
  }

  // ── Step 5b: FTS5 optimize ───────────────────────────────────────────────
  step("FTS5 optimize (facts search)");
  try {
    factsDb.optimizeFts();
    logger.info("memory-hybrid: dream-cycle — FTS5 index optimized");
  } catch (err) {
    logger.warn(`memory-hybrid: dream-cycle — optimizeFts failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "dream-cycle-optimize-fts",
      subsystem: "facts-db",
    });
  }

  // ── Step 5c: VACUUM + WAL checkpoint ────────────────────────────────────
  let vacuumRan = false;
  if (config.vacuumOnCycle) {
    step("VACUUM + WAL checkpoint");
    try {
      factsDb.vacuumAndCheckpoint();
      vacuumRan = true;
      logger.info("memory-hybrid: dream-cycle — VACUUM + WAL checkpoint complete");
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — vacuumAndCheckpoint failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-vacuum",
        subsystem: "facts-db",
      });
    }
  }

  // ── Step 6: Digest summary ───────────────────────────────────────────────
  const digestSummary = buildDigestSummary({
    factsPruned,
    factsDecayed,
    linksPruned,
    eventsConsolidated,
    factsCreated,
    patternsFound,
    rulesGenerated,
    logRowsPruned,
    vacuumRan,
  });

  logger.info(`memory-hybrid: dream-cycle — complete. ${digestSummary}`);

  return {
    factsPruned,
    factsDecayed,
    linksPruned,
    eventsConsolidated,
    factsCreated,
    patternsFound,
    rulesGenerated,
    logRowsPruned,
    vacuumRan,
    digestSummary,
    skipped: false,
  };
}
