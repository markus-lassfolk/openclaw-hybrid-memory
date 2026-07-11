/**
 * runFactsPruneStep is the single prune implementation consumed by BOTH the CLI and plugin-cycle
 * maintenance runners (they had drifted: the CLI variant skipped decayConfidence entirely, so
 * CLI-triggered maintenance never applied confidence decay). This pins the shared semantics:
 * TTL hard-prune + confidence decay + vector cleanup for every deleted id from both causes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runFactsPruneStep } from "../services/prune-step.js";

let dir: string;
let db: FactsDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-prune-step-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function storeFact(text: string): string {
  return db.store({
    text,
    entity: null,
    key: null,
    value: null,
    category: "other",
    importance: 0.5,
    source: "test",
    tags: [],
  }).id;
}

/** Minimal VectorDB stand-in that records which fact ids were cleaned up. */
function makeVectorDb() {
  const deleted: string[] = [];
  return {
    deleted,
    vectorDb: {
      delete: async (id: string) => {
        deleted.push(id);
      },
    } as never,
  };
}

describe("runFactsPruneStep (shared CLI/plugin prune semantics)", () => {
  it("hard-prunes expired facts AND decays confidence in one step, cleaning vectors for both", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = storeFact("expired fact");
    const lowConfidence = storeFact("rock-bottom confidence fact");
    const healthy = storeFact("healthy fact");
    db.getRawDb()
      .prepare("UPDATE facts SET expires_at = ? WHERE id = ?")
      .run(nowSec - 3600, expired);
    db.getRawDb().prepare("UPDATE facts SET confidence = 0.05 WHERE id = ?").run(lowConfidence);

    const { deleted, vectorDb } = makeVectorDb();
    const outcome = await runFactsPruneStep(db, vectorDb, { nowSec });

    expect(outcome.expired).toBe(1);
    // decayConfidence's floor-delete removed the low-confidence fact (its id was captured for
    // vector cleanup via listFactIdsToBeDeletedByDecayRun BEFORE the delete ran).
    expect(deleted.sort()).toEqual([expired, lowConfidence].sort());
    expect(outcome.vectorFailures).toBe(0);

    const remaining = db.getRawDb().prepare("SELECT id FROM facts").all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual([healthy]);
  });

  it("cliff mode preserves the legacy 75%-window halving as the escape hatch", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const decaying = storeFact("deep in TTL window");
    db.getRawDb()
      .prepare("UPDATE facts SET last_confirmed_at = ?, expires_at = ?, confidence = 0.8 WHERE id = ?")
      .run(nowSec - 90, nowSec + 10, decaying);

    const { vectorDb } = makeVectorDb();
    const outcome = await runFactsPruneStep(db, vectorDb, { nowSec, decayMode: "cliff" });

    expect(outcome.decayed).toBe(1);
    const row = db.getRawDb().prepare("SELECT confidence FROM facts WHERE id = ?").get(decaying) as {
      confidence: number;
    };
    expect(row.confidence).toBeCloseTo(0.4);
  });

  it("default mode is the half-life curve (no cliff halving inside the TTL window)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const decaying = storeFact("deep in TTL window but freshly decay-anchored");
    db.getRawDb()
      .prepare(
        "UPDATE facts SET last_confirmed_at = ?, expires_at = ?, confidence = 0.8, last_decay_at = ? WHERE id = ?",
      )
      .run(nowSec - 90, nowSec + 10, nowSec - 60, decaying);

    const { vectorDb } = makeVectorDb();
    const outcome = await runFactsPruneStep(db, vectorDb, { nowSec });

    // Sub-6h delta since the decay anchor → the curve leaves confidence untouched, where the
    // cliff would have halved it (the 75%-of-TTL condition holds above).
    expect(outcome.decayed).toBe(0);
    const row = db.getRawDb().prepare("SELECT confidence FROM facts WHERE id = ?").get(decaying) as {
      confidence: number;
    };
    expect(row.confidence).toBeCloseTo(0.8);
  });
});
