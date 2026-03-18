/**
 * Learnings Intake Service — staged memory promotion for `.learnings/` buffer (Issue #617).
 *
 * Provides a thin domain layer on top of LearningsDB that enforces the
 * promotion rules defined in the issue:
 *
 * | Entry type       | Recurrence | Promotion target                             |
 * |------------------|------------|----------------------------------------------|
 * | One-off error    | 1          | ephemeral (session) — do not auto-promote    |
 * | Repeated error   | 2+         | memory_store(category=technical/rule) + note |
 * | Behavior issue   | 2+         | quality loop + memory_reflect                |
 * | Stable lesson    | 1 (hi-imp) | SKILL.md or AGENTS.md (human review first)   |
 * | Feature request  | 1          | file as GitHub issue when ready              |
 *
 * Engineering Goals addressed:
 *  - Organic Learning: captures corrections before they escape the session.
 *  - Smart Forgetting: recurrence gates whether an entry rises to global memory.
 *  - Strict Separation of Concerns: promotion decisions live here, not in the DB.
 *  - Rock-Solid Stability: every code path uses capturePluginError.
 */

import { capturePluginError } from "./error-reporter.js";
import type { LearningsDB } from "../backends/learnings-db.js";
import type { LearningEntry, LearningEntryType, CreateLearningEntryInput } from "../types/learnings-types.js";

// ---------------------------------------------------------------------------
// Promotion evaluation
// ---------------------------------------------------------------------------

/** Result of evaluating whether an entry is ready for promotion. */
export interface PromotionEvaluation {
  shouldPromote: boolean;
  /** Suggested target description, e.g. "memory_store(category=technical)" */
  suggestedTarget: string | null;
  reason: string;
}

/**
 * Evaluate whether a staged entry meets the threshold for memory promotion.
 *
 * Does NOT perform the promotion — callers decide when to act.
 */
export function evaluatePromotion(entry: LearningEntry): PromotionEvaluation {
  if (entry.status !== "open") {
    return { shouldPromote: false, suggestedTarget: null, reason: `entry already ${entry.status}` };
  }

  switch (entry.type) {
    case "error":
      if (entry.recurrence >= 2) {
        return {
          shouldPromote: true,
          suggestedTarget: "memory_store(category=technical)",
          reason: `repeated error (recurrence=${entry.recurrence}) — promotes to technical memory`,
        };
      }
      return {
        shouldPromote: false,
        suggestedTarget: null,
        reason: "one-off error (recurrence=1) — keep as ephemeral session note",
      };

    case "learning":
      // High-impact lessons (recurrence >= 1 for learnings) go to human review first
      return {
        shouldPromote: true,
        suggestedTarget: "human-review → SKILL.md or AGENTS.md",
        reason: "stable lesson — flag for human review before writing to SKILL.md",
      };

    case "feature_request":
      return {
        shouldPromote: false,
        suggestedTarget: "GitHub issue",
        reason: "feature request — file as GitHub issue when ready, not a memory fact",
      };
  }
}

// ---------------------------------------------------------------------------
// Convenience creators
// ---------------------------------------------------------------------------

/**
 * Add an error entry to the intake buffer.
 *
 * If an entry with the same area + content already exists (open status) the
 * recurrence counter is incremented instead of creating a duplicate.
 */
export function addError(db: LearningsDB, area: string, content: string, tags?: string[]): LearningEntry {
  try {
    return _addOrIncrement(db, "error", area, content, tags);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "add-error",
      subsystem: "learnings-intake",
      severity: "warning",
    });
    throw err;
  }
}

/**
 * Add a learning entry to the intake buffer.
 */
export function addLearning(db: LearningsDB, area: string, content: string, tags?: string[]): LearningEntry {
  try {
    return _addOrIncrement(db, "learning", area, content, tags);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "add-learning",
      subsystem: "learnings-intake",
      severity: "warning",
    });
    throw err;
  }
}

/**
 * Add a feature request to the intake buffer.
 */
export function addFeatureRequest(db: LearningsDB, area: string, content: string, tags?: string[]): LearningEntry {
  try {
    return _addOrIncrement(db, "feature_request", area, content, tags);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "add-feature-request",
      subsystem: "learnings-intake",
      severity: "warning",
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Promotion workflow
// ---------------------------------------------------------------------------

/**
 * Mark an entry as promoted and record where it was promoted to.
 *
 * @param db       - The LearningsDB instance.
 * @param id       - Entry UUID.
 * @param target   - Human-readable promotion target (e.g. "memory_store(category=technical)").
 */
export function promoteEntry(db: LearningsDB, id: string, target: string): LearningEntry {
  try {
    return db.transition(id, "promoted", target);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "promote-entry",
      subsystem: "learnings-intake",
      severity: "warning",
    });
    throw err;
  }
}

/**
 * Mark an entry as wont_promote (low priority, single occurrence, noise, etc.).
 */
export function dismissEntry(db: LearningsDB, id: string): LearningEntry {
  try {
    return db.transition(id, "wont_promote");
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "dismiss-entry",
      subsystem: "learnings-intake",
      severity: "warning",
    });
    throw err;
  }
}

/**
 * Scan all open entries and return those that meet the promotion threshold.
 *
 * Returns entries sorted by recurrence (highest first) so callers can process
 * the highest-priority items first.
 */
export function getPendingPromotions(db: LearningsDB): Array<{ entry: LearningEntry; eval: PromotionEvaluation }> {
  try {
    const openEntries = db.list({ status: ["open"] });
    return openEntries
      .map((entry) => ({ entry, eval: evaluatePromotion(entry) }))
      .filter((item) => item.eval.shouldPromote)
      .sort((a, b) => b.entry.recurrence - a.entry.recurrence);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "get-pending-promotions",
      subsystem: "learnings-intake",
      severity: "warning",
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Create a new entry or increment recurrence if an open entry with the same
 * area + content already exists.
 *
 * Note: When an existing entry is found, the tags parameter is intentionally
 * ignored to preserve the original tags from the first occurrence. This is
 * consistent with the deduplication semantics where recurrence counting takes
 * precedence over metadata updates.
 */
function _addOrIncrement(
  db: LearningsDB,
  type: LearningEntryType,
  area: string,
  content: string,
  tags?: string[],
): LearningEntry {
  // Search open entries of this type for an exact area+content match.
  const existing = db.list({ type: [type], status: ["open"] }).find((e) => e.area === area && e.content === content);

  if (existing) {
    return db.incrementRecurrence(existing.id);
  }

  const input: CreateLearningEntryInput = { type, area, content, tags };
  return db.create(input);
}
