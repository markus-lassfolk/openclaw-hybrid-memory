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
  clearKnownEntitySurfacesCache,
  getFactIdsForEntitySurfaces,
  loadKnownEntitySurfaces,
  matchEntitySurfacesInText,
} from "../services/entity-retrieval.js";
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
import { resolveEntityForeignKeys } from "../backends/facts-db/entity-layer.js";
import { packIntoBudget } from "../services/retrieval-orchestrator/packing.js";

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

  it("excludes unrelated critical issues when query lacks error context", () => {
    const issue = issueStore.create({
      title: "Critical memory leak",
      symptoms: ["OOM kill"],
      severity: "critical",
    });
    issueStore.linkFact(issue.id, "fact-unrelated-999");

    const results = runIssueRetrievalStrategy("what is the weather today", issueStore, 5);
    expect(results.some((r) => r.factId === "fact-unrelated-999")).toBe(false);
  });

  it("boosts critical issues when query has error context", () => {
    const issue = issueStore.create({
      title: "Critical deploy regression",
      symptoms: ["deploy fails"],
      severity: "critical",
    });
    issueStore.linkFact(issue.id, "fact-regression-1");

    const results = runIssueRetrievalStrategy("we have a regression in deploy", issueStore, 5);
    expect(results.some((r) => r.factId === "fact-regression-1")).toBe(true);
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

describe("issue auto-link guards", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let issueStore: IssueStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-corr-guard-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    issueStore = new IssueStore(join(tmpDir, "issues.db"));
  });

  afterEach(() => {
    factsDb.close();
    issueStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caps new links at maxLinks even when many related facts already exist", () => {
    const issue = issueStore.create({
      title: "Existing links cap test",
      symptoms: ["symptom"],
      severity: "high",
    });
    for (let i = 0; i < 8; i++) {
      issueStore.linkFact(issue.id, `preexisting-${i}`);
    }
    for (let i = 0; i < 10; i++) {
      factsDb.store({
        text: `Existing links cap test symptom detail number ${i}`,
        category: "fact",
        importance: 0.6,
        entity: null,
        key: null,
        value: null,
        source: "test",
        confidence: 0.8,
        decayClass: "normal",
      });
    }
    const refreshed = issueStore.get(issue.id)!;
    const result = autoLinkIssueToFacts(refreshed, factsDb, issueStore, { maxLinks: 2 });
    const newLinks = result.linkedFactIds.filter((id) => !id.startsWith("preexisting-"));
    expect(newLinks.length).toBeLessThanOrEqual(2);
  });

  it("skips superseded facts when auto-linking", () => {
    const live = factsDb.store({
      text: "Superseded skip test live fact about database timeout",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      confidence: 0.8,
      decayClass: "normal",
    });
    const stale = factsDb.store({
      text: "Superseded skip test stale fact about database timeout",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      confidence: 0.8,
      decayClass: "normal",
    });
    factsDb.supersede(stale.id, live.id);

    const issue = issueStore.create({
      title: "Database timeout on recall",
      symptoms: ["database timeout"],
      severity: "high",
    });
    autoLinkIssueToFacts(issue, factsDb, issueStore);
    const updated = issueStore.get(issue.id)!;
    expect(updated.relatedFacts).toContain(live.id);
    expect(updated.relatedFacts).not.toContain(stale.id);
  });
});

describe("retrieval mode entity inference", () => {
  it("infers hyphenated project token as entity filter", () => {
    expect(inferEntityFilterFromQuery("openclaw-hybrid-memory deploy status")).toBe("openclaw-hybrid-memory");
  });
});

describe("entity surface matching", () => {
  it("does not substring-match short entity keys", () => {
    const surfaces = [{ key: "ai", displayName: "AI", label: "OTHER" as const }];
    expect(matchEntitySurfacesInText("wait for email", surfaces)).toHaveLength(0);
  });
});

describe("entity surface cache and fact lookup", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "entity-cache-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches entity surfaces across repeated calls", () => {
    const db = factsDb.getRawDb();
    clearKnownEntitySurfacesCache(db);
    const first = loadKnownEntitySurfaces(db, 100);
    const second = loadKnownEntitySurfaces(db, 100);
    expect(first).toBe(second);
  });

  it("excludes superseded facts from entity mention lookups", () => {
    const live = factsDb.store({
      text: "Entity mention lookup live fact",
      category: "fact",
      importance: 0.6,
      entity: "Acme Corp",
      key: null,
      value: null,
      source: "test",
    });
    const stale = factsDb.store({
      text: "Entity mention lookup stale fact",
      category: "fact",
      importance: 0.6,
      entity: "Acme Corp",
      key: null,
      value: null,
      source: "test",
    });
    factsDb.supersede(stale.id, live.id);

    factsDb.applyEntityEnrichment(
      live.id,
      [
        {
          label: "ORG",
          surfaceText: "Acme Corp",
          normalizedSurface: "acme corp",
          startOffset: 0,
          endOffset: 9,
          confidence: 0.9,
        },
      ],
      "en",
    );
    factsDb.applyEntityEnrichment(
      stale.id,
      [
        {
          label: "ORG",
          surfaceText: "Acme Corp",
          normalizedSurface: "acme corp",
          startOffset: 0,
          endOffset: 9,
          confidence: 0.9,
        },
      ],
      "en",
    );

    const ids = getFactIdsForEntitySurfaces(factsDb.getRawDb(), [
      { key: "acme corp", displayName: "Acme Corp", label: "ORG" },
    ]);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(stale.id);
  });
});

describe("resolveEntityForeignKeys skip", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "entity-fk-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips re-resolution when entity unchanged and FKs already set", () => {
    const fact = factsDb.store({
      text: "Contact Alice works on project X",
      category: "fact",
      importance: 0.6,
      entity: "Alice",
      key: null,
      value: null,
      source: "test",
    });
    factsDb.applyEntityEnrichment(
      fact.id,
      [
        {
          label: "PERSON",
          surfaceText: "Alice",
          normalizedSurface: "alice",
          startOffset: 8,
          endOffset: 13,
          confidence: 0.9,
        },
      ],
      "en",
    );
    resolveEntityForeignKeys(factsDb.getRawDb(), fact.id, "Alice");
    const afterFirst = factsDb.getRawDb()
      .prepare("SELECT entity_contact_id, entity_organization_id FROM facts WHERE id = ?")
      .get(fact.id) as { entity_contact_id: string | null; entity_organization_id: string | null };

    resolveEntityForeignKeys(factsDb.getRawDb(), fact.id, "Alice");
    const afterSecond = factsDb.getRawDb()
      .prepare("SELECT entity_contact_id, entity_organization_id FROM facts WHERE id = ?")
      .get(fact.id) as { entity_contact_id: string | null; entity_organization_id: string | null };

    expect(afterSecond.entity_contact_id).toBe(afterFirst.entity_contact_id);
    expect(afterSecond.entity_organization_id).toBe(afterFirst.entity_organization_id);
  });
});

describe("provenance packing", () => {
  it("adds compact provenance to packed output without mutating entry text", () => {
    const entry = {
      id: "consolidated-1",
      text: "Consolidated summary fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      createdAt: 1_700_000_000,
      confidence: 0.9,
      decayClass: "normal" as const,
    };
    const { packed } = packIntoBudget([{ factId: "consolidated-1", entry }], 5000, {
      provenanceByFactId: new Map([["consolidated-1", "2 src: Original A; Original B"]]),
    });
    expect(entry.text).toBe("Consolidated summary fact");
    expect(packed[0]).toContain("sources: 2 src:");
    expect(packed[0]).not.toContain("Original A\n");
  });
});
