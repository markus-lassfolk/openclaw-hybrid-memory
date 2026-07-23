/**
 * Dream prevalence / permission / outcome / ROI / OCC (#2172–#2175, #2179).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { evaluateDreamOutcome } from "../services/dream-outcome.js";
import {
  discoverDreamSessionAcls,
  selectDreamSessions,
  writeScopeWithinBoundary,
} from "../services/dream-permission.js";
import { promoteDreamRun } from "../services/dream-promote.js";
import { buildDreamRoiReport } from "../services/dream-roi.js";
import { runDream } from "../services/dream-run.js";

describe("dream prevalence gate (#2172)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-prev-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks single-session global promote by default", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "global";

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "global curriculum",
          category: "preference",
          importance: 0.9,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "global",
        },
        evidence: {
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "seen once",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const result = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(result.status).toBe("quarantined");
    expect(result.gateReport.decisions[0]?.reason).toMatch(/prevalence_insufficient_global/);
  });

  it("allows single-session session-tier promote (agent bar does not apply)", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "session";

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "session scratch",
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
          rationale: "one session ok",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const result = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(result.status).toBe("promoted");
    expect(result.applied).toBe(true);
  });

  it("personalSingleTenant lowers global agent bar to 1", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "global";
    cfg.prevalence.personalSingleTenant = true;

    const run = store.createDreamRun({
      id: "dream-pst-block",
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1", "s2"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "personal vault global",
          category: "preference",
          importance: 0.8,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "global",
        },
        evidence: {
          sessionIds: ["s1", "s2"],
          prevalence: { sessions: 2, agents: 1 },
          rationale: "two sessions one agent",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const blocked = promoteDreamRun(factsDb, store, run.id, {
      force: true,
      cfg: { ...cfg, prevalence: { ...cfg.prevalence, personalSingleTenant: false } },
    });
    expect(blocked.status).toBe("quarantined");
    expect(blocked.gateReport.decisions[0]?.reason).toMatch(/prevalence_insufficient_global/);

    // Fresh run — previous entry was gated_block
    const run2 = store.createDreamRun({
      id: "dream-pst-allow",
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1", "s2"],
      shadow: false,
    });
    store.appendCandidateEntries(run2.id, [
      {
        op: "add",
        payload: {
          text: "personal vault global 2",
          category: "preference",
          importance: 0.8,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "global",
        },
        evidence: {
          sessionIds: ["s1", "s2"],
          prevalence: { sessions: 2, agents: 1 },
          rationale: "two sessions one agent",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);
    const allowed = promoteDreamRun(factsDb, store, run2.id, { force: true, cfg });
    expect(allowed.status).toBe("promoted");
  });
});

describe("dream permission (#2174)", () => {
  it("excludes private session/user from global dreams by default", () => {
    const result = selectDreamSessions(
      [
        { sessionId: "pub", effectiveScope: "global" },
        { sessionId: "private", effectiveScope: "user" },
        { sessionId: "sess", effectiveScope: "session" },
        { sessionId: "unknown", effectiveScope: null },
      ],
      { targetScope: "global", enforce: true, personalMode: false },
      20,
    );
    expect(result.included).toEqual(["pub"]);
    expect(result.excluded.map((e) => e.sessionId).sort()).toEqual(["private", "sess", "unknown"]);
  });

  it("clamps write scope to dream boundary", () => {
    expect(writeScopeWithinBoundary("global", { targetScope: "session", enforce: true, personalMode: false })).toBe(
      false,
    );
    expect(writeScopeWithinBoundary("session", { targetScope: "global", enforce: true, personalMode: false })).toBe(
      true,
    );
  });

  it("discovers nightly sessions with fail-closed ACL (never invent global from fact writes)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dream-discover-"));
    const factsDb = new FactsDB(join(tmpDir, "facts.db"));
    const openclawHome = join(tmpDir, "openclaw");
    try {
      mkdirSync(join(openclawHome, "agents", "main", "sessions"), { recursive: true });
      writeFileSync(join(openclawHome, "agents", "main", "sessions", "sess-pub.jsonl"), "{}\n");

      factsDb.store({
        text: "session-scoped fact",
        category: "preference",
        importance: 0.5,
        source: "test",
        entity: null,
        key: null,
        value: null,
        scope: "session",
        scopeTarget: "sess-a",
        provenanceSession: "sess-a",
      });
      factsDb.store({
        text: "global-scoped fact from session",
        category: "preference",
        importance: 0.5,
        source: "test",
        entity: null,
        key: null,
        value: null,
        scope: "global",
        provenanceSession: "sess-pub",
      });
      const bad = factsDb.store({
        text: "orphan provenance",
        category: "preference",
        importance: 0.5,
        source: "test",
        entity: null,
        key: null,
        value: null,
        scope: "session",
        scopeTarget: "sess-bad",
        provenanceSession: "sess-bad",
      });
      factsDb.getRawDb().prepare("UPDATE facts SET scope = ? WHERE id = ?").run("not-a-scope", bad.id);

      const discovered = discoverDreamSessionAcls(factsDb.getRawDb(), {
        lookbackDays: 7,
        limit: 20,
        openclawHome,
      });
      expect(discovered.find((d) => d.sessionId === "sess-a")?.effectiveScope).toBe("session");
      // Global fact writes do not prove public ACL; transcript path floors to agent.
      expect(discovered.find((d) => d.sessionId === "sess-pub")?.effectiveScope).toBe("agent");
      expect(discovered.find((d) => d.sessionId === "sess-bad")?.effectiveScope ?? null).toBeNull();

      const withoutArtifact = discoverDreamSessionAcls(factsDb.getRawDb(), {
        lookbackDays: 7,
        limit: 20,
        resolveArtifact: false,
      });
      expect(withoutArtifact.find((d) => d.sessionId === "sess-pub")?.effectiveScope ?? null).toBeNull();

      const sessionDream = selectDreamSessions(
        discovered,
        { targetScope: "session", enforce: true, personalMode: false },
        20,
      );
      expect(sessionDream.included.sort()).toEqual(["sess-a", "sess-pub"].sort());
      expect(sessionDream.excluded.some((e) => e.sessionId === "sess-bad" && e.reason === "unresolved_acl")).toBe(
        true,
      );

      const globalDream = selectDreamSessions(
        discovered,
        { targetScope: "global", enforce: true, personalMode: false },
        20,
      );
      // Neither session nor agent ACL feeds a global dream without explicit --session-scopes.
      expect(globalDream.included).toEqual([]);
      expect(globalDream.excluded.map((e) => e.sessionId).sort()).toEqual(["sess-a", "sess-bad", "sess-pub"].sort());
    } finally {
      factsDb.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("dream compose + OCC (#2170/#2171/#2175)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-compose-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shadow compose does not mutate live facts and promote does not fail OCC", async () => {
    const before = factsDb.count();
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.enabled = true;
    cfg.candidateStore.enabled = true;
    cfg.candidateStore.shadow = true;
    cfg.autoPromote.enabled = false;
    cfg.promoteAfterRun = true;
    cfg.permissionBoundary.targetScope = "session";

    const mutating = vi.fn(async ({ dryRun }: { dryRun: boolean }) => {
      if (!dryRun) {
        factsDb.store({
          text: "should not write in shadow",
          category: "preference",
          importance: 0.5,
          source: "test",
          entity: null,
          key: null,
          value: null,
        });
      }
      return {
        detail: `dryRun=${dryRun}`,
        candidates: [
          {
            op: "add" as const,
            payload: {
              text: "shadow proposed preference",
              category: "preference",
              importance: 0.5,
              entity: null,
              key: null,
              value: null,
              source: "dream-distill",
              scope: "session" as const,
              scopeTarget: "s1",
            },
            evidence: {
              sessionIds: ["s1"],
              prevalence: { sessions: 1, agents: 1 },
              rationale: "shadow compose proposal",
            },
            reverse: { op: "delete_fact" as const, payload: {} },
          },
        ],
      };
    });

    const result = await runDream({
      factsDb,
      store,
      cfg,
      sessionIds: ["s1"],
      dryShadow: true,
      promote: true,
      steps: { distill: mutating },
    });

    expect(mutating).toHaveBeenCalled();
    expect(mutating.mock.calls[0]![0].dryRun).toBe(true);
    expect(factsDb.count()).toBe(before);
    expect(result.candidates.length).toBe(1);
    expect(result.promoteResult?.applied).toBe(false);
    expect(result.promoteResult?.error).toBeUndefined();
    expect(result.promoteResult?.status).not.toBe("failed");
  });

  it("supersede promote uses preHash OCC and fails on drift", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "session";

    const target = factsDb.store({
      text: "original",
      category: "preference",
      importance: 0.5,
      source: "test",
      entity: null,
      key: null,
      value: null,
      scope: "session",
      scopeTarget: "s1",
    });
    const preHash = factsDb.getOccToken(target.id)!;

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
          text: "replacement",
          category: "preference",
          importance: 0.6,
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
        reverse: { op: "unsupersede", payload: { oldFactId: target.id } },
      },
    ]);

    // Drift the target after propose.
    factsDb.restoreMergedFactText(target.id, "original MUTATED");

    const result = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(result.applied).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/memory_conflict|stale|conflict/i);
  });
});

describe("dream outcome + ROI (#2173/#2179)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-out-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures real baseline at promote — no invented perfect score", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.autoRollback.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "session";

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "promoted without fake baseline",
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

    const promoted = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(promoted.applied).toBe(true);
    const baseline = store.getDreamRun(run.id)?.metricsBaselineJson;
    expect(baseline).toBeTruthy();
    const parsed = JSON.parse(baseline!) as { effectScore: number };
    expect(parsed.effectScore).toBeLessThanOrEqual(1);
    expect(parsed.effectScore).toBeGreaterThanOrEqual(-1);

    const worseOutcome = evaluateDreamOutcome(
      factsDb,
      store,
      run.id,
      { successRate: 0.1, retryRate: 5, effectScore: -0.5, sessionsObserved: 5 },
      { cfg, applyRollback: false, minSessions: 3 },
    );
    expect(worseOutcome.decision).toBe("rollback");
    expect(worseOutcome.reason).toContain("would_rollback");
  });

  it("insufficient sessions never false-rollbacks (#2173)", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.autoRollback.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "session";

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "keep under insufficient data",
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

    const promoted = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(promoted.applied).toBe(true);
    store.updateDreamRunStatus(run.id, "promoted", {
      metricsBaselineJson: JSON.stringify({
        successRate: 1,
        retryRate: 0,
        effectScore: 1,
        sessionsObserved: 0,
      }),
    });
    const before = factsDb.count();

    const outcome = evaluateDreamOutcome(
      factsDb,
      store,
      run.id,
      { successRate: 0, retryRate: 99, effectScore: -1, sessionsObserved: 1 },
      { cfg, applyRollback: true, minSessions: 3 },
    );
    expect(outcome.decision).toBe("insufficient_data");
    expect(outcome.reason).toBe("insufficient_sessions");
    expect(outcome.rollback).toBeUndefined();
    expect(factsDb.count()).toBe(before);
  });

  it("auto-rollbacks when a real baseline regresses", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.autoRollback.enabled = true;
    cfg.autoRollback.regressionThreshold = 0.15;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "session";

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "to roll back",
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

    const promoted = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(promoted.applied).toBe(true);
    store.updateDreamRunStatus(run.id, "promoted", {
      metricsBaselineJson: JSON.stringify({
        successRate: 1,
        retryRate: 0,
        effectScore: 1,
        sessionsObserved: 0,
      }),
    });
    const before = factsDb.count();

    const outcome = evaluateDreamOutcome(
      factsDb,
      store,
      run.id,
      { successRate: 0.2, retryRate: 3, effectScore: 0.5, sessionsObserved: 5 },
      { cfg, applyRollback: true, nowSec: Math.floor(Date.now() / 1000) + 999999, minSessions: 3 },
    );
    expect(outcome.decision).toBe("rollback");
    expect(outcome.rollback?.rolledBack).toBe(true);
    expect(factsDb.count()).toBe(before - 1);
  });

  it("builds ROI report from fixture runs", () => {
    store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      shadow: true,
    });
    const report = buildDreamRoiReport(store, { limit: 10, db: factsDb.getRawDb() });
    expect(report.aggregates.runCount).toBeGreaterThanOrEqual(1);
    expect(report.howToRead.length).toBeGreaterThan(20);
    expect(report.runs[0]?.cost.source).toMatch(/llm_cost_log|insufficient_data/);
  });
});
