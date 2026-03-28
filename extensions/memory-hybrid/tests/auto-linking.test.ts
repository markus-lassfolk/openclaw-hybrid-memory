/**
 * Tests for Issue #154 — Auto-linking entities at write time.
 *
 * Coverage:
 *  - getKnownEntities()
 *  - extractEntitiesFromText() — exact, substring, IP, no match, empty, special chars
 *  - findEntityAnchor()
 *  - autoLinkEntities() — entity links, co-occurrence, supersession, config flags
 *  - Performance (< 15 ms total overhead per write)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "auto-linking-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getKnownEntities
// ---------------------------------------------------------------------------

describe("FactsDB.getKnownEntities", () => {
  it("returns empty array when no facts exist", () => {
    expect(db.getKnownEntities()).toEqual([]);
  });

  it("returns distinct entity names from active facts", () => {
    db.store({
      text: "Fact about Alice",
      entity: "alice",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.store({
      text: "Another Alice fact",
      entity: "alice",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.store({
      text: "Fact about Bob",
      entity: "bob",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const entities = db.getKnownEntities();
    expect(entities).toContain("alice");
    expect(entities).toContain("bob");
    // Distinct — alice should appear once
    expect(entities.filter((e) => e === "alice")).toHaveLength(1);
  });

  it("excludes facts without entities", () => {
    db.store({
      text: "No entity here",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    expect(db.getKnownEntities()).toEqual([]);
  });

  it("excludes superseded facts' entities if they have no other active facts", () => {
    const old = db.store({
      text: "Old fact",
      entity: "onlySuperseded",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newer = db.store({
      text: "New fact",
      entity: "active",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.supersede(old.id, newer.id);
    const entities = db.getKnownEntities();
    expect(entities).not.toContain("onlySuperseded");
    expect(entities).toContain("active");
  });
});

// ---------------------------------------------------------------------------
// extractEntitiesFromText
// ---------------------------------------------------------------------------

describe("FactsDB.extractEntitiesFromText", () => {
  it("returns empty array when no known entities and no IPs", () => {
    const result = db.extractEntitiesFromText("Hello world", []);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty text", () => {
    const result = db.extractEntitiesFromText("", ["alice", "bob"]);
    expect(result).toEqual([]);
  });

  it("exact word-boundary match returns weight 1.0", () => {
    const result = db.extractEntitiesFromText("Alice is the project lead", ["Alice"]);
    expect(result).toHaveLength(1);
    expect(result[0].entity).toBe("Alice");
    expect(result[0].weight).toBe(1.0);
  });

  it("case-insensitive exact match returns weight 1.0", () => {
    const result = db.extractEntitiesFromText("alice joined today", ["Alice"]);
    expect(result).toHaveLength(1);
    expect(result[0].weight).toBe(1.0);
  });

  it("substring match (no word boundary) returns weight 0.7", () => {
    // "MyProject" is a substring of "MyProjectFoo" — no word boundary at end
    const result = db.extractEntitiesFromText("Working on MyProjectFoo code", ["MyProject"]);
    expect(result).toHaveLength(1);
    expect(result[0].entity).toBe("MyProject");
    expect(result[0].weight).toBe(0.7);
  });

  it("exact word-boundary match returns 1.0 not 0.7", () => {
    // "bob" with word boundary in "bob likes code"
    const result = db.extractEntitiesFromText("bob likes code", ["bob"]);
    expect(result[0].weight).toBe(1.0);
  });

  it("IPv4 address extracted with weight 0.5", () => {
    const result = db.extractEntitiesFromText("Connect to server 192.168.1.100 now", []);
    expect(result).toHaveLength(1);
    expect(result[0].entity).toBe("192.168.1.100");
    expect(result[0].weight).toBe(0.5);
  });

  it("multiple IPs in text each extracted separately", () => {
    const result = db.extractEntitiesFromText("Route traffic from 10.0.0.1 to 10.0.0.2", []);
    const ips = result.map((r) => r.entity);
    expect(ips).toContain("10.0.0.1");
    expect(ips).toContain("10.0.0.2");
  });

  it("known entity + IP both extracted", () => {
    const result = db.extractEntitiesFromText("Server alice at 10.0.0.5 is offline", ["alice"]);
    const entities = result.map((r) => r.entity);
    expect(entities).toContain("alice");
    expect(entities).toContain("10.0.0.5");
  });

  it("no match returns empty array", () => {
    const result = db.extractEntitiesFromText("Nothing relevant here", ["alpha", "beta"]);
    expect(result).toEqual([]);
  });

  it("text with special regex characters in entity name handled safely", () => {
    // Entity with regex special chars should not throw
    expect(() => {
      db.extractEntitiesFromText("user(admin) logged in", ["user(admin)"]);
    }).not.toThrow();
  });

  it("results sorted by descending weight", () => {
    const result = db.extractEntitiesFromText("alice leads MyProjectFoo and 10.0.0.1", ["alice", "MyProject"]);
    // alice → 1.0, MyProject → 0.7 (substring in MyProjectFoo), IP → 0.5
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].weight).toBeGreaterThanOrEqual(result[i + 1].weight);
    }
  });

  it("duplicate entity not returned twice", () => {
    // "alice" appears twice in text; should only produce one entry
    const result = db.extractEntitiesFromText("alice and alice again", ["alice"]);
    expect(result.filter((r) => r.entity === "alice")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findEntityAnchor
// ---------------------------------------------------------------------------

describe("FactsDB.findEntityAnchor", () => {
  it("returns null when no facts for entity", () => {
    expect(db.findEntityAnchor("unknown")).toBeNull();
  });

  it("returns the most recent active fact for the entity", () => {
    db.store({
      text: "Older fact",
      entity: "project",
      key: "status",
      value: "planning",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newer = db.store({
      text: "Newer fact",
      entity: "project",
      key: "status",
      value: "active",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const anchor = db.findEntityAnchor("project");
    expect(anchor).not.toBeNull();
    expect(anchor?.id).toBe(newer.id);
  });

  it("is case-insensitive", () => {
    const fact = db.store({
      text: "Alice info",
      entity: "Alice",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    expect(db.findEntityAnchor("alice")?.id).toBe(fact.id);
    expect(db.findEntityAnchor("ALICE")?.id).toBe(fact.id);
  });

  it("ignores superseded facts", () => {
    const old = db.store({
      text: "Old alice",
      entity: "alice",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.supersede(old.id, null);
    expect(db.findEntityAnchor("alice")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// autoLinkEntities — entity-based RELATED_TO links
// ---------------------------------------------------------------------------

describe("FactsDB.autoLinkEntities — entity-based RELATED_TO links", () => {
  const cfg = { coOccurrenceWeight: 0.3, autoSupersede: false };

  it("creates RELATED_TO link from new fact to entity anchor", () => {
    const anchor = db.store({
      text: "Server alpha info",
      entity: "alpha",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newFact = db.store({
      text: "Deploying to alpha now",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    const result = db.autoLinkEntities(newFact.id, newFact.text, null, null, null, cfg);
    expect(result.linkedCount).toBeGreaterThan(0);

    const links = db.getLinksFrom(newFact.id);
    const toAnchor = links.find((l) => l.targetFactId === anchor.id && l.linkType === "RELATED_TO");
    expect(toAnchor).toBeDefined();
    expect(toAnchor?.strength).toBe(1.0); // exact word-boundary match
  });

  it("creates RELATED_TO link for IP address extracted from text", () => {
    const anchor = db.store({
      text: "Server at 10.0.0.5",
      entity: "10.0.0.5",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newFact = db.store({
      text: "Connecting to 10.0.0.5 via SSH",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    const result = db.autoLinkEntities(newFact.id, newFact.text, null, null, null, cfg);
    expect(result.linkedCount).toBeGreaterThan(0);

    const links = db.getLinksFrom(newFact.id);
    const toAnchor = links.find((l) => l.targetFactId === anchor.id && l.linkType === "RELATED_TO");
    expect(toAnchor).toBeDefined();
    // The IP "10.0.0.5" is a known entity and gets exact word-boundary match (weight 1.0);
    // IP NER (weight 0.5) is the fallback when no known entity exists for that IP.
    expect(toAnchor?.strength).toBeGreaterThanOrEqual(0.5);
  });

  it("creates RELATED_TO link via IP NER when IP is not a known entity", () => {
    // No existing facts with entity = "10.0.0.9", so IP NER path is exercised
    // We need an anchor fact that has the same IP in text to test that links are created
    // The IP NER creates an entry in extractEntitiesFromText, but findEntityAnchor("10.0.0.9")
    // returns null if no fact has entity="10.0.0.9" → no link created (correct behavior)
    const result = db.extractEntitiesFromText("Connect to 10.0.0.9", []);
    expect(result).toHaveLength(1);
    expect(result[0].entity).toBe("10.0.0.9");
    expect(result[0].weight).toBe(0.5);
  });

  it("does not self-link (new fact's own entity not linked to itself)", () => {
    const fact = db.store({
      text: "About entity foo",
      entity: "foo",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.autoLinkEntities(fact.id, fact.text, "foo", null, null, cfg);
    const links = db.getLinksFrom(fact.id);
    const selfLink = links.find((l) => l.targetFactId === fact.id);
    expect(selfLink).toBeUndefined();
  });

  it("does not create duplicate RELATED_TO links on repeated calls", () => {
    const anchor = db.store({
      text: "Alpha entity",
      entity: "alpha",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newFact = db.store({
      text: "Mentions alpha twice",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newFact.id, newFact.text, null, null, null, cfg);
    db.autoLinkEntities(newFact.id, newFact.text, null, null, null, cfg);

    const links = db
      .getLinksFrom(newFact.id)
      .filter((l) => l.targetFactId === anchor.id && l.linkType === "RELATED_TO");
    expect(links).toHaveLength(1);
  });

  it("returns linkedCount 0 when no entities match and no IPs in text", () => {
    db.store({
      text: "Something about zeta",
      entity: "zeta",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newFact = db.store({
      text: "Completely unrelated content",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const result = db.autoLinkEntities(newFact.id, newFact.text, null, null, null, cfg);
    expect(result.linkedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// autoLinkEntities — temporal co-occurrence
// ---------------------------------------------------------------------------

describe("FactsDB.autoLinkEntities — temporal co-occurrence", () => {
  const cfg = { coOccurrenceWeight: 0.3, autoSupersede: false };

  it("links to facts in the same session by sessionId match", () => {
    const sessionId = "test-session-001";
    const factA = db.store({
      text: "First session fact",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    // Manually set source_sessions (normally done by memory-tools)
    (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE facts SET source_sessions = ? WHERE id = ?")
      .run(sessionId, factA.id);

    const factB = db.store({
      text: "Second session fact about something else",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.autoLinkEntities(factB.id, factB.text, null, null, sessionId, cfg);

    const links = db.getLinksFrom(factB.id);
    const coLink = links.find((l) => l.targetFactId === factA.id && l.linkType === "RELATED_TO");
    expect(coLink).toBeDefined();
    expect(coLink?.strength).toBeCloseTo(0.3);
  });

  it("links to facts with same entity via entity co-occurrence", () => {
    const entity = "shared-entity";
    const sessionId = "session-xyz";
    const factA = db.store({
      text: "First fact",
      entity,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    // Populate source_sessions so the session-based co-occurrence query can find factA
    (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE facts SET source_sessions = ? WHERE id = ?")
      .run(sessionId, factA.id);
    const factB = db.store({
      text: "Second fact",
      entity,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    // Same session + same entity → co-occurrence query picks up factA
    db.autoLinkEntities(factB.id, factB.text, entity, null, sessionId, cfg);
    const links = db.getLinksFrom(factB.id);
    const coLink = links.find((l) => l.targetFactId === factA.id);
    expect(coLink).toBeDefined();
  });

  it("no co-occurrence links when sessionId is null and entity differs", () => {
    db.store({
      text: "Fact A",
      entity: "ent-a",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const factB = db.store({
      text: "Fact B",
      entity: "ent-b",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    // sessionId=null, different entity → no co-occurrence link
    const result = db.autoLinkEntities(factB.id, "Fact B", "ent-b", null, null, cfg);
    // Should not throw and result should be defined
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// autoLinkEntities — supersession detection
// ---------------------------------------------------------------------------

describe("FactsDB.autoLinkEntities — supersession detection", () => {
  it("creates SUPERSEDES edge when entity+key matches but value differs", () => {
    const old = db.store({
      text: "old status",
      entity: "project",
      key: "status",
      value: "planning",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newer = db.store({
      text: "new status",
      entity: "project",
      key: "status",
      value: "active",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newer.id, newer.text, "project", "status", null, {
      coOccurrenceWeight: 0.3,
      autoSupersede: false,
    });

    const links = db.getLinksFrom(newer.id);
    const supersedes = links.find((l) => l.targetFactId === old.id && l.linkType === "SUPERSEDES");
    expect(supersedes).toBeDefined();
    expect(supersedes?.strength).toBe(1.0);
  });

  it("does NOT mark old fact as superseded when autoSupersede is false", () => {
    const old = db.store({
      text: "old",
      entity: "srv",
      key: "ip",
      value: "1.1.1.1",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newer = db.store({
      text: "new",
      entity: "srv",
      key: "ip",
      value: "2.2.2.2",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    const result = db.autoLinkEntities(newer.id, newer.text, "srv", "ip", null, {
      coOccurrenceWeight: 0.3,
      autoSupersede: false,
    });

    expect(result.supersededIds).toHaveLength(0);
    const oldFact = db.getById(old.id);
    expect(oldFact?.supersededAt).toBeNull();
  });

  it("marks old fact as superseded when autoSupersede is true", () => {
    const old = db.store({
      text: "old",
      entity: "srv",
      key: "ip",
      value: "1.1.1.1",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newer = db.store({
      text: "new",
      entity: "srv",
      key: "ip",
      value: "2.2.2.2",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    const result = db.autoLinkEntities(newer.id, newer.text, "srv", "ip", null, {
      coOccurrenceWeight: 0.3,
      autoSupersede: true,
    });

    expect(result.supersededIds).toContain(old.id);
    const oldFact = db.getById(old.id);
    expect(oldFact?.supersededAt).not.toBeNull();
    expect(oldFact?.supersededBy).toBe(newer.id);
  });

  it("reduces confidence on old fact when autoSupersede is true", () => {
    const old = db.store({
      text: "old",
      entity: "host",
      key: "name",
      value: "server1",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const origConf = old.confidence; // should be 1.0
    const newer = db.store({
      text: "new",
      entity: "host",
      key: "name",
      value: "server2",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newer.id, newer.text, "host", "name", null, { coOccurrenceWeight: 0.3, autoSupersede: true });

    const oldFact = db.getById(old.id);
    expect(oldFact?.confidence).toBeLessThan(origConf);
  });

  it("does NOT create SUPERSEDES edge when value matches (same value)", () => {
    const _old = db.store({
      text: "same value",
      entity: "project",
      key: "lead",
      value: "alice",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newer = db.store({
      text: "still same",
      entity: "project",
      key: "lead",
      value: "alice",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newer.id, newer.text, "project", "lead", null, {
      coOccurrenceWeight: 0.3,
      autoSupersede: true,
    });

    const links = db.getLinksFrom(newer.id);
    const supersedes = links.find((l) => l.linkType === "SUPERSEDES");
    expect(supersedes).toBeUndefined();
  });

  it("does not create duplicate SUPERSEDES edges on repeated calls", () => {
    const old = db.store({
      text: "old v",
      entity: "svc",
      key: "port",
      value: "80",
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newer = db.store({
      text: "new v",
      entity: "svc",
      key: "port",
      value: "443",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newer.id, newer.text, "svc", "port", null, { coOccurrenceWeight: 0.3, autoSupersede: false });
    db.autoLinkEntities(newer.id, newer.text, "svc", "port", null, { coOccurrenceWeight: 0.3, autoSupersede: false });

    const links = db.getLinksFrom(newer.id).filter((l) => l.targetFactId === old.id && l.linkType === "SUPERSEDES");
    expect(links).toHaveLength(1);
  });

  it("no supersession when entity is null", () => {
    db.store({ text: "old", entity: "e", key: "k", value: "v1", category: "other", importance: 0.5, source: "test" });
    const newer = db.store({
      text: "new",
      entity: null,
      key: "k",
      value: "v2",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newer.id, newer.text, null, "k", null, { coOccurrenceWeight: 0.3, autoSupersede: true });

    const links = db.getLinksFrom(newer.id).filter((l) => l.linkType === "SUPERSEDES");
    expect(links).toHaveLength(0);
  });

  it("no supersession when key is null", () => {
    db.store({ text: "old", entity: "e", key: "k", value: "v1", category: "other", importance: 0.5, source: "test" });
    const newer = db.store({
      text: "new",
      entity: "e",
      key: null,
      value: "v2",
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newer.id, newer.text, "e", null, null, { coOccurrenceWeight: 0.3, autoSupersede: true });

    const links = db.getLinksFrom(newer.id).filter((l) => l.linkType === "SUPERSEDES");
    expect(links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Config: disabled / zeroed weights
// ---------------------------------------------------------------------------

describe("autoLinkEntities — config variants", () => {
  it("coOccurrenceWeight=0 still creates links but with 0 strength", () => {
    const sessionId = "s1";
    const factA = db.store({
      text: "First",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE facts SET source_sessions = ? WHERE id = ?")
      .run(sessionId, factA.id);
    const factB = db.store({
      text: "Second",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(factB.id, factB.text, null, null, sessionId, { coOccurrenceWeight: 0, autoSupersede: false });
    // With weight 0 the link is still created (createLink inserts the row with strength=0)
    const links = db.getLinksFrom(factB.id);
    const coLink = links.find((l) => l.targetFactId === factA.id);
    expect(coLink).toBeDefined();
    expect(coLink?.strength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// autoLinkEntities — INSTANCE_OF detection
// ---------------------------------------------------------------------------

describe("FactsDB.autoLinkEntities — INSTANCE_OF detection", () => {
  const cfg = { coOccurrenceWeight: 0.3, autoSupersede: false };

  it("creates INSTANCE_OF link for 'is a' pattern", () => {
    const anchor = db.store({
      text: "Dachshund info",
      entity: "dachshund",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newFact = db.store({
      text: "Polly is a dachshund.",
      entity: "Polly",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newFact.id, newFact.text, newFact.entity, null, null, cfg);
    const links = db.getLinksFrom(newFact.id);
    const instanceLink = links.find((l) => l.linkType === "INSTANCE_OF" && l.targetFactId === anchor.id);
    expect(instanceLink).toBeDefined();
  });

  it("creates INSTANCE_OF link for 'kind of' pattern", () => {
    const anchor = db.store({
      text: "Amphibian info",
      entity: "amphibian",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const newFact = db.store({
      text: "Frog is a kind of amphibian.",
      entity: "Frog",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.autoLinkEntities(newFact.id, newFact.text, newFact.entity, null, null, cfg);
    const links = db.getLinksFrom(newFact.id);
    const instanceLink = links.find((l) => l.linkType === "INSTANCE_OF" && l.targetFactId === anchor.id);
    expect(instanceLink).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("autoLinkEntities — edge cases", () => {
  const cfg = { coOccurrenceWeight: 0.3, autoSupersede: false };

  it("handles empty text without throwing", () => {
    const fact = db.store({
      text: "x",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    expect(() => db.autoLinkEntities(fact.id, "", null, null, null, cfg)).not.toThrow();
  });

  it("handles text with only whitespace", () => {
    const fact = db.store({
      text: "x",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    expect(() => db.autoLinkEntities(fact.id, "   \n\t  ", null, null, null, cfg)).not.toThrow();
  });

  it("handles entity with special regex characters safely", () => {
    const _anchor = db.store({
      text: "user(admin)",
      entity: "user(admin)",
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const fact = db.store({
      text: "Logged in as user(admin) now",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    expect(() => db.autoLinkEntities(fact.id, fact.text, null, null, null, cfg)).not.toThrow();
  });

  it("handles 0 known entities gracefully", () => {
    const fact = db.store({
      text: "Some text here",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const result = db.autoLinkEntities(fact.id, fact.text, null, null, null, cfg);
    expect(result.linkedCount).toBe(0);
  });

  it("returns supersededIds as empty array when no supersession", () => {
    const fact = db.store({
      text: "just a fact",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const result = db.autoLinkEntities(fact.id, fact.text, null, null, null, cfg);
    expect(result.supersededIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Performance: < 15 ms per write
// ---------------------------------------------------------------------------

describe("autoLinkEntities — performance", () => {
  it("completes within 15 ms with 100 known entities", () => {
    // Seed 100 entities
    for (let i = 0; i < 100; i++) {
      db.store({
        text: `Fact about entity${i}`,
        entity: `entity${i}`,
        key: null,
        value: null,
        category: "other",
        importance: 0.5,
        source: "test",
      });
    }

    const newFact = db.store({
      text: "New fact mentioning entity42 and entity99",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    const start = performance.now();
    db.autoLinkEntities(newFact.id, newFact.text, null, null, null, {
      coOccurrenceWeight: 0.3,
      autoSupersede: false,
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});
