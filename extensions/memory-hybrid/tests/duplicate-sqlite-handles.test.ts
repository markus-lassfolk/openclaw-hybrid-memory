/**
 * Tests for issue #1550: prevent duplicate SQLite handles after hybrid-memory
 * plugin re-registration.
 *
 * The root cause was that BaseSqliteStore.liveDb() would silently reopen a
 * closed DB handle when only close() (background-maintenance close) had been
 * called. After a plugin re-registration cycle, stale tool/hook closures
 * captured old store instances; those closures would call liveDb, reopen the
 * old SQLite file, and accumulate duplicate handles.
 *
 * The fix is permanentClose(), which transitions the store to "shutdown" phase
 * so that liveDb throws instead of reopening.  closeOldDatabases() now calls
 * permanentClose() for all BaseSqliteStore-derived stores so that old store
 * objects are rendered permanently inert after teardown.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApitapStore } from "../backends/apitap-store.js";
import { AuditStore } from "../backends/audit-store.js";
import { EventLog } from "../backends/event-log.js";
import { FactsDB } from "../backends/facts-db.js";
import { LearningsDB } from "../backends/learnings-db.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import { closeOldDatabases } from "../setup/init-databases.js";

// ---------------------------------------------------------------------------
// BaseSqliteStore.permanentClose() unit tests
// ---------------------------------------------------------------------------

describe("BaseSqliteStore.permanentClose()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "permanent-close-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("FactsDB throws after permanentClose() — does NOT reopen", () => {
    const db = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false });
    db.store({
      text: "A fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    db.permanentClose();

    expect(() => db.count()).toThrow();
  });

  it("FactsDB permanentClose() is idempotent (calling twice does not throw)", () => {
    const db = new FactsDB(join(tmpDir, "facts2.db"), { fuzzyDedupe: false });
    db.permanentClose();
    expect(() => db.permanentClose()).not.toThrow();
  });

  it("FactsDB.isOpen() returns false after permanentClose()", () => {
    const db = new FactsDB(join(tmpDir, "facts3.db"), { fuzzyDedupe: false });
    expect(db.isOpen()).toBe(true);
    db.permanentClose();
    expect(db.isOpen()).toBe(false);
  });

  it("WorkflowStore throws after permanentClose() — does NOT reopen", () => {
    const store = new WorkflowStore(join(tmpDir, "wf.db"));
    store.record({ goal: "initial", toolSequence: ["a"] });

    store.permanentClose();

    expect(() => store.list()).toThrow();
  });

  it("EventLog throws after permanentClose() — does NOT reopen", () => {
    const log = new EventLog(join(tmpDir, "events.db"));
    log.append({ sessionId: "s1", timestamp: new Date().toISOString(), eventType: "fact_learned", content: {} });

    log.permanentClose();

    expect(() => log.getBySession("s1")).toThrow();
  });

  it("LearningsDB throws after permanentClose() — does NOT reopen", () => {
    const db = new LearningsDB(join(tmpDir, "learnings.db"));
    db.create({ type: "error", area: "test", content: "guard" });

    db.permanentClose();

    expect(() => db.count()).toThrow();
  });

  it("ProposalsDB throws after permanentClose() — does NOT reopen", () => {
    const db = new ProposalsDB(join(tmpDir, "proposals.db"));
    db.create({
      targetFile: "src/x.ts",
      title: "T",
      observation: "O",
      suggestedChange: "S",
      confidence: 0.9,
      evidenceSessions: [],
    });

    db.permanentClose();

    expect(() => db.list()).toThrow();
  });

  it("NarrativesDB throws after permanentClose() — does NOT reopen", () => {
    const db = new NarrativesDB(join(tmpDir, "narratives.db"));

    db.permanentClose();

    expect(() => db.listRecent()).toThrow();
  });

  it("ApitapStore throws after permanentClose() — does NOT reopen", () => {
    const store = new ApitapStore(join(tmpDir, "apitap.db"));
    store.create({
      siteUrl: "https://example.com",
      endpoint: "/api/test",
      method: "GET",
      parameters: {},
      sampleResponse: {},
      sessionId: "s1",
    });

    store.permanentClose();

    expect(() => store.list()).toThrow();
  });

  it("AuditStore throws after permanentClose() — does NOT reopen", () => {
    const store = new AuditStore(join(tmpDir, "audit.db"));

    store.permanentClose();

    expect(() => store.query({ limit: 1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Re-registration lifecycle: closeOldDatabases() uses permanentClose()
// ---------------------------------------------------------------------------

describe("closeOldDatabases() prevents handle resurrection on re-registration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rereg-handles-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("FactsDB is permanently closed after closeOldDatabases() — count() throws, not reopens", () => {
    const factsDb = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false });
    factsDb.store({
      text: "Stale fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    closeOldDatabases({ factsDb });

    // Stale closure: attempts to use the old store AFTER teardown must throw, not reopen
    expect(() => factsDb.count()).toThrow();
  });

  it("WorkflowStore is permanently closed after closeOldDatabases() — list() throws", () => {
    const workflowStore = new WorkflowStore(join(tmpDir, "wf.db"));
    workflowStore.record({ goal: "old goal", toolSequence: ["read"] });

    closeOldDatabases({ workflowStore });

    expect(() => workflowStore.list()).toThrow();
  });

  it("EventLog is permanently closed after closeOldDatabases() — append() throws", () => {
    const eventLog = new EventLog(join(tmpDir, "events.db"));

    closeOldDatabases({ eventLog });

    expect(() =>
      eventLog.append({
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        eventType: "fact_learned",
        content: {},
      }),
    ).toThrow();
  });

  it("re-opening same DB path in a new store succeeds after old store is permanently closed", () => {
    const dbPath = join(tmpDir, "facts-rereg.db");
    const oldFacts = new FactsDB(dbPath, { fuzzyDedupe: false });
    oldFacts.store({
      text: "Generation 1 fact",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    // Simulate re-registration teardown
    closeOldDatabases({ factsDb: oldFacts });

    // New plugin instance opens the same path
    const newFacts = new FactsDB(dbPath, { fuzzyDedupe: false });
    expect(newFacts.count()).toBe(1);
    const entry = newFacts.store({
      text: "Generation 2 fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    expect(entry.text).toBe("Generation 2 fact");
    expect(newFacts.count()).toBe(2);

    // Old store still throws
    expect(() => oldFacts.count()).toThrow();

    newFacts.close();
  });

  it("three successive re-registrations: each teardown permanently closes old handles", () => {
    const dbPath = join(tmpDir, "facts-multi.db");

    function createAndTearDown(generation: number): FactsDB {
      const db = new FactsDB(dbPath, { fuzzyDedupe: false });
      db.store({
        text: `Generation ${generation} fact`,
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
      return db;
    }

    const gen1 = createAndTearDown(1);
    closeOldDatabases({ factsDb: gen1 });
    expect(() => gen1.count()).toThrow();

    const gen2 = createAndTearDown(2);
    closeOldDatabases({ factsDb: gen2 });
    expect(() => gen2.count()).toThrow();
    expect(() => gen1.count()).toThrow(); // still throws

    const gen3 = createAndTearDown(3);
    expect(gen3.count()).toBe(3); // all 3 generations persisted

    closeOldDatabases({ factsDb: gen3 });
    expect(() => gen3.count()).toThrow();
  });
});
