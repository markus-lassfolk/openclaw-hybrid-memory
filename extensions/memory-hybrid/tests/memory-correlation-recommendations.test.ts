/**
 * Tests for memory correlation recommendations (#1802).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FactsDB } from "../backends/facts-db.js";
import { IssueStore } from "../backends/issue-store.js";
import {
  autoLinkIssueToFacts,
  createGraphLinksForIssueFacts,
} from "../services/issue-fact-correlation.js";
import {
  getCriticalOpenIssueFactIds,
  runIssueRetrievalStrategy,
} from "../services/issue-retrieval.js";
import {
  inferEntityFilterFromQuery,
  inferRetrievalModeFromQuery,
} from "../services/retrieval-mode-selector.js";
import {
  hasErrorKeywords,
  searchAmbientIssues,
  shouldTriggerIssueAmbientSearch,
} from "../services/ambient-retrieval.js";
import {
  parseFactProvenanceJson,
  resolveProvenanceSourceFacts,
} from "../backends/facts-db/provenance-json.js";
import { parseRulesFromModelResponse } from "../services/reflection/structured-output.js";

describe("issue-fact correlation", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let issueStore: IssueStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-corr-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    issueStore = new IssueStore(join(tmpDir, "issues.db"));
  });

  afterEach(() => {
    factsDb.close();
    issueStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("auto-links related facts and creates graph edges on issue create", () => {
    const fact = factsDb.store({
      text: "Production deploy fails when LanceDB vector index is corrupt",
      category: "fact",
      importance: 0.8,
      entity: "openclaw-hybrid-memory",
      key: null,
      value: null,
      source: "test",
      confidence: 0.9,
      decayClass: "normal",
    });

    const issue = issueStore.create({
      title: "LanceDB vector index corruption on deploy",
      symptoms: ["deploy fails", "vector index corrupt"],
      severity: "critical",
    });

    const result = autoLinkIssueToFacts(issue, factsDb, issueStore);
    expect(result.linkedFactIds).toContain(fact.id);

    const updated = issueStore.get(issue.id)!;
    expect(updated.relatedFacts).toContain(fact.id);
  });

  it("creates RELATED_TO links between issue-linked facts", () => {
    const a = factsDb.store({
      text: "Symptom: API timeout on recall",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      confidence: 0.8,
      decayClass: "normal",
    });
    const b = factsDb.store({
      text: "Root cause: FTS join pathology",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      confidence: 0.8,
      decayClass: "normal",
    });

    const created = createGraphLinksForIssueFacts([a.id, b.id], factsDb);
    expect(created).toBeGreaterThan(0);
  });
});

describe("issue retrieval strategy", () => {
  let tmpDir: string;
  let issueStore: IssueStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-ret-"));
    issueStore = new IssueStore(join(tmpDir, "issues.db"));
  });

  afterEach(() => {
    issueStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns fact IDs from matched critical issues", () => {
    const issue = issueStore.create({
      title: "Critical memory leak",
      symptoms: ["OOM kill"],
      severity: "critical",
    });
    issueStore.linkFact(issue.id, "fact-abc-123");

    const results = runIssueRetrievalStrategy("memory leak OOM", issueStore, 5);
    expect(results.some((r) => r.factId === "fact-abc-123")).toBe(true);
    expect(getCriticalOpenIssueFactIds(issueStore)).toContain("fact-abc-123");
  });
});

describe("ambient issue triggers", () => {
  let tmpDir: string;
  let issueStore: IssueStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ambient-issue-"));
    issueStore = new IssueStore(join(tmpDir, "issues.db"));
  });

  afterEach(() => {
    issueStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects regression and PR references", () => {
    expect(shouldTriggerIssueAmbientSearch("We have a regression in deploy")).toBe(true);
    expect(shouldTriggerIssueAmbientSearch("Can you check PR #1234?")).toBe(true);
    expect(hasErrorKeywords("Everything works fine")).toBe(false);
  });

  it("always includes open critical issues", () => {
    issueStore.create({
      title: "Critical outage in prod",
      symptoms: ["service down"],
      severity: "critical",
    });

    const { openIssues } = searchAmbientIssues("Hello, how are you?", issueStore);
    expect(openIssues.length).toBeGreaterThan(0);
    expect(openIssues[0].severity).toBe("critical");
  });
});

describe("retrieval mode auto-selection", () => {
  it("prefers constrained recall for entity-bound queries", () => {
    expect(inferRetrievalModeFromQuery("project openclaw-hybrid-memory status")).toBe("constrained-recall");
    expect(inferRetrievalModeFromQuery("tell me everything about memory systems")).toBe("explicit-deep");
    expect(inferEntityFilterFromQuery("project openclaw-hybrid-memory deploy")).toBe("openclaw-hybrid-memory");
  });
});

describe("provenance hydration", () => {
  it("resolves source fact summaries from provenance JSON", () => {
    const factsDb = {
      getById(id: string) {
        if (id === "src-1") return { id, text: "Original fact A", category: "fact", source: "test" };
        if (id === "src-2") return { id, text: "Original fact B", category: "decision", source: "test" };
        return null;
      },
    };

    const provenance = parseFactProvenanceJson(
      JSON.stringify({ sourceFactIds: ["src-1", "src-2"], method: "consolidation" }),
    );
    const sources = resolveProvenanceSourceFacts(factsDb, provenance, 5);
    expect(sources).toHaveLength(2);
    expect(sources[0].text).toContain("Original fact");
  });
});

describe("reflect-rules placeholder rejection", () => {
  it("rejects schema placeholder rules", () => {
    const parse = parseRulesFromModelResponse('{"rules":["<imperative one-line rule>"],"noAction":false}');
    expect(parse.rules).toHaveLength(0);
    expect(parse.rejectedLength).toBeGreaterThan(0);
  });
});
