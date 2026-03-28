/**
 * Learnings Intake Buffer — Type Definitions (Issue #617)
 *
 * Structured staging area for capturing errors, lessons, and feature requests
 * before promoting them to permanent memory or documentation.
 *
 * Three entry types map to distinct intake files:
 *  - "error"           → ERRORS.md — tool/workflow failures with recurrence tracking
 *  - "learning"        → LEARNINGS.md — stable lessons and best practices
 *  - "feature_request" → FEATURE_REQUESTS.md — improvement ideas not yet in memory
 */

/** Entry classification. */
export type LearningEntryType = "error" | "learning" | "feature_request";

/**
 * Lifecycle status for staged entries.
 *
 * Transitions:
 *   open → promoted | wont_promote
 *   promoted → (terminal)
 *   wont_promote → open   (allows reopening)
 */
export type LearningEntryStatus = "open" | "promoted" | "wont_promote";

/** Valid status transitions. */
export const LEARNING_STATUS_TRANSITIONS: Record<LearningEntryStatus, LearningEntryStatus[]> = {
  open: ["promoted", "wont_promote"],
  promoted: [],
  wont_promote: ["open"],
};

/** A single staged intake entry. */
export interface LearningEntry {
  id: string;
  /** Human-readable sequential label, e.g. "ERR-001", "LRN-003", "FR-002". */
  slug: string;
  type: LearningEntryType;
  status: LearningEntryStatus;
  /** Functional area this entry concerns (e.g. "forge-dispatch", "council-review"). */
  area: string;
  /** The main content: what happened, the lesson, or the request. */
  content: string;
  /** How many times this exact issue / lesson has recurred. */
  recurrence: number;
  /** Where the entry was promoted to (fact category, SKILL.md, etc.). */
  promotedTo?: string;
  /** Tags for cross-linking. */
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Input to create a new staged entry. */
export interface CreateLearningEntryInput {
  type: LearningEntryType;
  area: string;
  content: string;
  tags?: string[];
}
