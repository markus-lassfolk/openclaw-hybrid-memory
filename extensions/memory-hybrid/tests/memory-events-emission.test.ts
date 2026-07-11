import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { type MemoryEventMap, onMemoryEvent, resetMemoryEventBus } from "../services/memory-events.js";
import { recordRecallEvent } from "../services/recall-events.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let tmpDir: string;
let db: FactsDB;

/** Store a fact with all required StoreFactInput fields (defaults for the ones we don't care about). */
const store = (text: string, category = "fact") =>
  db.store({ text, category, source: "conversation", entity: null, key: null, value: null, importance: 0.5 });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-events-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  resetMemoryEventBus();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("FactsDB write paths emit memory events", () => {
  it("emits factStored on a new store (single choke point for all store paths)", async () => {
    const events: Array<MemoryEventMap["factStored"]> = [];
    onMemoryEvent("factStored", (e) => events.push(e));

    const entry = store("User likes dark mode", "preference");
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].entry.id).toBe(entry.id);
    expect(events[0].entry.category).toBe("preference");
  });

  it("emits factDeleted with scope/category captured before deletion", async () => {
    const entry = store("ephemeral note", "fact");
    const events: Array<MemoryEventMap["factDeleted"]> = [];
    onMemoryEvent("factDeleted", (e) => events.push(e));

    db.delete(entry.id);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(entry.id);
    expect(events[0].category).toBe("fact");
  });

  it("emits factUpdated when a fact is superseded", async () => {
    const oldFact = store("old value", "fact");
    const newFact = store("new value", "fact");
    const events: Array<MemoryEventMap["factUpdated"]> = [];
    onMemoryEvent("factUpdated", (e) => events.push(e));

    db.supersede(oldFact.id, newFact.id);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].entry.id).toBe(oldFact.id);
    expect(events[0].entry.supersededBy).toBe(newFact.id);
  });

  it("emits linkCreated on createLink", async () => {
    const a = store("fact a", "fact");
    const b = store("fact b", "fact");
    const events: Array<MemoryEventMap["linkCreated"]> = [];
    onMemoryEvent("linkCreated", (e) => events.push(e));

    db.createLink(a.id, b.id, "RELATED_TO", 0.8);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].link.sourceId).toBe(a.id);
    expect(events[0].link.targetId).toBe(b.id);
    expect(events[0].link.strength).toBeCloseTo(0.8);
  });

  it("emits linkUpdated when a Hebbian RELATED_TO edge is strengthened (not re-created)", async () => {
    const a = store("fact a", "fact");
    const b = store("fact b", "fact");
    const created: Array<MemoryEventMap["linkCreated"]> = [];
    const updated: Array<MemoryEventMap["linkUpdated"]> = [];
    onMemoryEvent("linkCreated", (e) => created.push(e));
    onMemoryEvent("linkUpdated", (e) => updated.push(e));

    db.createOrStrengthenRelatedLink(a.id, b.id, 0.3); // first: creates
    db.createOrStrengthenRelatedLink(a.id, b.id, 0.3); // second: strengthens
    await flush();

    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].link.strength).toBeCloseTo(0.6);
  });

  it("a throwing subscriber never breaks the store", async () => {
    onMemoryEvent("factStored", () => {
      throw new Error("bad subscriber");
    });
    expect(() => store("still stored", "fact")).not.toThrow();
    await flush();
    // The fact was persisted despite the subscriber throwing.
    const rows = db.getRawDb().prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe("recordRecallEvent", () => {
  it("persists scores and emits recallOccurred with per-fact scores", async () => {
    const a = store("fact a", "fact");
    const b = store("fact b", "fact");
    const events: Array<MemoryEventMap["recallOccurred"]> = [];
    onMemoryEvent("recallOccurred", (e) => events.push(e));

    recordRecallEvent(db.getRawDb(), {
      query: "dark mode",
      source: "tool",
      sessionKey: "s1",
      agentId: "agent-1",
      factIds: [a.id, b.id],
      hit: true,
      scores: { [a.id]: 0.91, [b.id]: 0.42 },
    });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("tool");
    const byId = new Map(events[0].hits.map((h) => [h.factId, h.score]));
    expect(byId.get(a.id)).toBeCloseTo(0.91);
    expect(byId.get(b.id)).toBeCloseTo(0.42);

    // Scores were persisted on the row.
    const row = db.getRawDb().prepare("SELECT scores FROM recall_events LIMIT 1").get() as { scores: string | null };
    expect(row.scores).toBeTruthy();
    const parsed = JSON.parse(row.scores as string) as Record<string, number>;
    expect(parsed[a.id]).toBeCloseTo(0.91);
  });
});
