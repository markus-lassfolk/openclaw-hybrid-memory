/**
 * Dream Cycle Service — Automated nightly reflection + pruning pipeline (Issue #143).
 *
 * Sequence:
 *  1. memory_prune (decay confidence + remove expired facts)
 *  2. Episodic consolidation (merge old event log entries into consolidated facts, DERIVED_FROM links)
 *  3. memory_reflect (synthesize patterns from recent facts)
 *  4. memory_reflect_rules (optional, if enough new patterns accumulated)
 *  5. Generate daily digest summary
 *
 * Designed to be cheap ($0.003/night target) using a Flash-tier model.
 * Self-contained — does not require an active agent session.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type OpenAI from "openai";
import type { EventLog, EventLogEntry } from "../backends/event-log.js";
import type { MemoryCategory } from "../types/memory.js";
import {
  runReflection,
  runReflectionRules,
  type ReflectionConfig,
} from "./reflection.js";
import { capturePluginError } from "./error-reporter.js";

/** Prune modes for the dream cycle. */
export type DreamCyclePruneMode = "expired" | "decay" | "both";

/** Configuration for the nightly dream cycle. */
export interface DreamCycleConfig {
  enabled: boolean;
  schedule: string;
  reflectWindowDays: number;
  pruneMode: DreamCyclePruneMode;
  model: string;
  consolidateAfterDays: number;
  /** Fallback models for reflection steps — provides LLM resilience on unattended nightly runs. */
  fallbackModels?: string[];
}

/** Result returned by a single dream cycle run. */
export interface DreamCycleResult {
  /** Facts removed by pruneExpired(). */
  factsPruned: number;
  /** Facts whose confidence was decayed. */
  factsDecayed: number;
  /** Episodic event log entries successfully consolidated. */
  eventsConsolidated: number;
  /** New consolidated facts created from episodic events. */
  factsCreated: number;
  /** New patterns stored by runReflection(). */
  patternsFound: number;
  /** New rules stored by runReflectionRules(). */
  rulesGenerated: number;
  /** Human-readable summary of the cycle. */
  digestSummary: string;
  /** True when the cycle was skipped because nightlyCycle.enabled = false. */
  skipped: boolean;
}

// Minimum patterns stored in one cycle before we also run reflect-rules.
const MIN_PATTERNS_FOR_RULES = 3;

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
    groups.get(primaryEntity)!.push(event);
  }
  return groups;
}

/**
 * Build the digest summary string from cycle counts.
 * Exported so it can be tested independently.
 */
export function buildDigestSummary(counts: {
  factsPruned: number;
  factsDecayed: number;
  eventsConsolidated: number;
  factsCreated: number;
  patternsFound: number;
  rulesGenerated: number;
}): string {
  const parts: string[] = [];
  if (counts.factsPruned > 0) parts.push(`${counts.factsPruned} facts pruned`);
  if (counts.factsDecayed > 0) parts.push(`${counts.factsDecayed} facts decayed`);
  if (counts.eventsConsolidated > 0) {
    parts.push(`${counts.eventsConsolidated} events consolidated into ${counts.factsCreated} facts`);
  }
  if (counts.patternsFound > 0) parts.push(`${counts.patternsFound} patterns extracted`);
  if (counts.rulesGenerated > 0) parts.push(`${counts.rulesGenerated} rules generated`);
  if (parts.length === 0) return "No changes.";
  return parts.join(", ") + ".";
}

// ---------------------------------------------------------------------------
// Episodic consolidation
// ---------------------------------------------------------------------------

/**
 * Run episodic consolidation:
 *  1. Fetch unconsolidated event log entries older than consolidateAfterDays.
 *  2. Group by primary entity.
 *  3. For each group, create a consolidated fact.
 *  4. For each source event, create a short-lived "episodic source" fact and a
 *     DERIVED_FROM link pointing from the consolidated fact to the source fact.
 *  5. Mark all events as consolidated in the event log.
 *  6. Prune the immediately-expired source facts (DERIVED_FROM links remain for provenance).
 */
export async function runEpisodicConsolidation(
  factsDb: FactsDB,
  eventLog: EventLog,
  consolidateAfterDays: number,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ eventsConsolidated: number; factsCreated: number }> {
  const events = eventLog.getUnconsolidated(consolidateAfterDays);
  if (events.length === 0) {
    return { eventsConsolidated: 0, factsCreated: 0 };
  }

  const groups = groupEventsByEntity(events);
  let factsCreated = 0;
  let eventsConsolidated = 0;
  const ephemeralSourceFactIds: string[] = [];

  for (const [entity, groupEvents] of groups) {
    if (groupEvents.length === 0) continue;

    // Collect text from all events in this group
    const eventTexts = groupEvents
      .map((e) => extractEventText(e))
      .filter((t) => t.length >= 3);

    if (eventTexts.length === 0) {
      // Mark events as consolidated with null (skipped — no extractable text)
      eventLog.markConsolidated(groupEvents.map((e) => e.id), null);
      eventsConsolidated += groupEvents.length;
      continue;
    }

    // Build merged text for the consolidated fact
    const entityLabel = entity !== "__default__" ? entity : null;
    const mergedText =
      eventTexts.length === 1
        ? eventTexts[0]
        : `[consolidated from ${eventTexts.length} events${entityLabel ? ` about ${entityLabel}` : ""}] ${eventTexts.slice(0, 5).join("; ")}`;

    // Create the consolidated fact
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
        decayClass: "stable",
        tags: ["dream-cycle", "consolidated"],
      });
    } catch (err) {
      logger.warn(`memory-hybrid: dream-cycle — failed to store consolidated fact for entity "${entity}": ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "dream-cycle-consolidate",
        subsystem: "facts-db",
      });
      continue;
    }

    // For each event, create a minimal ephemeral source fact and a DERIVED_FROM link.
    // The source facts expire immediately; DERIVED_FROM links persist as provenance.
    const nowSec = Math.floor(Date.now() / 1000);
    for (const event of groupEvents) {
      const srcText = extractEventText(event);
      if (srcText.length < 3) continue;

      try {
        const srcFact = factsDb.store({
          text: srcText.slice(0, 300),
          category: "fact" as MemoryCategory,
          importance: 0.1,
          entity: entityLabel,
          key: "episodic_source",
          value: event.eventType,
          source: "dream-cycle-src",
          decayClass: "checkpoint",
          expiresAt: nowSec - 1, // Immediately expired — will be pruned right away
          confidence: 0.5,
        });
        ephemeralSourceFactIds.push(srcFact.id);
        // consolidated_fact -DERIVED_FROM-> source_fact (provenance)
        factsDb.createLink(consolidatedFact.id, srcFact.id, "DERIVED_FROM", 1.0);
      } catch (err) {
        logger.warn(`memory-hybrid: dream-cycle — failed to create source fact for event ${event.id}: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dream-cycle-src-fact",
          subsystem: "facts-db",
        });
      }
    }

    // Mark all events in the group as consolidated into the new fact
    eventLog.markConsolidated(groupEvents.map((e) => e.id), consolidatedFact.id);

    factsCreated++;
    eventsConsolidated += groupEvents.length;

    logger.info(
      `memory-hybrid: dream-cycle — consolidated ${groupEvents.length} events` +
        (entityLabel ? ` for entity "${entityLabel}"` : "") +
        ` → fact ${consolidatedFact.id.slice(0, 8)}`,
    );
  }

  // Delete only the ephemeral source facts created during this consolidation.
  // DERIVED_FROM links to them are preserved by design (see delete() in facts-db.ts).
  for (const id of ephemeralSourceFactIds) {
    factsDb.delete(id);
  }

  return { eventsConsolidated, factsCreated };
}

// ---------------------------------------------------------------------------
// Main dream cycle orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full nightly dream cycle:
 *  prune → episodic consolidation → reflect → reflect-rules (optional) → digest
 */
export async function runDreamCycle(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  eventLog: EventLog | null,
  config: DreamCycleConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<DreamCycleResult> {
  if (!config.enabled) {
    return {
      factsPruned: 0,
      factsDecayed: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
      digestSummary: "Dream cycle disabled.",
      skipped: true,
    };
  }

  logger.info("memory-hybrid: dream-cycle — starting nightly cycle");

  // ── Step 1: Prune ────────────────────────────────────────────────────────
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

  // ── Step 2: Episodic consolidation ───────────────────────────────────────
  let eventsConsolidated = 0;
  let factsCreated = 0;
  if (eventLog) {
    try {
      const consolidationResult = await runEpisodicConsolidation(
        factsDb,
        eventLog,
        config.consolidateAfterDays,
        logger,
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
  }

  // ── Step 3: Reflect ───────────────────────────────────────────────────────
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
      },
      logger,
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

  // ── Step 4: Reflect-rules (optional) ────────────────────────────────────
  let rulesGenerated = 0;
  if (patternsFound >= MIN_PATTERNS_FOR_RULES) {
    try {
      const rulesResult = await runReflectionRules(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        { dryRun: false, model: config.model, fallbackModels: config.fallbackModels ?? [] },
        logger,
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
  }

  // ── Step 5: Digest summary ───────────────────────────────────────────────
  const digestSummary = buildDigestSummary({
    factsPruned,
    factsDecayed,
    eventsConsolidated,
    factsCreated,
    patternsFound,
    rulesGenerated,
  });

  logger.info(`memory-hybrid: dream-cycle — complete. ${digestSummary}`);

  return {
    factsPruned,
    factsDecayed,
    eventsConsolidated,
    factsCreated,
    patternsFound,
    rulesGenerated,
    digestSummary,
    skipped: false,
  };
}
