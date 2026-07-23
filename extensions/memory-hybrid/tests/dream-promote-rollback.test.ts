/**
 * Dream promote / gate-reject / rollback / shadow (#2170).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamingConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { promoteDreamRun } from "../services/dream-promote.js";
import { rollbackDreamRun } from "../services/dream-rollback.js";

function cfg(partial: Partial<DreamingConfig["autoPromote"]> & { shadow?: boolean }): DreamingConfig {
  const base = structuredClone(DEFAULT_DREAMING_CONFIG);
  return {
    ...base,
    candidateStore: { enabled: true, shadow: partial.shadow !== false },
    autoPromote: {
      ...base.autoPromote,
      enabled: true,
      ...partial,
    },
  };
}

describe("dream promote/rollback (#2170)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-promo-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shadow mode gates without mutating live facts", () => {
    const before = factsDb.count();
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: true,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "shadow insight",
          category: "preference",
          importance: 0.7,
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
          rationale: "seen once",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const result = promoteDreamRun(factsDb, store, run.id, {
      cfg: cfg({ enabled: false, shadow: true }),
    });
    expect(result.applied).toBe(false);
    expect(result.shadow).toBe(true);
    expect(result.gateReport.wouldPromote).toBe(true);
    expect(factsDb.count()).toBe(before);
  });

  it("gate-rejects missing provenance and quarantines", () => {
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "no evidence",
          category: "preference",
          importance: 0.5,
          source: "dream",
          entity: null,
          key: null,
          value: null,
        },
        evidence: { sessionIds: [], prevalence: { sessions: 0, agents: 0 }, rationale: "" },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const result = promoteDreamRun(factsDb, store, run.id, {
      cfg: cfg({ enabled: true, shadow: false }),
      force: true,
    });
    expect(result.status).toBe("quarantined");
    expect(result.applied).toBe(false);
    expect(result.gateReport.decisions[0]?.reason).toBe("missing_provenance");
  });

  it("force-promotes an add and rollback deletes it", () => {
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: true,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "promoted curriculum fact",
          category: "preference",
          importance: 0.8,
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

    const before = factsDb.count();
    const promoted = promoteDreamRun(factsDb, store, run.id, {
      force: true,
      cfg: cfg({ enabled: true, shadow: false }),
    });
    expect(promoted.applied).toBe(true);
    expect(promoted.status).toBe("promoted");
    expect(factsDb.count()).toBe(before + 1);
    expect(promoted.appliedFactIds).toHaveLength(1);

    const rolled = rollbackDreamRun(factsDb, store, run.id, { reason: "test" });
    expect(rolled.rolledBack).toBe(true);
    expect(store.getDreamRun(run.id)?.status).toBe("rolled_back");
    expect(factsDb.count()).toBe(before);
  });

  it("refuses promote when input_store_revision is stale", () => {
    const run = store.createDreamRun({
      inputStoreRevision: "stale-revision",
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "should not apply",
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

    const result = promoteDreamRun(factsDb, store, run.id, {
      cfg: cfg({ enabled: true, shadow: false }),
      force: false,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/input_store_revision/);
  });

  it("rollback aborts entry on post_hash drift without deleting mutated fact", () => {
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "drift target",
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

    const promoted = promoteDreamRun(factsDb, store, run.id, {
      force: true,
      cfg: cfg({ enabled: true, shadow: false }),
    });
    expect(promoted.applied).toBe(true);
    const factId = promoted.appliedFactIds[0]!;
    factsDb.restoreMergedFactText(factId, "drift target MUTATED");

    const rolled = rollbackDreamRun(factsDb, store, run.id, { reason: "drift" });
    expect(rolled.rolledBack).toBe(false);
    expect(rolled.abortedEntries.some((a) => a.reason === "post_hash_drift")).toBe(true);
    expect(store.getDreamRun(run.id)?.status).toBe("promoted");
    expect(factsDb.getById(factId)?.text).toBe("drift target MUTATED");
  });
});
