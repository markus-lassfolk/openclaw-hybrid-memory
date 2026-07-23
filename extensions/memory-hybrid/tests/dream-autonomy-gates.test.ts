/**
 * Dream prevalence / permission / outcome / ROI (#2172–#2174, #2179).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { evaluateDreamOutcome } from "../services/dream-outcome.js";
import { selectDreamSessions } from "../services/dream-permission.js";
import { promoteDreamRun } from "../services/dream-promote.js";
import { buildDreamRoiReport } from "../services/dream-roi.js";

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
});

describe("dream permission (#2174)", () => {
  it("excludes unresolved ACL and private→global leakage", () => {
    const result = selectDreamSessions(
      [
        { sessionId: "ok", effectiveScope: "session" },
        { sessionId: "private", effectiveScope: "user" },
        { sessionId: "unknown", effectiveScope: null },
      ],
      { targetScope: "agent", enforce: true, personalMode: false },
      20,
    );
    expect(result.included).toEqual(["ok"]);
    expect(result.excluded.map((e) => e.sessionId).sort()).toEqual(["private", "unknown"]);
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

  it("detects regression and applies auto-rollback when enabled", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.autoRollback.enabled = true;
    cfg.autoRollback.regressionThreshold = 0.15;
    cfg.candidateStore.shadow = false;

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
    const report = buildDreamRoiReport(store, { limit: 10 });
    expect(report.aggregates.runCount).toBeGreaterThanOrEqual(1);
    expect(report.howToRead.length).toBeGreaterThan(20);
  });
});
