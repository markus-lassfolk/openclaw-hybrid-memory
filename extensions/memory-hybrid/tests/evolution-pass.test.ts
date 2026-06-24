/**
 * Evolution pass tests (Issue #1914).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runEvolutionPass } from "../services/evolution-pass.js";

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hm-evolution-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false, storeConfig: {} });
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runEvolutionPass (#1914)", () => {
  it("bumps quality_score for frequently accessed facts", async () => {
    const fact = factsDb.store({
      text: "Frequently recalled deployment checklist",
      category: "pattern",
      importance: 0.6,
      source: "conversation",
    });
    const db = factsDb.getRawDb();
    db.prepare("UPDATE facts SET access_count = 5, quality_score = 0.5 WHERE id = ?").run(fact.id);

    const result = await runEvolutionPass(db, 50);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.evolved).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare("SELECT quality_score, evolution_reason, revision_count FROM facts WHERE id = ?")
      .get(fact.id) as {
      quality_score: number;
      evolution_reason: string;
      revision_count: number;
    };
    expect(row.quality_score).toBeGreaterThan(0.5);
    expect(row.evolution_reason).toContain("access_reinforcement");
    expect(row.revision_count).toBe(0);
  });

  it("skips facts with low access_count", async () => {
    factsDb.store({
      text: "Rarely used note",
      category: "fact",
      importance: 0.5,
      source: "conversation",
    });
    const result = await runEvolutionPass(factsDb.getRawDb(), 50);
    expect(result.evolved).toBe(0);
  });
});
