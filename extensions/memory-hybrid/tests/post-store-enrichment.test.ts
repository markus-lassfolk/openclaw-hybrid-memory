/**
 * Living-memory P2.1/P4.2: universal at-formation enrichment. Facts stored through ANY path
 * (here: bare FactsDB.store, the path auto-capture/distill/reflection/GraphQL share) get
 * auto-links via the factStored bus event; the memory_store tool's inline-linked facts are
 * claimed and skipped (no double-linking); consecutive facts of a session chain PRECEDED_BY.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { parseGraphConfig } from "../config/parsers/features.js";
import {
  claimInlineEnrichment,
  flushPostStoreEnrichmentForTests,
  resetPostStoreEnrichmentForTests,
  wirePostStoreEnrichment,
} from "../services/post-store-enrichment.js";
import { resetMemoryEventBus } from "../services/memory-events.js";

let dir: string;
let db: FactsDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-enrich-"));
  db = new FactsDB(join(dir, "facts.db"));
  resetPostStoreEnrichmentForTests();
  wirePostStoreEnrichment({
    factsDb: db,
    vectorDb: { search: async () => [] } as never, // no embeddings — entity/FTS fallback path
    cfg: { graph: parseGraphConfig({}) },
    logger: { warn: () => {}, info: () => {} },
  });
});

afterEach(() => {
  resetPostStoreEnrichmentForTests();
  resetMemoryEventBus();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function store(text: string, over: Record<string, unknown> = {}) {
  return db.store({
    text,
    entity: null,
    key: null,
    value: null,
    category: "fact",
    importance: 0.6,
    source: "test",
    tags: [],
    ...over,
  } as never);
}

async function settle(): Promise<void> {
  // factStored is emitted via queueMicrotask; give it a beat, then drain the enrichment queue.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await flushPostStoreEnrichmentForTests();
}

describe("universal post-store enrichment", () => {
  it("auto-links facts stored through the bare FactsDB path (entity co-mention linking)", async () => {
    const first = store("Coridan mining output doubled this quarter", { entity: "coridan" });
    await settle();
    const second = store("Coridan is negotiating a new trade route", { entity: "coridan" });
    await settle();

    const links = [...db.getLinksFrom(second.id), ...db.getLinksTo(second.id)];
    expect(links.length).toBeGreaterThan(0);
    const other = links
      .map((l) => ("targetFactId" in l ? l.targetFactId : ""))
      .concat(db.getLinksTo(second.id).map((l) => l.sourceFactId));
    expect(other).toContain(first.id);
  });

  it("skips facts the memory_store tool claimed (inline-linked with its fresh vector)", async () => {
    store("Anchor fact about the vexmoor region", { entity: "vexmoor" });
    await settle();

    const claimed = store("Claimed fact about the vexmoor region", { entity: "vexmoor", provenanceSession: null });
    claimInlineEnrichment(claimed.id);
    // Emit ordering: claim lands before the microtask-deferred factStored handler runs.
    await settle();

    const links = [...db.getLinksFrom(claimed.id), ...db.getLinksTo(claimed.id)];
    expect(links.filter((l) => l.linkType !== "PRECEDED_BY")).toHaveLength(0);
  });

  it("chains PRECEDED_BY edges between consecutive facts of the same session only", async () => {
    const a = store("first thought in session", { provenanceSession: "sess-1" });
    const b = store("second thought in session", { provenanceSession: "sess-1" });
    const c = store("unrelated other-session fact", { provenanceSession: "sess-2" });
    await settle();

    const bLinks = db.getLinksFrom(b.id).filter((l) => l.linkType === "PRECEDED_BY");
    expect(bLinks.map((l) => l.targetFactId)).toEqual([a.id]);
    expect(db.getLinksFrom(c.id).filter((l) => l.linkType === "PRECEDED_BY")).toHaveLength(0);
    expect(db.getLinksFrom(a.id).filter((l) => l.linkType === "PRECEDED_BY")).toHaveLength(0);
  });
});
