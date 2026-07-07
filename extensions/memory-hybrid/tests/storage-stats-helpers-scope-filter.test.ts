/**
 * loop iteration 95 regression: `hybrid-mem search --scope global` must return only
 * global-scoped facts, not every scope. buildHybridSearchScopeFilter (extracted from
 * register-storage-entities-decay.ts's `search` command) had no branch for scope="global", so a
 * plain `{}` filter reached scopeFilterClausePositional/filterByScope, both of which treat an
 * empty (no userId/agentId/sessionId) filter as "no restriction".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import {
  buildHybridSearchScopeFilter,
  resolveEntityCleanStopWords,
} from "../cli/commands/manage/storage-stats-helpers.js";

describe("buildHybridSearchScopeFilter (loop iteration 95 regression)", () => {
  it("returns undefined when no --scope is given", () => {
    expect(buildHybridSearchScopeFilter(undefined, undefined)).toBeUndefined();
  });

  it("builds user/agent/session filters unchanged", () => {
    expect(buildHybridSearchScopeFilter("user", "alice")).toEqual({ userId: "alice" });
    expect(buildHybridSearchScopeFilter("agent", "bot-1")).toEqual({ agentId: "bot-1" });
    expect(buildHybridSearchScopeFilter("session", "sess-1")).toEqual({ sessionId: "sess-1" });
  });

  it("builds a global-only filter (not an empty, unrestricted filter) for --scope global", () => {
    const filter = buildHybridSearchScopeFilter("global", undefined);
    expect(filter).toBeDefined();
    expect(filter?.userId).toBeFalsy();
    expect(filter?.sessionId).toBeFalsy();
    // globalOnlyScopeFilter()'s sentinel agentId is what actually makes this restrictive under
    // scopeFilterClausePositional/filterByScope's "empty filter = no restriction" semantics.
    expect(filter?.agentId).toBeTruthy();
  });
});

describe("hybrid-mem search --scope global (loop iteration 95 regression, end-to-end)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "search-scope-global-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes another tenant's user-scoped fact when --scope global is requested", () => {
    factsDb.store({
      text: "Global deploy runbook for the platform",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "global",
    });
    factsDb.store({
      text: "Bob's private deploy runbook notes",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "user",
      scopeTarget: "bob",
    });

    const scopeFilter = buildHybridSearchScopeFilter("global", undefined);
    const results = factsDb.search("deploy runbook", 10, { scopeFilter });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.entry.text.startsWith("Global"))).toBe(true);
  });
});

describe("resolveEntityCleanStopWords (loop iteration 97 regression)", () => {
  const configured = ["it", "this", "that"];

  it("uses the configured stop-word list only when --stopwords is explicitly passed", () => {
    expect(resolveEntityCleanStopWords(true, configured)).toEqual(configured);
  });

  it("uses an empty list when --stopwords is absent (Commander boolean flags are never `false`)", () => {
    expect(resolveEntityCleanStopWords(undefined, configured)).toEqual([]);
  });
});

describe("hybrid-mem entities clean --stopwords (loop iteration 97 regression, end-to-end)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  const configured = ["it", "this", "that"];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "entities-clean-stopwords-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    factsDb.store({
      text: "Fact about the entity 'it'",
      category: "fact",
      importance: 0.5,
      entity: "it",
      key: null,
      value: null,
      source: "test",
    });
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("matches nothing when --stopwords is omitted (the flag's own promised opt-in behavior)", () => {
    const stopWords = resolveEntityCleanStopWords(undefined, configured);
    const report = factsDb.cleanEntityStopwords({ apply: false, stopWords });
    expect(report.matched).toBe(0);
  });

  it("matches the stopword entity when --stopwords is passed", () => {
    const stopWords = resolveEntityCleanStopWords(true, configured);
    const report = factsDb.cleanEntityStopwords({ apply: false, stopWords });
    expect(report.matched).toBe(1);
  });
});
