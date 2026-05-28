/**
 * Tests for project-state latest-wins (LWW) contradiction resolution (Issue #1636).
 *
 * Covers:
 *   - Equal-confidence project `status` transition in_progress → done
 *   - Project `next` update from active-task → conversation
 *   - Non-project equal-confidence conflict remains ambiguous (unchanged behavior)
 *   - Overloaded task entity is flagged in LWW report
 *   - Dry-run does not mutate facts or contradictions
 *   - Apply mode resolves contradictions and supersedes old facts
 *   - Write-time auto-supersede: project-state store avoids leaving unresolved contradictions
 *   - Trusted-source guard: distillation source does not qualify for LWW
 *   - Older-wins case: newer fact older than old → manual-review
 *   - Missing old_fact_original_confidence stays manual-review (no penalized fallback)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lww-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StoreOpts = {
  entity: string;
  key: string;
  value: string;
  text: string;
  category?: string;
  source?: string;
  confidence?: number;
  createdAtOffset?: number;
};

/** Store a fact and return it. createdAtOffset shifts created_at by N seconds from its initial stored value. */
function storeProjectFact(opts: StoreOpts) {
  const entry = db.store({
    text: opts.text,
    category: (opts.category ?? "project") as import("../config.js").MemoryCategory,
    importance: 0.8,
    entity: opts.entity,
    key: opts.key,
    value: opts.value,
    source: opts.source ?? "conversation",
    confidence: opts.confidence ?? 1.0,
  });
  if (opts.createdAtOffset != null && opts.createdAtOffset !== 0) {
    // Directly adjust created_at so we can test ordering without real sleep.
    // @ts-expect-error accessing internal liveDb for test setup only
    db.liveDb.prepare("UPDATE facts SET created_at = created_at + ? WHERE id = ?").run(opts.createdAtOffset, entry.id);
  }
  return db.getById(entry.id)!;
}

// ---------------------------------------------------------------------------
// 1. Equal-confidence project status transition: in_progress → done
// ---------------------------------------------------------------------------
describe("project-state-lww: equal-confidence status transition", () => {
  it("dry-run reports the transition as supersede candidate", () => {
    const older = storeProjectFact({
      entity: "hybrid-memory-issue-1636-pr",
      key: "status",
      value: "in_progress",
      text: "PR #1636 is in progress",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "hybrid-memory-issue-1636-pr",
      key: "status",
      value: "done",
      text: "PR #1636 merged",
      confidence: 1.0,
      createdAtOffset: 60,
    });

    // Use recordContradiction directly so the contradiction stays unresolved for
    // the batch pass to find (detectContradictions triggers write-time LWW which
    // would immediately resolve the pair before the batch run).
    db.recordContradiction(newer.id, older.id);

    const result = db.resolveContradictionsProjectStateLww({ dryRun: true });
    expect(result.totalCandidates).toBeGreaterThanOrEqual(1);
    expect(result.wouldSupersede).toBeGreaterThanOrEqual(1);
    expect(result.applied).toBe(0); // dry-run: no mutations
    const candidate = result.groups
      .flatMap((g) => g.candidates)
      .find((c) => c.factIdNew === newer.id || c.factIdOld === older.id);
    expect(candidate).toBeDefined();
    expect(candidate?.action).toBe("supersede");
  });

  it("apply mode resolves the contradiction and marks old fact superseded", () => {
    const older = storeProjectFact({
      entity: "hybrid-memory-issue-1636-pr",
      key: "status",
      value: "in_progress",
      text: "PR #1636 is in progress",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "hybrid-memory-issue-1636-pr",
      key: "status",
      value: "done",
      text: "PR #1636 merged",
      confidence: 1.0,
      createdAtOffset: 60,
    });

    // Use recordContradiction directly so the contradiction stays unresolved for
    // the batch pass (detectContradictions triggers write-time LWW which would
    // resolve the pair before the batch run, making beforeApply empty).
    db.recordContradiction(newer.id, older.id);

    // Verify contradiction was recorded
    const beforeApply = db.getContradictions();
    expect(beforeApply.some((c) => c.factIdNew === newer.id && c.factIdOld === older.id)).toBe(true);

    const result = db.resolveContradictionsProjectStateLww({ dryRun: false });
    expect(result.applied).toBeGreaterThanOrEqual(1);

    // Contradiction should now be resolved
    const afterApply = db.getContradictions();
    expect(afterApply.every((c) => c.resolved || c.factIdNew !== newer.id)).toBe(true);

    // Old fact should be superseded
    const oldFactAfter = db.getById(older.id);
    expect(oldFactAfter?.supersededAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Project `next` update from active-task → conversation
// ---------------------------------------------------------------------------
describe("project-state-lww: next key update across sources", () => {
  it("conversation source supersedes active-task source for next key", () => {
    const older = storeProjectFact({
      entity: "hybrid-memory",
      key: "next",
      value: "fix CI",
      text: "Next: fix CI — from active-task",
      source: "active-task",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "hybrid-memory",
      key: "next",
      value: "merge PR #1636",
      text: "Next: merge PR #1636 — conversation update",
      source: "conversation",
      confidence: 1.0,
      createdAtOffset: 120,
    });

    // Use recordContradiction directly so the contradiction stays unresolved for
    // the batch pass (detectContradictions triggers write-time LWW which would
    // resolve the pair before the batch run).
    db.recordContradiction(newer.id, older.id);

    const result = db.resolveContradictionsProjectStateLww({ dryRun: false });
    expect(result.applied).toBeGreaterThanOrEqual(1);

    // Old active-task fact should be superseded
    const oldAfter = db.getById(older.id);
    expect(oldAfter?.supersededAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Non-project equal-confidence conflict remains ambiguous
// ---------------------------------------------------------------------------
describe("project-state-lww: non-project facts are not touched", () => {
  it("fact category equal-confidence contradiction stays ambiguous under LWW", () => {
    const older = db.store({
      text: "User prefers dark theme",
      category: "fact",
      importance: 0.7,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
      confidence: 1.0,
    });
    const newer = db.store({
      text: "User prefers light theme",
      category: "fact",
      importance: 0.7,
      entity: "user",
      key: "theme",
      value: "light",
      source: "conversation",
      confidence: 1.0,
    });

    db.detectContradictions(newer.id, "user", "theme", "light");

    const result = db.resolveContradictionsProjectStateLww({ dryRun: true });
    // LWW should not pick up non-project facts
    const touched = result.groups
      .flatMap((g) => g.candidates)
      .find((c) => c.factIdNew === newer.id || c.factIdOld === older.id);
    expect(touched).toBeUndefined();

    // The contradiction should still be unresolved
    const unresolvedAfter = db.getContradictions();
    expect(unresolvedAfter.some((c) => c.factIdNew === newer.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Overloaded task entity is flagged in the LWW report
// ---------------------------------------------------------------------------
describe("project-state-lww: overloaded entity detection", () => {
  it("flags when entity/key values reference many distinct PR/issue numbers", () => {
    const older = storeProjectFact({
      entity: "hybrid-memory-issue-1272-pr",
      key: "status",
      value: "done — PR #1284 merged",
      text: "PR #1284 for issue #1272 merged",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "hybrid-memory-issue-1272-pr",
      key: "status",
      value: "in_progress — PR #1288 open",
      text: "Follow-up PR #1288 for issue #1272 in progress, related to issue #999",
      confidence: 1.0,
      createdAtOffset: 30,
    });

    // Use recordContradiction directly so the contradiction stays unresolved for
    // the batch pass (detectContradictions triggers write-time LWW which would
    // resolve the pair before the batch run, preventing overloaded-entity detection).
    db.recordContradiction(newer.id, older.id);

    const result = db.resolveContradictionsProjectStateLww({ dryRun: true });
    const candidate = result.groups
      .flatMap((g) => g.candidates)
      .find((c) => c.factIdNew === newer.id || c.factIdOld === older.id);

    // Candidate should be found and flagged as possibly overloaded
    expect(candidate).toBeDefined();
    expect(candidate?.possibleOverloadedEntity).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Dry-run does not mutate facts or contradictions
// ---------------------------------------------------------------------------
describe("project-state-lww: dry-run immutability", () => {
  it("does not modify any facts or contradiction records in dry-run mode", () => {
    const older = storeProjectFact({
      entity: "test-project",
      key: "status",
      value: "in_progress",
      text: "Test project in progress",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "test-project",
      key: "status",
      value: "done",
      text: "Test project done",
      confidence: 1.0,
      createdAtOffset: 60,
    });

    // Use recordContradiction directly so the contradiction is present and unresolved
    // when we check immutability. detectContradictions triggers write-time LWW which
    // would immediately resolve the pair, making the before/after checks vacuous.
    db.recordContradiction(newer.id, older.id);

    const contradictionsBefore = db.getContradictions();
    const olderFactBefore = db.getById(older.id);

    db.resolveContradictionsProjectStateLww({ dryRun: true });

    const contradictionsAfter = db.getContradictions();
    const olderFactAfter = db.getById(older.id);

    // Contradiction records unchanged
    expect(contradictionsAfter.length).toBe(contradictionsBefore.length);
    expect(contradictionsAfter.every((c) => !c.resolved)).toBe(true);
    // Old fact NOT superseded
    expect(olderFactAfter?.supersededAt).toBe(olderFactBefore?.supersededAt);
  });
});

// ---------------------------------------------------------------------------
// 6. Trusted-source guard: distillation source does not qualify for LWW
// ---------------------------------------------------------------------------
describe("project-state-lww: source trust guard", () => {
  it("does not supersede when newer fact source is distillation", () => {
    const older = storeProjectFact({
      entity: "proj-a",
      key: "status",
      value: "in_progress",
      text: "Project A in progress",
      source: "conversation",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "proj-a",
      key: "status",
      value: "done",
      text: "Project A done (distilled)",
      source: "distillation",
      confidence: 1.0,
      createdAtOffset: 60,
    });

    db.detectContradictions(newer.id, "proj-a", "status", "done");

    const result = db.resolveContradictionsProjectStateLww({ dryRun: true });
    const candidate = result.groups
      .flatMap((g) => g.candidates)
      .find((c) => c.factIdNew === newer.id || c.factIdOld === older.id);

    // distillation source → not eligible for LWW
    expect(candidate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Older-wins case: newer fact timestamp is not strictly newer → manual-review
// ---------------------------------------------------------------------------
describe("project-state-lww: older-wins prevents auto-supersede", () => {
  it("keeps action as manual-review when new fact is not strictly newer", () => {
    const older = storeProjectFact({
      entity: "proj-b",
      key: "next",
      value: "step A",
      text: "Next step A",
      confidence: 1.0,
    });
    // Force same created_at as older to avoid wall-clock timing flake.
    const newerInitial = storeProjectFact({
      entity: "proj-b",
      key: "next",
      value: "step B",
      text: "Next step B",
      confidence: 1.0,
    });
    // @ts-expect-error accessing internal liveDb for deterministic test setup only
    db.liveDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(older.createdAt, newerInitial.id);
    const newer = db.getById(newerInitial.id)!;

    // Manually record the contradiction since detectContradictions at write time may auto-resolve
    // strictly newer project facts; here they have the same timestamp so it won't auto-resolve.
    db.recordContradiction(newer.id, older.id);

    const result = db.resolveContradictionsProjectStateLww({ dryRun: true });
    const candidate = result.groups
      .flatMap((g) => g.candidates)
      .find((c) => c.factIdNew === newer.id && c.factIdOld === older.id);

    if (candidate) {
      expect(candidate.action).toBe("manual-review");
    }
    // If not in result, it means it was filtered out entirely (also acceptable for non-qualifying)
  });
});

// ---------------------------------------------------------------------------
// 8. Missing original confidence should not auto-supersede
// ---------------------------------------------------------------------------
describe("project-state-lww: missing original confidence requires manual-review", () => {
  it("does not supersede when old_fact_original_confidence is missing", () => {
    const older = storeProjectFact({
      entity: "proj-missing-original-confidence",
      key: "status",
      value: "in_progress",
      text: "Project in progress",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "proj-missing-original-confidence",
      key: "status",
      value: "done",
      text: "Project done with lower confidence than original",
      confidence: 0.9,
      createdAtOffset: 60,
    });

    // recordContradiction stores the pre-penalty confidence then penalizes old fact by -0.2.
    db.recordContradiction(newer.id, older.id);
    // Simulate legacy/backfilled contradiction rows where original confidence is absent.
    // @ts-expect-error accessing internal liveDb for deterministic legacy-row setup
    db.liveDb
      .prepare("UPDATE contradictions SET old_fact_original_confidence = NULL WHERE fact_id_new = ? AND fact_id_old = ?")
      .run(newer.id, older.id);

    const dryRun = db.resolveContradictionsProjectStateLww({ dryRun: true });
    const candidate = dryRun.groups
      .flatMap((g) => g.candidates)
      .find((c) => c.factIdNew === newer.id && c.factIdOld === older.id);
    expect(candidate).toBeDefined();
    expect(candidate?.action).toBe("manual-review");

    const apply = db.resolveContradictionsProjectStateLww({ dryRun: false });
    expect(apply.applied).toBe(0);
    const oldAfter = db.getById(older.id);
    expect(oldAfter?.supersededAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Write-time auto-supersede: storing a newer project-state fact avoids
//    leaving an unresolved contradiction
// ---------------------------------------------------------------------------
describe("project-state-lww: write-time auto-supersede", () => {
  it("immediately resolves the contradiction when a newer trusted project-state fact is stored", () => {
    const older = storeProjectFact({
      entity: "proj-write-time",
      key: "status",
      value: "in_progress",
      text: "Write-time test: in progress",
      confidence: 1.0,
    });
    const newer = storeProjectFact({
      entity: "proj-write-time",
      key: "status",
      value: "done",
      text: "Write-time test: done",
      confidence: 1.0,
      createdAtOffset: 10,
    });

    // detectContradictions at write time should auto-supersede for project-state facts
    db.detectContradictions(newer.id, "proj-write-time", "status", "done");

    // After write-time auto-supersede, no unresolved contradiction should remain
    const unresolved = db
      .getContradictions()
      .filter((c) => (c.factIdNew === newer.id || c.factIdOld === older.id) && !c.resolved);
    expect(unresolved).toHaveLength(0);

    // Old fact should be marked superseded
    const oldAfter = db.getById(older.id);
    expect(oldAfter?.supersededAt).not.toBeNull();
  });
});
