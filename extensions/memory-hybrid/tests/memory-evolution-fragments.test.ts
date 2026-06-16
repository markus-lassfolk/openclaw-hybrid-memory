/**
 * Memory evolution + fragment embedding tests (#1914).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import { runMemoryEvolutionPass } from "../services/memory-evolution.js";
import { indexFactFragments } from "../services/fragment-embedding.js";
import { _resetWalCircuitBreakerForTesting, walWrite } from "../services/wal-helpers.js";
import type { WriteAheadLog } from "../backends/wal.js";
import { vi } from "vitest";

vi.mock("../services/adaptive-maintenance-llm.js", () => ({
  chatCompleteWithAdaptiveMaintenanceRetry: vi.fn(async () => ({
    content: JSON.stringify({ tags: ["authentication", "oauth"], summary: "OAuth gateway authentication context" }),
    model: "gpt-4o-mini",
    attempts: 1,
  })),
}));

describe("runMemoryEvolutionPass (#1914)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-mem-evo-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false, storeConfig: {} });
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates neighbor tags from recent links when enabled", async () => {
    const db = factsDb.getRawDb();
    const a = factsDb.store({
      text: "Authentication service uses OAuth gateway tokens",
      category: "fact",
      importance: 0.7,
      source: "conversation",
    });
    const b = factsDb.store({
      text: "Unrelated deployment checklist",
      category: "fact",
      importance: 0.5,
      source: "conversation",
      tags: ["ops"],
    });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at)
       VALUES (?, ?, ?, 'RELATED', 1.0, ?)`,
    ).run("link-1", a.id, b.id, now);

    const result = await runMemoryEvolutionPass(db, {
      enabled: true,
      maxNeighborsPerFact: 5,
      dailyLlmCallCap: 50,
      mode: "heuristic",
    });
    expect(result.neighborsUpdated).toBeGreaterThanOrEqual(1);

    const row = db.prepare("SELECT tags, evolution_reason FROM facts WHERE id = ?").get(b.id) as {
      tags: string;
      evolution_reason: string;
    };
    expect(row.evolution_reason).toContain("neighbor_evolution");
    expect(row.tags).toContain("authentication");
  });

  it("no-ops when evolution disabled", async () => {
    const result = await runMemoryEvolutionPass(factsDb.getRawDb(), {
      enabled: false,
      maxNeighborsPerFact: 5,
      dailyLlmCallCap: 50,
      mode: "heuristic",
    });
    expect(result.neighborsUpdated).toBe(0);
  });

  it("uses nano LLM when mode=llm", async () => {
    const db = factsDb.getRawDb();
    const a = factsDb.store({
      text: "Authentication service uses OAuth gateway tokens",
      category: "fact",
      importance: 0.7,
      source: "conversation",
    });
    const b = factsDb.store({
      text: "Unrelated deployment checklist",
      category: "fact",
      importance: 0.5,
      source: "conversation",
      tags: ["ops"],
    });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at)
       VALUES (?, ?, ?, 'RELATED', 1.0, ?)`,
    ).run("link-llm", a.id, b.id, now);

    const result = await runMemoryEvolutionPass(
      db,
      {
        enabled: true,
        maxNeighborsPerFact: 5,
        dailyLlmCallCap: 50,
        mode: "llm",
      },
      {
        openai: {} as never,
        model: "test/nano",
        fallbackModels: [],
      },
    );
    expect(result.llmCalls).toBeGreaterThan(0);
    expect(result.neighborsUpdated).toBeGreaterThanOrEqual(1);
    const row = db.prepare("SELECT evolution_reason, tags FROM facts WHERE id = ?").get(b.id) as {
      evolution_reason: string;
      tags: string;
    };
    expect(row.evolution_reason).toContain(":llm");
    expect(row.tags).toContain("oauth");
  });
});

describe("indexFactFragments (#1914)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let vectorDb: VectorDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-frag-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false, storeConfig: {} });
    vectorDb = new VectorDB(join(tmpDir, "facts.lance"), 4, false);
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores fragment children for long markdown parents", async () => {
    const longBody = `${"## Section One\n\nParagraph about hybrid memory retrieval.\n\n".repeat(40)}## Section Two\n\nMore operational detail.`;
    const parent = factsDb.store({
      text: longBody,
      category: "fact",
      importance: 0.7,
      source: "conversation",
    });

    const result = await indexFactFragments({
      factsDb,
      vectorDb,
      embeddings: { embed: async () => [0.1, 0.2, 0.3, 0.4], modelName: "test" },
      parentFact: parent,
      cfg: { enabled: true, minChars: 500 },
    });

    expect(result.fragmentsStored).toBeGreaterThan(1);
    const childCount = factsDb.getRawDb().prepare("SELECT COUNT(*) AS c FROM facts WHERE parent_fact_id = ?").get(parent.id) as {
      c: number;
    };
    expect(childCount.c).toBeGreaterThan(1);
  });
});

describe("wal circuit breaker per path (#1917)", () => {
  beforeEach(() => {
    _resetWalCircuitBreakerForTesting();
  });

  it("isolates failure counts per WAL path", async () => {
    const logger = { warn: vi.fn() };
    const pathA = join(homedir(), `.hm-wal-a-${Date.now()}.wal`);
    const pathB = join(homedir(), `.hm-wal-b-${Date.now()}.wal`);
    const walA = {
      write: vi.fn().mockRejectedValue(new Error("fail-a")),
      getPath: () => pathA,
    } as unknown as WriteAheadLog;
    const walB = {
      write: vi.fn().mockResolvedValue(undefined),
      getPath: () => pathB,
    } as unknown as WriteAheadLog;

    for (let i = 0; i < 10; i++) {
      await walWrite(walA, "store", { text: "x" }, logger);
    }
    expect(await walWrite(walA, "store", { text: "x" }, logger)).toBeNull();

    const idB = await walWrite(walB, "store", { text: "ok" }, logger);
    expect(typeof idB).toBe("string");
    expect(walB.write).toHaveBeenCalled();
  });
});
