/**
 * Shadow ROI validation before autoPromote (#2179).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { promoteDreamRun } from "../services/dream-promote.js";
import { evaluateShadowValidation, evaluateShadowValidationFromStore } from "../services/dream-shadow-validation.js";
import type { DreamRoiReport } from "../services/dream-roi.js";

function emptyReport(runs: DreamRoiReport["runs"] = []): DreamRoiReport {
  const untilSec = Math.floor(Date.now() / 1000);
  return {
    sinceSec: untilSec - 30 * 86_400,
    untilSec,
    runs,
    aggregates: {
      runCount: runs.length,
      promoted: 0,
      rolledBack: 0,
      quarantined: 0,
      shadowOnly: runs.filter((r) => r.shadow).length,
      candidateToPromoteRatio: null,
      dreamTokens: null,
      dreamUsdProxy: null,
    },
    howToRead: "test",
  };
}

describe("dream-shadow-validation", () => {
  it("fails closed with zero shadow runs", () => {
    const result = evaluateShadowValidation(emptyReport());
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("min_shadow_runs_"))).toBe(true);
  });

  it("passes when disabled", () => {
    const result = evaluateShadowValidation(emptyReport(), {
      thresholds: { ...DEFAULT_DREAMING_CONFIG.autoPromote.shadowValidation, enabled: false },
    });
    expect(result.ok).toBe(true);
  });

  it("passes with enough gated shadow runs", () => {
    const now = Math.floor(Date.now() / 1000);
    const runs: DreamRoiReport["runs"] = Array.from({ length: 7 }, (_, i) => ({
      dreamRunId: `dream-${i}`,
      status: "gated" as const,
      shadow: true,
      createdAt: now - i * 3600,
      promotedAt: null,
      rolledBackAt: null,
      candidateCount: 2,
      cost: { feature: "dream" as const, wallSeconds: null, tokens: null, usdProxy: null, source: "insufficient_data" as const },
      outcome: { baseline: null, summary: "shadow" as const },
    }));
    const gateReportsByRunId = new Map(
      runs.map((r) => [r.dreamRunId, JSON.stringify({ wouldPromote: true, ok: true })]),
    );
    const result = evaluateShadowValidation(emptyReport(runs), {
      thresholds: {
        ...DEFAULT_DREAMING_CONFIG.autoPromote.shadowValidation,
        minShadowRuns: 7,
        minWouldPromoteRuns: 3,
      },
      gateReportsByRunId,
    });
    expect(result.ok).toBe(true);
    expect(result.metrics.wouldPromoteRuns).toBe(7);
  });

  it("does not count gated status alone as would-promote", () => {
    const now = Math.floor(Date.now() / 1000);
    const runs: DreamRoiReport["runs"] = [
      {
        dreamRunId: "dream-empty-gate",
        status: "gated",
        shadow: true,
        createdAt: now,
        promotedAt: null,
        rolledBackAt: null,
        candidateCount: 2,
        cost: {
          feature: "dream",
          wallSeconds: null,
          tokens: null,
          usdProxy: null,
          source: "insufficient_data",
        },
        outcome: { baseline: null, summary: "shadow" },
      },
    ];
    const result = evaluateShadowValidation(emptyReport(runs), {
      thresholds: {
        ...DEFAULT_DREAMING_CONFIG.autoPromote.shadowValidation,
        minShadowRuns: 1,
        minWouldPromoteRuns: 1,
      },
      gateReportsByRunId: new Map([["dream-empty-gate", JSON.stringify({ ok: true, wouldPromote: false })]]),
    });
    expect(result.metrics.wouldPromoteRuns).toBe(0);
    expect(result.ok).toBe(false);
  });
});

describe("promoteDreamRun shadowValidation gate", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-shadow-val-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks autoPromote apply when shadow history is insufficient", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.autoPromote.shadowValidation.enabled = true;
    cfg.permissionBoundary.targetScope = "session";
    cfg.permissionBoundary.personalMode = true;

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      steeringPolicyId: "personal",
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "should not apply without shadow validation",
          category: "preference",
          importance: 0.5,
          source: "test",
          entity: null,
          key: null,
          value: null,
          scope: "session",
          scopeTarget: "s1",
        },
        evidence: {
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "test",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const result = promoteDreamRun(factsDb, store, run.id, { cfg });
    expect(result.applied).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("shadow_validation_failed");
    expect(factsDb.count()).toBe(0);
  });

  it("allows autoPromote after enough gated shadow runs", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.autoPromote.shadowValidation.enabled = true;
    cfg.autoPromote.shadowValidation.minShadowRuns = 3;
    cfg.autoPromote.shadowValidation.minWouldPromoteRuns = 2;
    cfg.permissionBoundary.targetScope = "session";
    cfg.permissionBoundary.personalMode = true;

    for (let i = 0; i < 3; i++) {
      const shadow = store.createDreamRun({
        inputStoreRevision: factsDb.computeStoreRevision(),
        sessionIds: [`shadow-${i}`],
        steeringPolicyId: "personal",
        shadow: true,
      });
      store.appendCandidateEntries(shadow.id, [
        {
          op: "add",
          payload: {
            text: `shadow candidate ${i}`,
            category: "preference",
            importance: 0.5,
            source: "test",
            entity: null,
            key: null,
            value: null,
            scope: "session",
            scopeTarget: `shadow-${i}`,
          },
          evidence: {
            sessionIds: [`shadow-${i}`],
            prevalence: { sessions: 1, agents: 1 },
            rationale: "shadow history",
          },
          reverse: { op: "delete_fact", payload: {} },
        },
      ]);
      store.updateDreamRunStatus(shadow.id, "running");
      store.updateDreamRunStatus(shadow.id, "gated", {
        gateReportJson: JSON.stringify({ wouldPromote: true, ok: true }),
      });
    }

    const live = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["live-1"],
      steeringPolicyId: "personal",
      shadow: false,
    });
    store.appendCandidateEntries(live.id, [
      {
        op: "add",
        payload: {
          text: "live apply after shadow ROI passes",
          category: "preference",
          importance: 0.5,
          source: "test",
          entity: null,
          key: null,
          value: null,
          scope: "session",
          scopeTarget: "live-1",
        },
        evidence: {
          sessionIds: ["live-1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "live",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    const validation = evaluateShadowValidationFromStore(store, {
      thresholds: cfg.autoPromote.shadowValidation,
    });
    expect(validation.ok).toBe(true);

    const result = promoteDreamRun(factsDb, store, live.id, { cfg });
    expect(result.error ?? null).toBeNull();
    expect(result.applied).toBe(true);
    expect(result.status).toBe("promoted");
    expect(factsDb.count()).toBe(1);
  });

  it("validate-shadow from empty store fails", () => {
    const result = evaluateShadowValidationFromStore(store, {
      thresholds: DEFAULT_DREAMING_CONFIG.autoPromote.shadowValidation,
    });
    expect(result.ok).toBe(false);
  });
});
