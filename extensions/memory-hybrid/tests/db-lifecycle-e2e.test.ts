/**
 * End-to-end database lifecycle tests to prevent regressions like:
 * - VerificationStore sharing a connection with FactsDB but closing it (double-close / wrong owner)
 * - Wrong DB paths (e.g. multiple stores using the same file)
 * - verified_facts table not in same DB as facts (prune/decay would ignore verification)
 * - Close order causing throws or double-close
 *
 * These tests mirror the initialization and teardown patterns in setup/init-databases.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { FactsDB, VerificationStore } = _testing;

// ---------------------------------------------------------------------------
// Helpers: path construction matching setup/init-databases.ts
// If init-databases adds a new store, add its path here so distinct-paths test stays in sync.
// ---------------------------------------------------------------------------

function buildStorePaths(resolvedSqlitePath: string): Record<string, string> {
  const baseDir = dirname(resolvedSqlitePath);
  return {
    facts: resolvedSqlitePath,
    credentials: join(baseDir, "credentials.db"),
    eventLog: join(baseDir, "event-log.db"),
    proposals: join(baseDir, "proposals.db"),
    aliases: join(baseDir, "aliases.db"),
    issues: join(baseDir, "issues.db"),
    workflow: join(baseDir, "workflow-traces.db"),
    crystallization: join(baseDir, "crystallization-proposals.db"),
    toolProposals: join(baseDir, "tool-proposals.db"),
    provenance: join(baseDir, "provenance.db"),
  };
}

// ---------------------------------------------------------------------------
// 1. Shared connection: VerificationStore must not close FactsDB's connection
// ---------------------------------------------------------------------------

describe("DB lifecycle: VerificationStore shared connection", () => {
  let tmpDir: string;
  let factsPath: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let verificationStore: InstanceType<typeof VerificationStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-lifecycle-e2e-"));
    factsPath = join(tmpDir, "facts.db");
    factsDb = new FactsDB(factsPath, { fuzzyDedupe: false });
    verificationStore = new VerificationStore(factsDb.getRawDb(), {
      backupPath: join(tmpDir, "verified-backup.json"),
      reverificationDays: 30,
    });
  });

  afterEach(() => {
    verificationStore.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("verify and store work when VerificationStore shares FactsDB connection", () => {
    const entry = factsDb.store({
      text: "Server IP is 10.0.0.1",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    verificationStore.verify(entry.id, entry.text, "agent");
    const vf = verificationStore.getVerified(entry.id);
    expect(vf).not.toBeNull();
    expect(vf?.canonicalText).toBe(entry.text);
    expect(factsDb.getById(entry.id)).not.toBeNull();
  });

  it("VerificationStore.close() does not close shared connection (FactsDB still usable)", () => {
    const entry = factsDb.store({
      text: "Critical fact",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    verificationStore.verify(entry.id, entry.text, "agent");
    verificationStore.close();
    expect(factsDb.getById(entry.id)).not.toBeNull();
    const count = factsDb.count();
    expect(count).toBe(1);
  });

  it("close order: FactsDB then VerificationStore does not throw (no double-close)", () => {
    factsDb.store({
      text: "A fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    factsDb.close();
    expect(() => verificationStore.close()).not.toThrow();
  });

  it("close order: VerificationStore then FactsDB does not throw", () => {
    factsDb.store({
      text: "Another fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    verificationStore.close();
    expect(() => factsDb.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Verified facts excluded from prune and decay (same-DB visibility)
// ---------------------------------------------------------------------------

describe("DB lifecycle: verified_facts in same DB as facts (prune/decay exclusion)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let verificationStore: InstanceType<typeof VerificationStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-lifecycle-prune-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false });
    verificationStore = new VerificationStore(factsDb.getRawDb(), {
      backupPath: join(tmpDir, "backup.json"),
      reverificationDays: 30,
    });
  });

  afterEach(() => {
    verificationStore.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pruneExpired does not delete verified facts", () => {
    const expired = factsDb.store({
      text: "Expired unverified",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "session",
      expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    const verifiedEntry = factsDb.store({
      text: "Expired but verified",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "session",
      expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    verificationStore.verify(verifiedEntry.id, verifiedEntry.text, "agent");

    const pruned = factsDb.pruneExpired();
    expect(pruned).toBe(1);
    expect(factsDb.getById(expired.id)).toBeNull();
    expect(factsDb.getById(verifiedEntry.id)).not.toBeNull();
  });

  it("decayConfidence does not delete verified facts", () => {
    const lowConf = factsDb.store({
      text: "Low confidence unverified",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "active",
      confidence: 0.05,
    });
    const verifiedEntry = factsDb.store({
      text: "Low confidence but verified",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "active",
      confidence: 0.05,
    });
    verificationStore.verify(verifiedEntry.id, verifiedEntry.text, "agent");

    const removed = factsDb.decayConfidence();
    expect(removed).toBe(1);
    expect(factsDb.getById(lowConf.id)).toBeNull();
    expect(factsDb.getById(verifiedEntry.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Distinct DB paths (no two stores share the same file by mistake)
// ---------------------------------------------------------------------------

describe("DB lifecycle: distinct store paths (init-databases pattern)", () => {
  it("all store paths are distinct and only facts uses the resolved sqlite path", () => {
    const resolvedSqlitePath = join(tmpdir(), "memory-dir", "facts.db");
    const paths = buildStorePaths(resolvedSqlitePath);

    const pathList = Object.entries(paths).map(([name, p]) => ({ name, path: p }));
    const pathStrings = pathList.map(({ path }) => path);
    const uniquePaths = new Set(pathStrings);
    expect(uniquePaths.size).toBe(pathStrings.length);
    expect(pathStrings.length).toBe(pathList.length);

    expect(paths.facts).toBe(resolvedSqlitePath);
    const others = Object.entries(paths).filter(([k]) => k !== "facts");
    for (const [, p] of others) {
      expect(p).not.toBe(resolvedSqlitePath);
      expect(p.endsWith(".db")).toBe(true);
      expect(dirname(p)).toBe(dirname(resolvedSqlitePath));
    }
  });

  it("path set matches expected store names (no missing or extra)", () => {
    const paths = buildStorePaths("/home/user/.openclaw/memory/facts.db");
    const expected = [
      "facts",
      "credentials",
      "eventLog",
      "proposals",
      "aliases",
      "issues",
      "workflow",
      "crystallization",
      "toolProposals",
      "provenance",
    ];
    expect(Object.keys(paths).sort()).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------
// 4. Standalone VerificationStore (owns connection) closes correctly
// ---------------------------------------------------------------------------

describe("DB lifecycle: VerificationStore with own connection", () => {
  let tmpDir: string;
  let store: InstanceType<typeof VerificationStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-lifecycle-standalone-"));
    store = new VerificationStore(join(tmpDir, "verified.db"), {
      backupPath: join(tmpDir, "backup.json"),
      reverificationDays: 30,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("close() allows reopening same path in a new instance (no lock)", () => {
    store.verify("f1", "Fact one", "agent");
    store.close();
    const store2 = new VerificationStore(join(tmpDir, "verified.db"), {
      backupPath: join(tmpDir, "backup2.json"),
      reverificationDays: 30,
    });
    const vf = store2.getVerified("f1");
    expect(vf).not.toBeNull();
    expect(vf?.canonicalText).toBe("Fact one");
    store2.close();
  });
});
