/**
 * Living-memory P4.1: affect back-stamping. Frustration signals (already persisted per session by
 * stage-frustration) stamp a −1..1 valence onto facts formed in the same session window; existing
 * valences are never overwritten; facts outside the window or session stay unstamped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runAffectStamp } from "../services/affect-stamping.js";

let dir: string;
let db: FactsDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-affect-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function storeFact(text: string, session: string | null): string {
  const id = db.store({
    text,
    entity: null,
    key: null,
    value: null,
    category: "fact",
    importance: 0.5,
    source: "test",
    tags: [],
    provenanceSession: session,
  } as never).id;
  return id;
}

function signal(session: string, polarity: "negative" | "positive", confidence: number, atSec: number): void {
  db.getRawDb()
    .prepare(
      `INSERT INTO implicit_signals (session_file, signal_type, confidence, polarity, source, created_at)
       VALUES (?, 'explicit_frustration', ?, ?, 'frustration', ?)`,
    )
    .run(session, confidence, polarity, atSec);
}

describe("affect back-stamping", () => {
  it("stamps session-window facts with confidence-weighted valence; leaves others alone", () => {
    const now = Math.floor(Date.now() / 1000);
    const inSession = storeFact("fact formed during the frustrating session", "sess-A");
    const otherSession = storeFact("fact from a calm session", "sess-B");
    const noSession = storeFact("fact with no provenance", null);
    signal("sess-A", "negative", 0.8, now);
    signal("sess-A", "negative", 0.6, now + 60);

    const r = runAffectStamp(db.getRawDb(), { nowSec: now + 120 });

    expect(r.sessionsSeen).toBe(1);
    expect(r.factsStamped).toBe(1);
    const row = (id: string) =>
      db.getRawDb().prepare("SELECT valence, affect_source FROM facts WHERE id = ?").get(id) as {
        valence: number | null;
        affect_source: string | null;
      };
    expect(row(inSession).valence).toBeCloseTo(-0.7, 5); // mean(-0.8, -0.6)
    expect(row(inSession).affect_source).toBe("frustration-detector");
    expect(row(otherSession).valence).toBeNull();
    expect(row(noSession).valence).toBeNull();
  });

  it("never overwrites an existing valence and mixes polarities toward the mean", () => {
    const now = Math.floor(Date.now() / 1000);
    const preStamped = storeFact("already stamped", "sess-C");
    db.getRawDb().prepare("UPDATE facts SET valence = 0.9, affect_source = 'manual' WHERE id = ?").run(preStamped);
    const fresh = storeFact("fresh fact in mixed session", "sess-C");
    signal("sess-C", "negative", 0.9, now);
    signal("sess-C", "positive", 0.3, now + 30);

    runAffectStamp(db.getRawDb(), { nowSec: now + 60 });

    const row = (id: string) =>
      db.getRawDb().prepare("SELECT valence FROM facts WHERE id = ?").get(id) as { valence: number | null };
    expect(row(preStamped).valence).toBeCloseTo(0.9);
    expect(row(fresh).valence).toBeCloseTo((-0.9 + 0.3) / 2, 5);
  });
});
