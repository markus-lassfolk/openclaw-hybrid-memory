import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { LoomStore } from "../backends/loom-store.js";
import { buildRunway } from "../services/agent-runway.js";

let tmpDir: string;
let factsDb: FactsDB;
let loomStore: LoomStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runway-test-"));
  factsDb = new FactsDB(join(tmpDir, "memory.db"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  factsDb.close();
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildRunway", () => {
  it("empty state: returns a bounded bundle with the memory-is-not-proof warning and no throws", async () => {
    const bundle = await buildRunway({ factsDb, loomStore }, { maxItemsPerSection: 8 });
    expect(bundle.activeTasks).toHaveLength(0);
    expect(bundle.goals).toHaveLength(0);
    expect(bundle.warnings[0]).toContain("Memory is context, not proof");
  });

  it("summarizes an active task from the facts ledger (project category checkpoint facts)", async () => {
    factsDb.store({
      text: "Task forge-99 status: In progress",
      category: "project",
      importance: 0.5,
      source: "conversation",
      entity: "forge-99",
      key: "status",
      value: "In progress",
    });
    factsDb.store({
      text: "Task forge-99 next: ship it",
      category: "project",
      importance: 0.5,
      source: "conversation",
      entity: "forge-99",
      key: "next",
      value: "ship it",
    });
    const bundle = await buildRunway({ factsDb, loomStore }, { maxItemsPerSection: 8 });
    const task = bundle.activeTasks.find((t) => t.label === "forge-99");
    expect(task?.status).toBe("In progress");
    expect(task?.next).toBe("ship it");
    expect(task?.source).toBe("facts_ledger");
  });

  it("warns about stale/contradicted high-importance facts", async () => {
    const a = factsDb.store({
      text: "critical config A",
      category: "fact",
      importance: 0.9,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const b = factsDb.store({
      text: "critical config B",
      category: "fact",
      importance: 0.9,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const db = factsDb.getRawDb();
    db.prepare(
      "INSERT INTO contradictions (id, fact_id_new, fact_id_old, detected_at, resolved) VALUES (?, ?, ?, ?, 0)",
    ).run("c1", b.id, a.id, new Date().toISOString());

    const bundle = await buildRunway({ factsDb, loomStore }, { maxItemsPerSection: 8 });
    expect(bundle.warnings.some((w) => w.includes("stale/contradicted"))).toBe(true);
  });

  it("includes the Loom summary: open loops and must-live-check claims", async () => {
    loomStore.createOpenLoop({ title: "loop 1", loopType: "watch_condition" });
    loomStore.assertClaim({
      entity: "Doris",
      predicate: "id",
      value: "x",
      liveCheckRequired: true,
      liveCheckReason: "why",
    });
    const bundle = await buildRunway({ factsDb, loomStore }, { maxItemsPerSection: 8 });
    expect(bundle.loom.openLoops).toHaveLength(1);
    expect(bundle.loom.mustLiveCheck).toHaveLength(1);
  });

  it("never includes a loom section when loomStore is null", async () => {
    const bundle = await buildRunway({ factsDb, loomStore: null }, { maxItemsPerSection: 8 });
    expect(bundle.loom.openLoops).toHaveLength(0);
    expect(bundle.loom.mustLiveCheck).toHaveLength(0);
  });
});
