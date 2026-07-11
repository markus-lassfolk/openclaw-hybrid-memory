import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { graphqlPubSub } from "../routes/graphql-pubsub.js";
import {
  collectLiveStatsSnapshot,
  resetMemoryEventsBridgeForTests,
  wireMemoryEventsToPubSub,
} from "../routes/memory-events-bridge.js";
import { resetMemoryEventBus } from "../services/memory-events.js";

let tmpDir: string;
let db: FactsDB;

const store = (text: string, category = "fact") =>
  db.store({ text, category, source: "conversation", entity: null, key: null, value: null, importance: 0.5 });

type PubSubTopic = Parameters<typeof graphqlPubSub.subscribe>[0];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-bridge-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
  resetMemoryEventsBridgeForTests();
});

afterEach(() => {
  resetMemoryEventsBridgeForTests();
  resetMemoryEventBus();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Collect the first pubsub payload for a topic, or time out. */
async function nextPublished<T>(topic: PubSubTopic, trigger: () => void, timeoutMs = 1000): Promise<T | null> {
  const iterator = graphqlPubSub.subscribe(topic)[Symbol.asyncIterator]();
  // Give the subscription a tick to register before triggering the emit.
  await new Promise((r) => setTimeout(r, 0));
  trigger();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const result = await Promise.race([iterator.next().then((r) => r.value as T), timeout]);
  await iterator.return?.();
  return result;
}

describe("memory-events → graphql pubsub bridge", () => {
  it("republishes a backend factStored as a factCreated pubsub payload", async () => {
    wireMemoryEventsToPubSub(db);
    const payload = await nextPublished<{ fact: { id: string } }>("factCreated", () => {
      store("bridged fact", "fact");
    });
    expect(payload).toBeTruthy();
    expect(payload?.fact?.id).toBeTruthy();
  });

  it("republishes a backend linkCreated as a canonical GraphQL link (weight + createdAt)", async () => {
    const a = store("a", "fact");
    const b = store("b", "fact");
    wireMemoryEventsToPubSub(db);
    const payload = await nextPublished<{ link: Record<string, unknown> }>("linkCreated", () => {
      db.createLink(a.id, b.id, "RELATED_TO", 0.7);
    });
    expect(payload).toBeTruthy();
    // Canonical GraphQL Link shape re-fetched via getLinkById.
    expect(payload?.link?.weight).toBeCloseTo(0.7);
    expect(payload?.link?.createdAt).toBeGreaterThan(0);
    expect(payload?.link?.sourceId).toBe(a.id);
  });
});

describe("collectLiveStatsSnapshot", () => {
  it("returns a MemoryStats-shaped snapshot from cheap aggregate queries", () => {
    store("one", "fact");
    store("two", "preference");
    const snap = collectLiveStatsSnapshot(db);
    expect(snap.totalFacts).toBe(2);
    expect(snap.activeFactsCount).toBe(2);
    expect(Array.isArray(snap.factsByCategory)).toBe(true);
    expect(snap.totalLinks).toBe(0);
  });
});
