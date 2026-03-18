/**
 * LearningsDB & learnings-intake service tests (Issue #617).
 *
 * Covers:
 *  - CRUD lifecycle of intake entries
 *  - Slug generation (type-prefixed, zero-padded)
 *  - Recurrence increment and deduplication in learnings-intake
 *  - Status transitions (allowed and rejected)
 *  - Promotion evaluation logic
 *  - Pending-promotions scan
 *  - prune() maintenance helper
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LearningsDB } from "../backends/learnings-db.js";
import {
  addError,
  addLearning,
  addFeatureRequest,
  promoteEntry,
  dismissEntry,
  evaluatePromotion,
  getPendingPromotions,
} from "../services/learnings-intake.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: LearningsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "learnings-db-test-"));
  db = new LearningsDB(join(tmpDir, "learnings.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// LearningsDB — basic CRUD
// ---------------------------------------------------------------------------

describe("LearningsDB — create", () => {
  it("stores an error entry with correct defaults", () => {
    const entry = db.create({ type: "error", area: "forge-dispatch", content: "ctx.logger instead of api.logger" });

    expect(entry.id).toBeTruthy();
    expect(entry.slug).toBe("ERR-001");
    expect(entry.type).toBe("error");
    expect(entry.status).toBe("open");
    expect(entry.area).toBe("forge-dispatch");
    expect(entry.recurrence).toBe(1);
    expect(entry.tags).toEqual([]);
    expect(entry.promotedTo).toBeUndefined();
  });

  it("assigns sequential slugs per type", () => {
    const e1 = db.create({ type: "error", area: "a", content: "first error" });
    const e2 = db.create({ type: "error", area: "b", content: "second error" });
    const l1 = db.create({ type: "learning", area: "c", content: "first lesson" });

    expect(e1.slug).toBe("ERR-001");
    expect(e2.slug).toBe("ERR-002");
    expect(l1.slug).toBe("LRN-001");
  });

  it("stores tags correctly", () => {
    const entry = db.create({
      type: "feature_request",
      area: "pr-lifecycle",
      content: "cap re-runs",
      tags: ["cap", "council"],
    });
    expect(entry.tags).toEqual(["cap", "council"]);
  });
});

describe("LearningsDB — get & getBySlug", () => {
  it("retrieves by id", () => {
    const created = db.create({ type: "learning", area: "test", content: "lesson A" });
    const fetched = db.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("retrieves by slug", () => {
    const created = db.create({ type: "error", area: "test", content: "err A" });
    const fetched = db.getBySlug(created.slug);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("returns null for unknown id", () => {
    expect(db.get("non-existent-id")).toBeNull();
  });
});

describe("LearningsDB — incrementRecurrence", () => {
  it("bumps recurrence counter", () => {
    const entry = db.create({ type: "error", area: "area", content: "content" });
    expect(entry.recurrence).toBe(1);

    const bumped = db.incrementRecurrence(entry.id);
    expect(bumped.recurrence).toBe(2);

    const bumped2 = db.incrementRecurrence(entry.id);
    expect(bumped2.recurrence).toBe(3);
  });

  it("throws for unknown id", () => {
    expect(() => db.incrementRecurrence("no-such-id")).toThrow("not found");
  });
});

describe("LearningsDB — transition", () => {
  it("transitions open → promoted with promotedTo", () => {
    const entry = db.create({ type: "learning", area: "test", content: "lesson" });
    const promoted = db.transition(entry.id, "promoted", "memory_store(category=technical)");
    expect(promoted.status).toBe("promoted");
    expect(promoted.promotedTo).toBe("memory_store(category=technical)");
  });

  it("transitions open → wont_promote", () => {
    const entry = db.create({ type: "error", area: "test", content: "one-off" });
    const dismissed = db.transition(entry.id, "wont_promote");
    expect(dismissed.status).toBe("wont_promote");
  });

  it("transitions wont_promote → open (reopen)", () => {
    const entry = db.create({ type: "feature_request", area: "test", content: "fr" });
    db.transition(entry.id, "wont_promote");
    const reopened = db.transition(entry.id, "open");
    expect(reopened.status).toBe("open");
  });

  it("rejects invalid transition promoted → open", () => {
    const entry = db.create({ type: "learning", area: "test", content: "l" });
    db.transition(entry.id, "promoted", "somewhere");
    expect(() => db.transition(entry.id, "open")).toThrow("Invalid transition");
  });

  it("throws for unknown id", () => {
    expect(() => db.transition("no-such-id", "promoted")).toThrow("not found");
  });
});

describe("LearningsDB — list & count", () => {
  beforeEach(() => {
    db.create({ type: "error", area: "a", content: "err1" });
    db.create({ type: "error", area: "b", content: "err2" });
    db.create({ type: "learning", area: "c", content: "lrn1" });
    db.create({ type: "feature_request", area: "d", content: "fr1" });
  });

  it("lists all entries", () => {
    expect(db.list().length).toBe(4);
  });

  it("filters by type", () => {
    expect(db.list({ type: ["error"] }).length).toBe(2);
    expect(db.list({ type: ["learning"] }).length).toBe(1);
    expect(db.list({ type: ["feature_request"] }).length).toBe(1);
  });

  it("filters by status", () => {
    const entry = db.list({ type: ["error"] })[0];
    db.transition(entry.id, "promoted", "somewhere");
    expect(db.list({ status: ["open"] }).length).toBe(3);
    expect(db.list({ status: ["promoted"] }).length).toBe(1);
  });

  it("filters by area", () => {
    expect(db.list({ area: "a" }).length).toBe(1);
    expect(db.list({ area: "z" }).length).toBe(0);
  });

  it("applies limit", () => {
    expect(db.list({ limit: 2 }).length).toBe(2);
  });

  it("count() returns total", () => {
    expect(db.count()).toBe(4);
    expect(db.count({ type: "error" })).toBe(2);
    expect(db.count({ status: "open" })).toBe(4);
  });
});

describe("LearningsDB — prune", () => {
  it("removes old promoted entries", () => {
    const entry = db.create({ type: "error", area: "x", content: "old err" });
    db.transition(entry.id, "promoted", "somewhere");
    // prune with 0 days should remove it immediately
    const removed = db.prune(0);
    expect(removed).toBe(1);
    expect(db.count()).toBe(0);
  });

  it("does not remove open entries", () => {
    db.create({ type: "learning", area: "y", content: "keep me" });
    const removed = db.prune(0);
    expect(removed).toBe(0);
    expect(db.count()).toBe(1);
  });

  it("slug generation after prune does not cause collisions", () => {
    // Create ERR-001 and ERR-002
    const e1 = db.create({ type: "error", area: "x", content: "error 1" });
    const e2 = db.create({ type: "error", area: "x", content: "error 2" });
    expect(e1.slug).toBe("ERR-001");
    expect(e2.slug).toBe("ERR-002");

    // Promote and prune ERR-001
    db.transition(e1.id, "promoted", "somewhere");
    const removed = db.prune(0);
    expect(removed).toBe(1);

    // Create a new error - should be ERR-003, not ERR-002
    const e3 = db.create({ type: "error", area: "x", content: "error 3" });
    expect(e3.slug).toBe("ERR-003");

    // Verify ERR-002 still exists
    const e2Fetched = db.getBySlug("ERR-002");
    expect(e2Fetched).not.toBeNull();
    expect(e2Fetched!.id).toBe(e2.id);
  });
});

// ---------------------------------------------------------------------------
// learnings-intake service
// ---------------------------------------------------------------------------

describe("addError — deduplication", () => {
  it("creates a new entry on first call", () => {
    const entry = addError(db, "forge", "ctx.logger bug");
    expect(entry.recurrence).toBe(1);
    expect(entry.slug).toBe("ERR-001");
  });

  it("increments recurrence instead of creating a duplicate", () => {
    const first = addError(db, "forge", "ctx.logger bug");
    const second = addError(db, "forge", "ctx.logger bug");
    expect(first.id).toBe(second.id);
    expect(second.recurrence).toBe(2);
    expect(db.count({ type: "error" })).toBe(1);
  });

  it("creates a new entry for different content", () => {
    addError(db, "forge", "error A");
    addError(db, "forge", "error B");
    expect(db.count({ type: "error" })).toBe(2);
  });
});

describe("addLearning & addFeatureRequest", () => {
  it("addLearning creates a LRN- entry", () => {
    const l = addLearning(db, "council", "state fix location");
    expect(l.slug).toBe("LRN-001");
    expect(l.type).toBe("learning");
  });

  it("addFeatureRequest creates a FR- entry", () => {
    const fr = addFeatureRequest(db, "pr-lifecycle", "cap re-runs at 2");
    expect(fr.slug).toBe("FR-001");
    expect(fr.type).toBe("feature_request");
  });
});

describe("promoteEntry & dismissEntry", () => {
  it("promoteEntry sets status to promoted", () => {
    const entry = addError(db, "area", "content");
    const promoted = promoteEntry(db, entry.id, "memory_store(category=technical)");
    expect(promoted.status).toBe("promoted");
    expect(promoted.promotedTo).toBe("memory_store(category=technical)");
  });

  it("dismissEntry sets status to wont_promote", () => {
    const entry = addLearning(db, "area", "content");
    const dismissed = dismissEntry(db, entry.id);
    expect(dismissed.status).toBe("wont_promote");
  });
});

// ---------------------------------------------------------------------------
// evaluatePromotion
// ---------------------------------------------------------------------------

describe("evaluatePromotion", () => {
  it("one-off error: shouldPromote = false", () => {
    const entry = db.create({ type: "error", area: "x", content: "one-off" });
    const result = evaluatePromotion(entry);
    expect(result.shouldPromote).toBe(false);
  });

  it("repeated error (recurrence=2): shouldPromote = true", () => {
    const entry = db.create({ type: "error", area: "x", content: "repeated" });
    db.incrementRecurrence(entry.id);
    const updated = db.get(entry.id)!;
    const result = evaluatePromotion(updated);
    expect(result.shouldPromote).toBe(true);
    expect(result.suggestedTarget).toContain("memory_store");
  });

  it("learning: shouldPromote = true (human review)", () => {
    const entry = db.create({ type: "learning", area: "x", content: "lesson" });
    const result = evaluatePromotion(entry);
    expect(result.shouldPromote).toBe(true);
    expect(result.suggestedTarget).toContain("human-review");
  });

  it("feature_request: shouldPromote = false", () => {
    const entry = db.create({ type: "feature_request", area: "x", content: "fr" });
    const result = evaluatePromotion(entry);
    expect(result.shouldPromote).toBe(false);
    expect(result.suggestedTarget).toBe("GitHub issue");
  });

  it("promoted entry: shouldPromote = false (already done)", () => {
    const entry = db.create({ type: "error", area: "x", content: "done" });
    db.transition(entry.id, "promoted", "somewhere");
    const updated = db.get(entry.id)!;
    const result = evaluatePromotion(updated);
    expect(result.shouldPromote).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPendingPromotions
// ---------------------------------------------------------------------------

describe("getPendingPromotions", () => {
  it("returns empty list when no open entries qualify", () => {
    addError(db, "area", "one-off"); // recurrence=1, should not promote
    expect(getPendingPromotions(db)).toHaveLength(0);
  });

  it("returns repeated errors and learnings", () => {
    const err = addError(db, "area", "repeated");
    addError(db, "area", "repeated"); // bumps recurrence to 2
    addLearning(db, "area", "lesson");

    const pending = getPendingPromotions(db);
    // Both the repeated error and the learning should be included
    expect(pending.length).toBe(2);
    const ids = pending.map((p) => p.entry.id);
    expect(ids).toContain(err.id);
  });

  it("sorts by recurrence descending", () => {
    const a = addError(db, "area", "high-recurrence");
    addError(db, "area", "high-recurrence"); // recurrence=2
    addError(db, "area", "high-recurrence"); // recurrence=3 — same id as 'a'

    addLearning(db, "area", "lesson"); // recurrence=1

    const pending = getPendingPromotions(db);
    expect(pending[0].entry.id).toBe(a.id);
    expect(pending[0].entry.recurrence).toBe(3);
  });

  it("excludes already-promoted entries", () => {
    const err = addError(db, "area", "repeated");
    addError(db, "area", "repeated"); // recurrence=2
    promoteEntry(db, err.id, "somewhere");

    expect(getPendingPromotions(db)).toHaveLength(0);
  });
});
