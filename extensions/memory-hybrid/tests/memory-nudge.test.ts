import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import {
  _getNudgeTrackedSessionCountForTests,
  buildMemoryNudge,
  DEFAULT_MEMORY_NUDGE_CONFIG,
  isNudgeSuppressed,
  recordNudgeEmission,
  resetNudgeState,
  suppressNudgeForSession,
} from "../services/memory-nudge.js";
import { insertRecallEvent } from "../services/recall-events.js";

const { FactsDB } = _testing;

describe("memory-nudge session eviction", () => {
  beforeEach(() => resetNudgeState());

  it("bounds sessionLastActivity when nudges emit without suppress entries", () => {
    for (let i = 0; i < 250; i++) {
      recordNudgeEmission(`session-${i}`);
    }
    expect(_getNudgeTrackedSessionCountForTests()).toBeLessThanOrEqual(201);
  });
});

describe("evictOldestSession evicts by last-touched order, not insertion order (regression)", () => {
  beforeEach(() => resetNudgeState());

  it("does not evict a session that keeps being touched, even though it was inserted first", () => {
    // session-active is the very first entry -- would be the "oldest by insertion" candidate.
    suppressNudgeForSession("session-active", 1);
    // Fill up to capacity (200) with distinct sessions.
    for (let i = 0; i < 199; i++) {
      recordNudgeEmission(`filler-${i}`);
    }
    expect(_getNudgeTrackedSessionCountForTests()).toBe(200);

    // Re-touch session-active (simulating continued activity) without adding a new session.
    expect(isNudgeSuppressed("session-active")).toBe(true);

    // Admitting one more distinct session forces exactly one eviction.
    recordNudgeEmission("filler-199");

    // session-active was touched most recently of all 200 prior entries -- it must survive;
    // filler-0 (the actual least-recently-touched entry) should be evicted instead.
    expect(isNudgeSuppressed("session-active")).toBe(true);
  });
});

describe("buildMemoryNudge scope filtering (loop iteration 21 regression)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-nudge-scope-"));
    db = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function storeDuplicateFact(scope: "user", scopeTarget: string): void {
    const entry = db.store({
      text: `Duplicate fact for ${scopeTarget} ${Math.random()}`,
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope,
      scopeTarget,
    });
    db.getRawDb().prepare("UPDATE facts SET duplicate_count = 2 WHERE id = ?").run(entry.id);
  }

  it("counts only the caller's own scope, not another tenant's duplicate facts", () => {
    for (let i = 0; i < 3; i++) storeDuplicateFact("user", "alice");
    for (let i = 0; i < 3; i++) storeDuplicateFact("user", "bob");

    const config = {
      ...DEFAULT_MEMORY_NUDGE_CONFIG,
      enabled: true,
      duplicateCandidateThreshold: 3,
      snoozeCandidateThreshold: 999,
      neverReferencedThreshold: 999,
    };

    const nudge = buildMemoryNudge(db.getRawDb(), config, { userId: "alice", agentId: null, sessionId: null });

    expect(nudge?.actions).toHaveLength(1);
    expect(nudge?.actions[0]?.label).toBe("3 facts have near-duplicate observations");
  });

  function storeUnreferencedSurfacedFact(scope: "user", scopeTarget: string, surfaceCount: number): void {
    const entry = db.store({
      text: `Surfaced-but-unused fact for ${scopeTarget} ${Math.random()}`,
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope,
      scopeTarget,
    });
    const raw = db.getRawDb();
    for (let i = 0; i < surfaceCount; i++) {
      insertRecallEvent(raw, { factIds: [entry.id], hit: true, source: "tool", query: `q-${scopeTarget}-${i}` });
    }
  }

  it("counts only the caller's own scope for snooze candidates (loop iteration 61 regression: recall_events has no scope column, but the facts it references do)", () => {
    // Below alice's own threshold alone; only combined with bob's would it cross 4.
    for (let i = 0; i < 2; i++) storeUnreferencedSurfacedFact("user", "alice", 6);
    for (let i = 0; i < 3; i++) storeUnreferencedSurfacedFact("user", "bob", 6);

    const config = {
      ...DEFAULT_MEMORY_NUDGE_CONFIG,
      enabled: true,
      duplicateCandidateThreshold: 999,
      snoozeCandidateThreshold: 4,
      neverReferencedThreshold: 999,
    };

    const nudge = buildMemoryNudge(db.getRawDb(), config, { userId: "alice", agentId: null, sessionId: null });

    expect(nudge).toBeNull();
  });
});
