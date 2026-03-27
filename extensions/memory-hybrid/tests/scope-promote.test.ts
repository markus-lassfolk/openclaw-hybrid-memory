import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rawDb: any; // underlying better-sqlite3 instance for test setup (backdating timestamps)

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "scope-promote-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
  // Access private liveDb getter via any-cast for test setup only
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawDb = (db as any).db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findSessionFactsForPromotion
// ---------------------------------------------------------------------------

describe("FactsDB.findSessionFactsForPromotion", () => {
  it("returns session facts older than threshold with sufficient importance", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 10 * 86400; // 10 days ago

    // Old enough, high enough importance → should be found
    const eligible = db.store({
      text: "Important session fact from long ago",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-old",
    });
    // Backdate created_at to 10 days ago
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, eligible.id);

    // Recent session fact → should NOT be found (only 1 day old, threshold 7 days)
    const recent = db.store({
      text: "Recent session fact",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-new",
    });
    // 1 day ago
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(nowSec - 86400, recent.id);

    const results = db.findSessionFactsForPromotion(7, 0.7);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(eligible.id);
    expect(ids).not.toContain(recent.id);
  });

  it("filters out facts with importance below the threshold", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 10 * 86400;

    const lowImportance = db.store({
      text: "Low importance session fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-low",
    });
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, lowImportance.id);

    const highImportance = db.store({
      text: "High importance session fact",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-high",
    });
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, highImportance.id);

    const results = db.findSessionFactsForPromotion(7, 0.7);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(lowImportance.id);
    expect(ids).toContain(highImportance.id);
  });

  it("does not return non-session-scoped facts", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 10 * 86400;

    const globalFact = db.store({
      text: "Global scoped fact",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
      scopeTarget: null,
    });
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, globalFact.id);

    const sessionFact = db.store({
      text: "Session scoped fact",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-abc",
    });
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, sessionFact.id);

    const results = db.findSessionFactsForPromotion(7, 0.7);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(globalFact.id);
    expect(ids).toContain(sessionFact.id);
  });

  it("returns empty array when no eligible facts exist", () => {
    const results = db.findSessionFactsForPromotion(7, 0.7);
    expect(results).toEqual([]);
  });

  it("respects threshold-days=0 (all session facts with sufficient importance)", () => {
    // With 0 days threshold, even brand-new facts should be found
    const newFact = db.store({
      text: "Brand new session fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-now",
    });

    const results = db.findSessionFactsForPromotion(0, 0.7);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(newFact.id);
  });
});

// ---------------------------------------------------------------------------
// scope promote end-to-end (findSessionFactsForPromotion + promoteScope)
// ---------------------------------------------------------------------------

describe("scope promote end-to-end", () => {
  it("promotes eligible session facts to global scope", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 8 * 86400;

    const fact = db.store({
      text: "Critical session insight",
      category: "fact",
      importance: 0.85,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-xyz",
    });
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, fact.id);

    const candidates = db.findSessionFactsForPromotion(7, 0.7);
    expect(candidates.some((c) => c.id === fact.id)).toBe(true);

    // Verify still session-scoped before promotion
    const beforePromotion = db.getById(fact.id);
    expect(beforePromotion?.scope).toBe("session");

    // Actual promotion
    const ok = db.promoteScope(fact.id, "global", null);
    expect(ok).toBe(true);

    const promoted = db.getById(fact.id);
    expect(promoted?.scope).toBe("global");
    expect(promoted?.scopeTarget).toBeNull();

    // After promotion, the fact should no longer appear in session candidates
    const remaining = db.findSessionFactsForPromotion(7, 0.7);
    expect(remaining.some((c) => c.id === fact.id)).toBe(false);
  });

  it("dry-run leaves facts unchanged", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 10 * 86400;

    const fact = db.store({
      text: "Session fact for dry run test",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-dry",
    });
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, fact.id);

    // Simulate dry-run: query candidates but do NOT call promoteScope
    const candidates = db.findSessionFactsForPromotion(7, 0.7);
    expect(candidates.some((c) => c.id === fact.id)).toBe(true);

    // Verify fact is still session-scoped (nothing was promoted)
    const unchanged = db.getById(fact.id);
    expect(unchanged?.scope).toBe("session");
    expect(unchanged?.scopeTarget).toBe("sess-dry");
  });
});
