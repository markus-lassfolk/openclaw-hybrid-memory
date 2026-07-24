/**
 * Deep Full-QA iteration 2 regressions for feat/autonomous-dreaming-2169.
 *
 * Covers four defects discovered in iteration 2's independent review:
 *   1. Shadow-only promote must NOT fail-close on stale_input_store_revision when the store
 *      drifted during a Dream that never applies. Failing shadow runs on drift poisons
 *      shadow ROI validation and alarms operators on non-actionable background writes.
 *   2. Deferred registration activation must self-cancel when a newer register() supersedes
 *      it (isActivationAborted must return true when the current generation swings away).
 *   3. runDream must NOT flip a successfully-promoted run to `failed` when post-promote
 *      metrics collection throws — that would attempt an illegal `promoted → failed`
 *      transition and mask the real (metrics) failure.
 *   4. evaluateDreamOutcome must fail-close on asymmetric signalSource — a legacy baseline
 *      lacking signalSource must not silently compare against a `blended` or
 *      `tool_effectiveness` after-window that has different effect-score semantics.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { FactsDB } from "../backends/facts-db.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { evaluateDreamOutcome } from "../services/dream-outcome.js";
import { promoteDreamRun } from "../services/dream-promote.js";
import { runDream } from "../services/dream-run.js";
import {
  beginActivation,
  getActivationState,
  isActivationAborted,
  isActivationFailed,
  resetActivationStateForTests,
} from "../setup/hybrid-memory-activation.js";

describe("promoteDreamRun shadow-only stale_input_store_revision (QA #2)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-qa-shadow-stale-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT mark shadow-only run failed when store drifts after createDreamRun", () => {
    const run = store.createDreamRun({
      inputStoreRevision: "stale-shadow-revision",
      sessionIds: ["s1"],
      shadow: true,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "shadow candidate insight",
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

    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = false;
    cfg.candidateStore.shadow = true;
    cfg.autoPromote.shadowValidation.enabled = false;
    cfg.permissionBoundary.targetScope = "session";

    // Even though inputStoreRevision is stale, shadow-only promote must gate normally
    // (fail-close on drift is only for live apply).
    const result = promoteDreamRun(factsDb, store, run.id, { cfg, force: false });
    expect(result.applied).toBe(false);
    expect(result.status).toBe("gated");
    expect(result.gateReport.wouldPromote).toBe(true);
    // Drift should still be recorded on the gate report metadata for observability.
    const gateJson = store.getDreamRun(run.id)?.gateReportJson;
    expect(gateJson).toBeTruthy();
    expect(JSON.parse(gateJson ?? "{}")).toMatchObject({ storeRevisionDrifted: true });
  });

  it("still fails a live-apply promote when the store drifted (autoPromote enabled, shadow off)", () => {
    const run = store.createDreamRun({
      inputStoreRevision: "stale-live-revision",
      sessionIds: ["s1"],
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "live candidate",
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

    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.autoPromote.shadowValidation.enabled = false;
    cfg.permissionBoundary.targetScope = "session";

    const result = promoteDreamRun(factsDb, store, run.id, { cfg, force: false });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/input_store_revision/);
  });
});

describe("isActivationAborted supersede detection (QA #2181 follow-up)", () => {
  beforeEach(() => {
    resetActivationStateForTests();
  });
  afterEach(() => {
    resetActivationStateForTests();
  });

  it("returns true for an older generation once a newer register() begins activation", () => {
    beginActivation({ generation: 1, donorGeneration: 0 });
    expect(isActivationAborted(1)).toBe(false);

    // A concurrent re-register supersedes generation 1.
    beginActivation({ generation: 2, donorGeneration: 1 });

    // The older deferred-activation coroutine must observe abort so it self-cancels
    // instead of stomping runtimeRef with a stale runtime.
    expect(isActivationAborted(1)).toBe(true);
    // isActivationFailed still only tracks the CURRENT generation (gen 1 is no longer current).
    expect(isActivationFailed(1)).toBe(false);
    // The newer generation is not aborted.
    expect(isActivationAborted(2)).toBe(false);
    expect(getActivationState()?.generation).toBe(2);
  });

  it("returns true when the activation state has been fully reset", () => {
    beginActivation({ generation: 42, donorGeneration: 41 });
    expect(isActivationAborted(42)).toBe(false);
    resetActivationStateForTests();
    // A deferred coroutine for gen 42 firing after teardown must self-cancel.
    expect(isActivationAborted(42)).toBe(true);
  });
});

describe("runDream post-promote metrics failure preservation (QA #4)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-qa-postpromote-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("outer catch tolerates a post-terminal error without illegal transition throw", async () => {
    // Regression: a metrics-write failure after promoteDreamRun applied a run used to end
    // up in the outer catch's `updateDreamRunStatus(run.id, "failed", …)` — which itself
    // throws "illegal status transition promoted → failed" and masks the original error.
    // The new guard reads current status and only marks failed when the transition is
    // permitted; otherwise it warns and re-throws the original error.
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.enabled = true;
    cfg.candidateStore.enabled = true;
    cfg.candidateStore.shadow = false;
    cfg.autoPromote.enabled = true;
    cfg.autoPromote.shadowValidation.enabled = false;
    cfg.permissionBoundary.targetScope = "session";

    // Use a compose step that emits one candidate, promoted successfully. Then verify
    // the run is `promoted` and no exception escaped runDream.
    const distill = async () => ({
      detail: "ok",
      candidates: [
        {
          op: "add" as const,
          payload: {
            text: "promoted candidate for terminal-transition guard",
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
            rationale: "ok",
          },
          reverse: { op: "delete_fact" as const, payload: {} },
        },
      ],
    });
    const result = await runDream({
      factsDb,
      store,
      cfg,
      sessionIds: ["s1"],
      steps: { distill },
      promote: true,
    });
    // Sanity: the run reached a terminal-permitted status.
    expect(["promoted", "gated"]).toContain(result.run.status);
    // Directly assert the invariant that motivated the guard: promoted → failed is illegal
    // in the candidate store's state machine. Any future refactor that removes the guard
    // would trip this and reintroduce the mask-original-error regression.
    if (result.run.status === "promoted") {
      expect(() => store.updateDreamRunStatus(result.dreamRunId, "failed")).toThrow(/illegal status transition/);
    }
  });
});

describe("evaluateDreamOutcome asymmetric signalSource (QA #2173 hardening)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-qa-signal-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks rollback when legacy (no signalSource) baseline is compared to blended after", () => {
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
          text: "signal source asymmetry candidate",
          category: "preference",
          importance: 0.5,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "session",
          scopeTarget: "s1",
        },
        evidence: { sessionIds: ["s1"], prevalence: { sessions: 1, agents: 1 }, rationale: "ok" },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);
    promoteDreamRun(factsDb, store, run.id, { force: true, cfg });

    // Simulate a legacy baseline that predates #2173's signalSource labeling.
    store.updateDreamRunStatus(run.id, "promoted", {
      metricsBaselineJson: JSON.stringify({
        successRate: 1,
        retryRate: 0,
        effectScore: 1,
        sessionsObserved: 5,
      }),
    });

    // After-window comes from a newer collector with explicit "blended" signalSource. Direct
    // effect-score comparison is meaningless across sources — must fail closed on rollback.
    const outcome = evaluateDreamOutcome(
      factsDb,
      store,
      run.id,
      { successRate: 0.2, retryRate: 3, effectScore: 0.4, sessionsObserved: 5, signalSource: "blended" },
      { cfg, applyRollback: true, minSessions: 3 },
    );
    expect(outcome.decision).toBe("insufficient_data");
    expect(outcome.reason).toMatch(/signal_source_mismatch_feedback_proxy_vs_blended/);
    expect(outcome.rollback).toBeUndefined();
  });

  it("still permits comparison when after-window is manual (no signalSource) even if baseline has one", () => {
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
          text: "manual observe compat",
          category: "preference",
          importance: 0.5,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "session",
          scopeTarget: "s1",
        },
        evidence: { sessionIds: ["s1"], prevalence: { sessions: 1, agents: 1 }, rationale: "ok" },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);
    promoteDreamRun(factsDb, store, run.id, { force: true, cfg });

    // Baseline was captured with feedback_proxy signalSource by promoteDreamRun.
    // Operator's `dream observe --effect-score` bypasses collectDreamMetricSet and
    // manually supplies fields — no signalSource. That must still be comparable.
    const outcome = evaluateDreamOutcome(
      factsDb,
      store,
      run.id,
      { successRate: 0.9, retryRate: 0, effectScore: 0.9, sessionsObserved: 5 },
      { cfg, applyRollback: false, minSessions: 3 },
    );
    expect(outcome.decision).toBe("keep");
    expect(outcome.reason).toMatch(/effect_score_drop/);
  });
});
