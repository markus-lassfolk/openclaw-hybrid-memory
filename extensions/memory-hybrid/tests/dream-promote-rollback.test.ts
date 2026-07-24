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

  it("applies only gated_ok entries when a mixed batch partially passes", () => {
    const before = factsDb.count();
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "good session insight with enough text for store",
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
          rationale: "ok",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
      {
        op: "add",
        payload: {
          text: "agent write that exceeds session boundary",
          category: "preference",
          importance: 0.7,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "agent",
          scopeTarget: "dream-multi",
        },
        evidence: {
          sessionIds: ["s1", "s2"],
          prevalence: { sessions: 2, agents: 1 },
          rationale: "multi",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const dreaming = cfg({ enabled: true, shadow: false });
    dreaming.permissionBoundary = { targetScope: "session", enforce: true, personalMode: false };
    dreaming.autoPromote.shadowValidation.enabled = false;

    const result = promoteDreamRun(factsDb, store, run.id, { cfg: dreaming, force: true });
    expect(result.gateReport.ok).toBe(true);
    expect(result.gateReport.decisions.filter((d) => d.pass)).toHaveLength(1);
    expect(result.gateReport.decisions.filter((d) => !d.pass)).toHaveLength(1);
    expect(result.applied).toBe(true);
    expect(result.appliedFactIds).toHaveLength(1);
    expect(factsDb.count()).toBe(before + 1);
  });

  it("empty candidates gate with wouldPromote false and never promote", () => {
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    const dreaming = cfg({ enabled: true, shadow: false });
    dreaming.autoPromote.shadowValidation.enabled = false;
    const result = promoteDreamRun(factsDb, store, run.id, { cfg: dreaming, force: true });
    expect(result.status).toBe("gated");
    expect(result.applied).toBe(false);
    expect(result.gateReport.wouldPromote).toBe(false);
    expect(result.gateReport.reason).toBe("no_candidates");
    expect(store.getDreamRun(run.id)?.status).toBe("gated");
  });

  it("confidence gate fails closed when minConfidence is set but payload omits confidence", () => {
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "user scoped fact without confidence field",
          category: "preference",
          importance: 0.7,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "user",
          scopeTarget: "u1",
        },
        evidence: {
          sessionIds: ["s1", "s2"],
          prevalence: { sessions: 2, agents: 1 },
          rationale: "ok",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);
    const dreaming = cfg({ enabled: true, shadow: false });
    dreaming.permissionBoundary = { targetScope: "user", enforce: true, personalMode: false };
    dreaming.prevalence.user = { minSessions: 2, minAgents: 1, minConfidence: 0.7 };
    dreaming.autoPromote.shadowValidation.enabled = false;
    const result = promoteDreamRun(factsDb, store, run.id, { cfg: dreaming, force: true });
    expect(result.status).toBe("quarantined");
    expect(result.gateReport.decisions[0]?.reason).toMatch(/confidence_missing_required/);
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

  it("rollback of a delete op restores the fact instead of hard-deleting it", () => {
    // Regression: `unsupersede` reverse plans with `newFactId: null` used to fall back to
    // `entry.appliedFactId` (which equals the target for a delete op) and then hard-delete
    // the just-restored fact, silently defeating rollback for every delete/contradiction path.
    const target = factsDb.store({
      text: "fact to be soft-deleted then restored",
      category: "preference",
      importance: 0.6,
      source: "test",
      entity: null,
      key: null,
      value: null,
      scope: "session",
      scopeTarget: "s1",
      provenanceSession: "s1",
    });
    const preHash = factsDb.getOccToken(target.id)!;
    const beforeCount = factsDb.count();

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "delete",
        targetFactId: target.id,
        preHash,
        payload: {
          text: "drop legacy fact",
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
          rationale: "resolve",
        },
        reverse: { op: "unsupersede", payload: { oldFactId: target.id, newFactId: null } },
      },
    ]);

    const dreaming = cfg({ enabled: true, shadow: false });
    dreaming.permissionBoundary = { targetScope: "session", enforce: true, personalMode: false };
    dreaming.autoPromote.shadowValidation.enabled = false;
    dreaming.autoPromote.blockOnContradictionWorsening = false;

    const promoted = promoteDreamRun(factsDb, store, run.id, { force: true, cfg: dreaming });
    expect(promoted.applied).toBe(true);
    // Soft-delete keeps the row in `facts`; superseded_at is set.
    const afterPromoteRow = factsDb
      .getRawDb()
      .prepare("SELECT id, superseded_at FROM facts WHERE id = ?")
      .get(target.id) as { id: string; superseded_at: number | null } | undefined;
    expect(afterPromoteRow?.id).toBe(target.id);
    expect(afterPromoteRow?.superseded_at).not.toBeNull();
    expect(factsDb.count()).toBe(beforeCount);

    const rolled = rollbackDreamRun(factsDb, store, run.id, { reason: "test" });
    expect(rolled.rolledBack).toBe(true);
    expect(rolled.abortedEntries).toEqual([]);
    // The fact must be alive again — not silently hard-deleted by the rollback path.
    const restored = factsDb.getById(target.id);
    expect(restored).not.toBeNull();
    expect(restored?.text).toBe("fact to be soft-deleted then restored");
    const afterRollbackRow = factsDb
      .getRawDb()
      .prepare("SELECT superseded_at FROM facts WHERE id = ?")
      .get(target.id) as { superseded_at: number | null } | undefined;
    expect(afterRollbackRow?.superseded_at).toBeNull();
    expect(factsDb.count()).toBe(beforeCount);
  });

  it("rollback of a supersede op restores the old fact and hard-deletes the replacement", () => {
    // Companion to the delete-rollback test: `supersede` reverse plans set `newFactId` to
    // the replacement's id explicitly, so rollback must delete that specific fact (not
    // the restored target).
    const target = factsDb.store({
      text: "original preference",
      category: "preference",
      importance: 0.6,
      source: "test",
      entity: null,
      key: null,
      value: null,
      scope: "session",
      scopeTarget: "s1",
      provenanceSession: "s1",
    });
    const preHash = factsDb.getOccToken(target.id)!;
    const beforeCount = factsDb.count();

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "supersede",
        targetFactId: target.id,
        preHash,
        payload: {
          text: "replacement preference",
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
          rationale: "supersede",
        },
        reverse: { op: "unsupersede", payload: { oldFactId: target.id } },
      },
    ]);

    const dreaming = cfg({ enabled: true, shadow: false });
    dreaming.permissionBoundary = { targetScope: "session", enforce: true, personalMode: false };
    dreaming.autoPromote.shadowValidation.enabled = false;
    dreaming.autoPromote.blockOnContradictionWorsening = false;

    const promoted = promoteDreamRun(factsDb, store, run.id, { force: true, cfg: dreaming });
    expect(promoted.applied).toBe(true);
    const replacementId = promoted.appliedFactIds[0]!;
    expect(replacementId).not.toBe(target.id);
    // Row count grows by one: target survives as superseded, replacement adds a row.
    expect(factsDb.count()).toBe(beforeCount + 1);
    expect(factsDb.getById(replacementId)?.text).toBe("replacement preference");

    const rolled = rollbackDreamRun(factsDb, store, run.id, { reason: "test" });
    expect(rolled.rolledBack).toBe(true);
    expect(rolled.abortedEntries).toEqual([]);
    // Target restored, replacement hard-deleted.
    expect(factsDb.getById(target.id)?.text).toBe("original preference");
    const restoredRow = factsDb.getRawDb().prepare("SELECT superseded_at FROM facts WHERE id = ?").get(target.id) as
      | { superseded_at: number | null }
      | undefined;
    expect(restoredRow?.superseded_at).toBeNull();
    const gone = factsDb.getRawDb().prepare("SELECT id FROM facts WHERE id = ?").get(replacementId);
    expect(gone).toBeUndefined();
    expect(factsDb.count()).toBe(beforeCount);
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
