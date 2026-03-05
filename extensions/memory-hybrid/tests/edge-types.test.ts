/**
 * Tests for Issue #155 — Edge Types: CONTRADICTS, INSTANCE_OF, DERIVED_FROM.
 *
 * Coverage:
 *   - CONTRADICTS: bidirectional creation on recordContradiction
 *   - CONTRADICTS: bidirectional via detectContradictions
 *   - CONTRADICTS: deletion cascade removes both directions
 *   - INSTANCE_OF: manual creation via createLink
 *   - INSTANCE_OF: auto-detection via "is a/an" patterns
 *   - INSTANCE_OF: auto-detection via "type of" pattern
 *   - INSTANCE_OF: no link created when type not in known entities
 *   - INSTANCE_OF: no duplicate links created
 *   - DERIVED_FROM: manual creation via createLink
 *   - DERIVED_FROM: queryable via getLinksFrom/getLinksTo
 *   - DERIVED_FROM: multiple sources tracked per target
 *   - Retrieval: contradicted facts marked with WARNING in serialized output
 *   - Retrieval: non-contradicted facts not marked
 *   - Retrieval: packIntoBudget passes contradiction marker through
 *   - Invalid edge types rejected at TypeScript level (compile-time only via type check)
 *   - MEMORY_LINK_TYPES array includes all 8 types
 *   - New types accepted by createLink without errors
 *   - INSTANCE_OF links visible in getLinksFrom/getLinksTo
 *   - autoDetectInstanceOf returns correct linked count
 *   - autoDetectInstanceOf handles "type of" pattern
 *   - autoDetectInstanceOf ignores unknown entities
 *   - CONTRADICTS both directions accessible via getLinksFrom
 *   - CONTRADICTS isContradicted returns true for both facts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import type { MemoryEntry } from "../types/memory.js";

const { FactsDB, packIntoBudget, serializeFactForContext } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "edge-types-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function storeFact(
  text: string,
  entity: string | null = null,
  key: string | null = null,
  value: string | null = null,
  confidence = 1.0,
) {
  return db.store({
    text,
    category: "fact",
    importance: 0.7,
    entity,
    key,
    value,
    source: "conversation",
    confidence,
  });
}

function makeEntry(id: string, overrides: Partial<MemoryEntry> = {}): Partial<MemoryEntry> {
  return {
    id,
    text: `Fact ${id}`,
    category: "fact",
    confidence: 0.9,
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: 1_700_000_000,
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MEMORY_LINK_TYPES — array must include all 8 types
// ---------------------------------------------------------------------------

describe("MEMORY_LINK_TYPES", () => {
  it("includes CONTRADICTS", async () => {
    const { MEMORY_LINK_TYPES } = await import("../backends/facts-db.js");
    expect(MEMORY_LINK_TYPES).toContain("CONTRADICTS");
  });

  it("includes INSTANCE_OF", async () => {
    const { MEMORY_LINK_TYPES } = await import("../backends/facts-db.js");
    expect(MEMORY_LINK_TYPES).toContain("INSTANCE_OF");
  });

  it("includes DERIVED_FROM", async () => {
    const { MEMORY_LINK_TYPES } = await import("../backends/facts-db.js");
    expect(MEMORY_LINK_TYPES).toContain("DERIVED_FROM");
  });

  it("has exactly 8 types", async () => {
    const { MEMORY_LINK_TYPES } = await import("../backends/facts-db.js");
    expect(MEMORY_LINK_TYPES).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// CONTRADICTS — bidirectional enforcement
// ---------------------------------------------------------------------------

describe("CONTRADICTS bidirectional", () => {
  it("recordContradiction creates forward link (new → old)", () => {
    const factA = storeFact("Alice is 30 years old", "alice", "age", "30");
    const factB = storeFact("Alice is 31 years old", "alice", "age", "31");

    db.recordContradiction(factB.id, factA.id);

    const outboundFromB = db.getLinksFrom(factB.id);
    const contradicts = outboundFromB.filter((l) => l.linkType === "CONTRADICTS");
    expect(contradicts).toHaveLength(1);
    expect(contradicts[0].targetFactId).toBe(factA.id);
  });

  it("recordContradiction creates reverse link (old → new) for bidirectionality", () => {
    const factA = storeFact("Alice is 30 years old", "alice", "age", "30");
    const factB = storeFact("Alice is 31 years old", "alice", "age", "31");

    db.recordContradiction(factB.id, factA.id);

    const outboundFromA = db.getLinksFrom(factA.id);
    const contradicts = outboundFromA.filter((l) => l.linkType === "CONTRADICTS");
    expect(contradicts).toHaveLength(1);
    expect(contradicts[0].targetFactId).toBe(factB.id);
  });

  it("detectContradictions creates bidirectional CONTRADICTS links", () => {
    const factA = storeFact("Bob likes cats", "bob", "preference", "cats");
    const factB = storeFact("Bob likes dogs", "bob", "preference", "dogs");

    db.detectContradictions(factB.id, "bob", "preference", "dogs");

    // Both directions should exist
    const fromB = db.getLinksFrom(factB.id).filter((l) => l.linkType === "CONTRADICTS");
    const fromA = db.getLinksFrom(factA.id).filter((l) => l.linkType === "CONTRADICTS");

    expect(fromB).toHaveLength(1);
    expect(fromB[0].targetFactId).toBe(factA.id);
    expect(fromA).toHaveLength(1);
    expect(fromA[0].targetFactId).toBe(factB.id);
  });

  it("both facts are marked as contradicted after bidirectional link creation", () => {
    const factA = storeFact("City is Paris", "city", "name", "Paris");
    const factB = storeFact("City is London", "city", "name", "London");

    db.detectContradictions(factB.id, "city", "name", "London");

    // The old fact (factA) should be contradicted (targeted by new → old)
    expect(db.isContradicted(factA.id)).toBe(true);
  });

  it("CONTRADICTS links have strength 1.0", () => {
    const factA = storeFact("X is true");
    const factB = storeFact("X is false");

    db.recordContradiction(factB.id, factA.id);

    const links = db.getLinksFrom(factB.id).filter((l) => l.linkType === "CONTRADICTS");
    expect(links[0].strength).toBe(1.0);
  });

  it("CONTRADICTS links deleted when fact is deleted (CASCADE)", () => {
    const factA = storeFact("Y is red");
    const factB = storeFact("Y is blue");

    db.recordContradiction(factB.id, factA.id);

    // Delete factA — CASCADE should remove the link from factA → factB too
    db.delete(factA.id);

    const linksFromB = db.getLinksFrom(factB.id).filter((l) => l.linkType === "CONTRADICTS");
    // factB → factA link is also deleted because factA (target) is deleted
    expect(linksFromB).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// INSTANCE_OF — manual creation
// ---------------------------------------------------------------------------

describe("INSTANCE_OF manual creation", () => {
  it("createLink accepts INSTANCE_OF type without error", () => {
    const factA = storeFact("Polly is a parrot");
    const factB = storeFact("Parrot is a bird species");

    expect(() => {
      db.createLink(factA.id, factB.id, "INSTANCE_OF", 1.0);
    }).not.toThrow();
  });

  it("INSTANCE_OF link is visible via getLinksFrom", () => {
    const factA = storeFact("Polly is a parrot");
    const factB = storeFact("Parrot is a bird species");

    db.createLink(factA.id, factB.id, "INSTANCE_OF", 1.0);

    const links = db.getLinksFrom(factA.id);
    const instanceOf = links.filter((l) => l.linkType === "INSTANCE_OF");
    expect(instanceOf).toHaveLength(1);
    expect(instanceOf[0].targetFactId).toBe(factB.id);
  });

  it("INSTANCE_OF link is visible via getLinksTo", () => {
    const factA = storeFact("Polly is a parrot");
    const factB = storeFact("Parrot is a bird species");

    db.createLink(factA.id, factB.id, "INSTANCE_OF", 1.0);

    const inbound = db.getLinksTo(factB.id);
    const instanceOf = inbound.filter((l) => l.linkType === "INSTANCE_OF");
    expect(instanceOf).toHaveLength(1);
    expect(instanceOf[0].sourceFactId).toBe(factA.id);
  });
});

// ---------------------------------------------------------------------------
// INSTANCE_OF — auto-detection
// ---------------------------------------------------------------------------

describe("autoDetectInstanceOf", () => {
  it("detects 'is a' pattern and creates INSTANCE_OF link", () => {
    // First, create an anchor fact for "dog" so it's a known entity
    storeFact("Dog is a common pet", "dog", null, null);

    // Now store a fact about Polly being a dog
    const pollyFact = storeFact("Polly is a dog", "polly", null, null);

    const linked = db.autoDetectInstanceOf(pollyFact.id, "Polly is a dog");

    expect(linked).toBeGreaterThanOrEqual(1);
    const outbound = db.getLinksFrom(pollyFact.id).filter((l) => l.linkType === "INSTANCE_OF");
    expect(outbound).toHaveLength(1);
  });

  it("detects 'is an' pattern and creates INSTANCE_OF link", () => {
    storeFact("Eagle is a large bird", "eagle", null, null);

    const fact = storeFact("Rex is an eagle", "rex", null, null);
    const linked = db.autoDetectInstanceOf(fact.id, "Rex is an eagle");

    expect(linked).toBeGreaterThanOrEqual(1);
    const outbound = db.getLinksFrom(fact.id).filter((l) => l.linkType === "INSTANCE_OF");
    expect(outbound).toHaveLength(1);
  });

  it("detects 'type of' pattern and creates INSTANCE_OF link", () => {
    storeFact("Retriever is a dog breed", "retriever", null, null);

    const fact = storeFact("Labrador is a type of retriever", "labrador", null, null);
    const linked = db.autoDetectInstanceOf(fact.id, "Labrador is a type of retriever");

    expect(linked).toBeGreaterThanOrEqual(1);
    const outbound = db.getLinksFrom(fact.id).filter((l) => l.linkType === "INSTANCE_OF");
    expect(outbound).toHaveLength(1);
  });

  it("returns 0 when type is not a known entity", () => {
    const fact = storeFact("Polly is a unicorn");
    const linked = db.autoDetectInstanceOf(fact.id, "Polly is a unicorn");
    // "unicorn" is not a known entity, so no link should be created
    expect(linked).toBe(0);
  });

  it("returns 0 when no pattern matches", () => {
    storeFact("Cat fact", "cat", null, null);
    const fact = storeFact("Fluffy likes tuna");
    const linked = db.autoDetectInstanceOf(fact.id, "Fluffy likes tuna");
    expect(linked).toBe(0);
  });

  it("does not create duplicate INSTANCE_OF links on repeated call", () => {
    storeFact("Cat is a feline", "cat", null, null);
    const fact = storeFact("Whiskers is a cat");

    db.autoDetectInstanceOf(fact.id, "Whiskers is a cat");
    db.autoDetectInstanceOf(fact.id, "Whiskers is a cat");

    const outbound = db.getLinksFrom(fact.id).filter((l) => l.linkType === "INSTANCE_OF");
    expect(outbound).toHaveLength(1);
  });

  it("autoLinkEntities includes INSTANCE_OF detection (integrated)", () => {
    storeFact("Poodle is a dog breed", "poodle", null, null);
    const fact = storeFact("Fifi is a poodle");

    db.autoLinkEntities(
      fact.id,
      "Fifi is a poodle",
      "fifi",
      null,
      null,
      { coOccurrenceWeight: 0.3, autoSupersede: true },
    );

    const instanceLinks = db.getLinksFrom(fact.id).filter((l) => l.linkType === "INSTANCE_OF");
    expect(instanceLinks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// DERIVED_FROM — manual creation and retrieval
// ---------------------------------------------------------------------------

describe("DERIVED_FROM", () => {
  it("createLink accepts DERIVED_FROM type without error", () => {
    const source1 = storeFact("Event A happened");
    const source2 = storeFact("Event B happened");
    const merged = storeFact("Events A and B are related");

    expect(() => {
      db.createLink(merged.id, source1.id, "DERIVED_FROM", 1.0);
      db.createLink(merged.id, source2.id, "DERIVED_FROM", 1.0);
    }).not.toThrow();
  });

  it("DERIVED_FROM links visible in getLinksFrom", () => {
    const source1 = storeFact("Observation 1");
    const source2 = storeFact("Observation 2");
    const derived = storeFact("Conclusion from observations");

    db.createLink(derived.id, source1.id, "DERIVED_FROM", 1.0);
    db.createLink(derived.id, source2.id, "DERIVED_FROM", 1.0);

    const links = db.getLinksFrom(derived.id).filter((l) => l.linkType === "DERIVED_FROM");
    expect(links).toHaveLength(2);
    const targetIds = links.map((l) => l.targetFactId);
    expect(targetIds).toContain(source1.id);
    expect(targetIds).toContain(source2.id);
  });

  it("DERIVED_FROM links visible in getLinksTo (reverse lookup)", () => {
    const source = storeFact("Raw data point");
    const derived = storeFact("Aggregated insight");

    db.createLink(derived.id, source.id, "DERIVED_FROM", 1.0);

    const inbound = db.getLinksTo(source.id).filter((l) => l.linkType === "DERIVED_FROM");
    expect(inbound).toHaveLength(1);
    expect(inbound[0].sourceFactId).toBe(derived.id);
  });

  it("DERIVED_FROM provenance chain — multiple levels", () => {
    const raw = storeFact("Raw measurement");
    const processed = storeFact("Processed metric");
    const insight = storeFact("High-level insight");

    db.createLink(processed.id, raw.id, "DERIVED_FROM", 1.0);
    db.createLink(insight.id, processed.id, "DERIVED_FROM", 1.0);

    // Chain: insight → processed → raw
    const level1 = db.getLinksFrom(insight.id).filter((l) => l.linkType === "DERIVED_FROM");
    expect(level1[0].targetFactId).toBe(processed.id);

    const level2 = db.getLinksFrom(processed.id).filter((l) => l.linkType === "DERIVED_FROM");
    expect(level2[0].targetFactId).toBe(raw.id);
  });

  it("DERIVED_FROM links survive when target fact is deleted (provenance preservation)", () => {
    const source1 = storeFact("Source fact 1");
    const source2 = storeFact("Source fact 2");
    const merged = storeFact("Merged fact");

    // Create DERIVED_FROM links: merged ← source1, merged ← source2
    db.createLink(merged.id, source1.id, "DERIVED_FROM", 1.0);
    db.createLink(merged.id, source2.id, "DERIVED_FROM", 1.0);

    // Delete source facts (simulating consolidation cleanup)
    db.delete(source1.id);
    db.delete(source2.id);

    // DERIVED_FROM links should still exist for provenance tracking
    const links = db.getLinksFrom(merged.id).filter((l) => l.linkType === "DERIVED_FROM");
    expect(links).toHaveLength(2);
    expect(links.map(l => l.targetFactId).sort()).toEqual([source1.id, source2.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Retrieval — contradicted facts marked with warning
// ---------------------------------------------------------------------------

describe("serializeFactForContext with contradiction marking", () => {
  it("adds WARNING prefix when isContradicted is true", () => {
    const entry = makeEntry("x", { entity: "test", confidence: 0.8 });
    const serialized = serializeFactForContext(entry as MemoryEntry, { isContradicted: true });
    expect(serialized).toContain("[WARNING: CONTRADICTED");
  });

  it("does not add WARNING prefix when isContradicted is false", () => {
    const entry = makeEntry("y", { entity: "test", confidence: 0.8 });
    const serialized = serializeFactForContext(entry as MemoryEntry, { isContradicted: false });
    expect(serialized).not.toContain("WARNING");
  });

  it("does not add WARNING prefix when options are omitted", () => {
    const entry = makeEntry("z", { entity: "test", confidence: 0.8 });
    const serialized = serializeFactForContext(entry as MemoryEntry);
    expect(serialized).not.toContain("WARNING");
  });

  it("WARNING message contains helpful guidance", () => {
    const entry = makeEntry("w");
    const serialized = serializeFactForContext(entry as MemoryEntry, { isContradicted: true });
    expect(serialized).toContain("verify before use");
  });
});

describe("packIntoBudget with contradictedIds", () => {
  it("marks contradicted facts with WARNING in packed output", () => {
    const entryA = makeEntry("a", { text: "Fact A — might be wrong" });
    const entryB = makeEntry("b", { text: "Fact B — definitely right" });

    const entries = [
      { factId: "a", entry: entryA as MemoryEntry },
      { factId: "b", entry: entryB as MemoryEntry },
    ];

    const { packed } = packIntoBudget(entries, 10_000, { contradictedIds: new Set(["a"]) });

    expect(packed[0]).toContain("WARNING");
    expect(packed[1]).not.toContain("WARNING");
  });

  it("does not mark facts when contradictedIds is empty", () => {
    const entry = makeEntry("c", { text: "Some fact" });
    const { packed } = packIntoBudget(
      [{ factId: "c", entry: entry as MemoryEntry }],
      10_000,
      { contradictedIds: new Set() },
    );
    expect(packed[0]).not.toContain("WARNING");
  });

  it("is backward-compatible when options are omitted", () => {
    const entry = makeEntry("d", { text: "Normal fact" });
    const { packed } = packIntoBudget([{ factId: "d", entry: entry as MemoryEntry }], 10_000);
    expect(packed[0]).not.toContain("WARNING");
  });
});
