/**
 * Live contradiction-worsening gate (#2170).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { evaluateContradictionWorsening } from "../services/dream-contradiction-gate.js";
import { evaluateDreamGates, promoteDreamRun } from "../services/dream-promote.js";

describe("dream contradiction worsening gate (#2170)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-cx-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks add that conflicts with an existing entity+key value at heuristic threshold", () => {
    factsDb.store({
      text: "API timeout is 30s",
      category: "preference",
      importance: 0.8,
      source: "test",
      entity: "api",
      key: "timeout",
      value: "30s",
      scope: "session",
      scopeTarget: "s1",
    });

    const run = store.createDreamRun({
      id: "dream-cx-add",
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "API timeout is never 30s — use 5s",
          category: "preference",
          importance: 0.8,
          source: "dream",
          entity: "api",
          key: "timeout",
          value: "5s",
          scope: "session",
          scopeTarget: "s1",
        },
        evidence: {
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "conflicting timeout",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const entry = store.listCandidateEntries(run.id)[0]!;
    const gate = evaluateContradictionWorsening(factsDb, entry);
    expect(gate.worsens).toBe(true);
    expect(gate.reason).toMatch(/heuristic_score|conflicts_verified/);

    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "session";
    const result = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(result.status).toBe("quarantined");
    expect(result.gateReport.decisions[0]?.reason).toMatch(/contradiction_worsens/);
  });

  it("blocks delete of a fact involved in an unresolved contradiction", () => {
    const a = factsDb.store({
      text: "feature enabled true",
      category: "preference",
      importance: 0.7,
      source: "test",
      entity: "feature",
      key: "enabled",
      value: "true",
    });
    const b = factsDb.store({
      text: "feature enabled false",
      category: "preference",
      importance: 0.7,
      source: "test",
      entity: "feature",
      key: "enabled",
      value: "false",
    });
    factsDb.recordContradiction(b.id, a.id);
    expect(factsDb.isContradicted(a.id)).toBe(true);

    const run = store.createDreamRun({
      id: "dream-cx-del",
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "delete",
        targetFactId: a.id,
        preHash: factsDb.getOccToken(a.id) ?? "x",
        payload: {
          text: "delete a",
          category: "other",
          importance: 0,
          source: "dream",
          entity: null,
          key: null,
          value: null,
        },
        evidence: {
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "delete contradicted side",
        },
        reverse: { op: "noop", payload: {} },
      },
    ]);

    const entry = store.listCandidateEntries(run.id)[0]!;
    expect(evaluateContradictionWorsening(factsDb, entry).worsens).toBe(true);

    const report = evaluateDreamGates(store, run.id, DEFAULT_DREAMING_CONFIG, factsDb);
    expect(report.ok).toBe(false);
    expect(report.decisions[0]?.reason).toMatch(/contradiction_worsens|deletes_unresolved/);
  });

  it("allows dream contradiction-resolve deletes of unresolved losing side", () => {
    const a = factsDb.store({
      text: "feature enabled true",
      category: "preference",
      importance: 0.7,
      source: "test",
      entity: "feature",
      key: "enabled",
      value: "true",
      provenanceSession: "s1",
    });
    const b = factsDb.store({
      text: "feature enabled false",
      category: "preference",
      importance: 0.7,
      source: "test",
      entity: "feature",
      key: "enabled",
      value: "false",
      provenanceSession: "s1",
    });
    factsDb.recordContradiction(b.id, a.id);

    const run = store.createDreamRun({
      id: "dream-cx-resolve",
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: true,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "delete",
        targetFactId: a.id,
        preHash: factsDb.getOccToken(a.id)!,
        payload: {
          text: "resolve drop a",
          category: "preference",
          importance: 0,
          source: "dream-contradictions",
          entity: null,
          key: null,
          value: null,
          tags: ["dream", "contradiction-resolve"],
          scope: "session",
          scopeTarget: "s1",
        },
        evidence: {
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "auto-resolve",
        },
        reverse: { op: "noop", payload: {} },
      },
    ]);
    const entry = store.listCandidateEntries(run.id)[0]!;
    expect(evaluateContradictionWorsening(factsDb, entry).worsens).toBe(false);
  });

  it("passes unstructured add without entity/key", () => {
    const run = store.createDreamRun({
      id: "dream-cx-ok",
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: true,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "narrative preference without entity key",
          category: "preference",
          importance: 0.5,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "session",
          scopeTarget: "s1",
        },
        evidence: {
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "ok",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);
    const entry = store.listCandidateEntries(run.id)[0]!;
    expect(evaluateContradictionWorsening(factsDb, entry)).toEqual({ worsens: false, reason: "no_entity_key" });
  });
});
