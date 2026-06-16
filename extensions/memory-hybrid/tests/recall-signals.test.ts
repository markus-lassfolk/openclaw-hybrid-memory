import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { insertRecallEvent } from "../services/recall-events.js";
import {
  aggregateRecallStats,
  getSnoozeCandidates,
  isNeverReferencedCandidate,
} from "../services/recall-signals.js";

const { FactsDB } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "recall-signals-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("aggregateRecallStats referenceCount", () => {
  it("loads access_count from facts as referenceCount", () => {
    const fact = db.store({
      text: "Gateway timeout is 30s",
      category: "fact",
      importance: 0.7,
      source: "conversation",
    });
    const raw = db.getRawDb();
    for (let i = 0; i < 6; i++) {
      insertRecallEvent(raw, {
        factIds: [fact.id],
        hit: true,
        source: "tool",
        query: `query-${i}`,
      });
    }
    db.refreshAccessedFacts([fact.id]);
    db.refreshAccessedFacts([fact.id]);

    const stats = aggregateRecallStats(raw, 30);
    const s = stats.get(fact.id);
    expect(s?.surfaceCount).toBe(6);
    expect(s?.referenceCount).toBe(2);
    expect(isNeverReferencedCandidate(s!.surfaceCount, s!.referenceCount, 5)).toBe(false);
  });

  it("treats facts with zero access_count as never referenced", () => {
    const fact = db.store({
      text: "Unused surfaced fact",
      category: "fact",
      importance: 0.5,
      source: "conversation",
    });
    const raw = db.getRawDb();
    for (let i = 0; i < 6; i++) {
      insertRecallEvent(raw, {
        factIds: [fact.id],
        hit: true,
        source: "auto-recall",
        query: `auto-${i}`,
      });
    }

    const stats = aggregateRecallStats(raw, 30);
    const s = stats.get(fact.id);
    expect(s?.referenceCount).toBe(0);
    expect(isNeverReferencedCandidate(s!.surfaceCount, s!.referenceCount, 5)).toBe(true);
  });
});

describe("getSnoozeCandidates", () => {
  it("excludes facts that were accessed after being surfaced", () => {
    const fact = db.store({
      text: "Important fact the agent actually used",
      category: "fact",
      importance: 0.8,
      source: "conversation",
    });
    const raw = db.getRawDb();
    for (let i = 0; i < 6; i++) {
      insertRecallEvent(raw, {
        factIds: [fact.id],
        hit: true,
        source: "tool",
        query: `q-${i}`,
      });
    }
    expect(getSnoozeCandidates(raw)).toContain(fact.id);

    db.refreshAccessedFacts([fact.id]);
    expect(getSnoozeCandidates(raw)).not.toContain(fact.id);
  });
});
