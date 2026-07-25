/**
 * Dream steering + outcome probe + canary (#2176 / #2173).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "../backends/workflow-store.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { evaluateDreamGates } from "../services/dream-promote.js";
import { promoteDreamRun } from "../services/dream-promote.js";
import { applyDreamCanaryBoost, hasDreamCanaryTag } from "../services/dream-canary.js";
import { dreamRunTag, collectDreamMetricSet } from "../services/dream-metrics.js";
import { probeDreamOutcomes } from "../services/dream-outcome-probe.js";
import { formatSteeringPromptBlock, resolveSteering, shouldSteeringIgnore } from "../services/dream-steering.js";
import { runDream } from "../services/dream-run.js";

describe("dream canary boost (#2173)", () => {
  it("detects dream-run tags and boosts recall scores", () => {
    expect(hasDreamCanaryTag(["dream-run:dream-1"])).toBe(true);
    expect(hasDreamCanaryTag(["preference"])).toBe(false);
    const boosted = applyDreamCanaryBoost(
      [
        { score: 1, entry: { tags: ["dream-run:x"] } },
        { score: 1.05, entry: { tags: ["other"] } },
      ],
      { enabled: true },
    );
    expect(boosted[0]!.entry.tags?.[0]).toContain("dream-run:");
    expect(boosted[0]!.score).toBeGreaterThan(1.05);
  });
});

describe("dream steering (#2176)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;
  let workflowStore: WorkflowStore;
  let workflowDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-steer-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
    workflowDbPath = join(tmpDir, "workflow-traces.db");
    workflowStore = new WorkflowStore(workflowDbPath);
  });

  afterEach(() => {
    workflowStore.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores resolved steering snapshot on dream run metrics (#2176)", async () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.enabled = true;
    cfg.candidateStore = { enabled: true, shadow: true };
    cfg.steering = {
      profile: "coding",
      promote: [],
      ignore: [],
      notes: "prefer procedures",
    };
    const result = await runDream({
      factsDb,
      store,
      cfg,
      sessionIds: ["s1"],
      excludedSessions: [{ sessionId: "s-private", reason: "acl_too_private" }],
      steps: {},
      promote: false,
    });
    expect(result.run.steeringPolicyId).toBe("coding");
    const summary = JSON.parse(result.run.metricsSummaryJson ?? "{}") as {
      steering?: { profile: string; notes: string | null; promote: string[] };
      attachment?: { includedCount: number; excludedCount: number; excluded: Array<{ sessionId: string }> };
    };
    expect(summary.steering?.profile).toBe("coding");
    expect(summary.steering?.notes).toBe("prefer procedures");
    expect(summary.steering?.promote).toContain("procedure");
    expect(summary.attachment?.includedCount).toBe(1);
    expect(summary.attachment?.excludedCount).toBe(1);
    expect(summary.attachment?.excluded[0]?.sessionId).toBe("s-private");
  });

  it("uses attached-session terminal workflow outcomes before feedback proxies (#2173)", () => {
    const now = Date.now();
    workflowStore.record({ goal: "attached success", toolSequence: ["read"], outcome: "success", sessionId: "s1" });
    workflowStore.record({ goal: "attached failure", toolSequence: ["read"], outcome: "failure", sessionId: "s1" });
    workflowStore.record({ goal: "unattached failure", toolSequence: ["read"], outcome: "failure", sessionId: "other" });
    const metrics = collectDreamMetricSet(factsDb, {
      fromSec: Math.floor(now / 1000) - 5,
      toSec: Math.floor(now / 1000) + 5,
      sessionIds: ["s1"],
      workflowDbPath,
    });
    expect(metrics.signalSource).toBe("task_success");
    expect(metrics.successRate).toBe(0.5);
    expect(metrics.sessionsObserved).toBe(1);
  });

  it("resolves profile defaults", () => {
    const s = resolveSteering({ profile: "coding", promote: [], ignore: [], notes: undefined });
    expect(s.promote).toContain("procedure");
    expect(s.ignore).toContain("one_off_debug");
    expect(formatSteeringPromptBlock(s)).toContain("Dream steering policy");
  });

  it("blocks ignored categories at gate", () => {
    expect(
      shouldSteeringIgnore("preference", "one_off_debug", "transient path note", {
        profile: "personal",
        promote: ["preference"],
        ignore: ["one_off_debug"],
      }),
    ).toBe(true);
  });

  it("ignore-list reduces gated candidate volume (#2176)", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.requireProvenance = false;
    cfg.permissionBoundary.targetScope = "global";
    cfg.prevalence.session = { minSessions: 1, minAgents: 1 };
    cfg.steering = { profile: "personal", promote: ["preference"], ignore: ["one_off_debug"], notes: undefined };

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: true,
      steeringPolicyId: "personal",
    });
    expect(run.steeringPolicyId).toBe("personal");
    const entryBase = {
      op: "add" as const,
      payload: {
        category: "preference" as const,
        importance: 0.5,
        source: "dream" as const,
        entity: null,
        key: null,
        value: null,
        scope: "session" as const,
        scopeTarget: "s1",
      },
      evidence: {
        sessionIds: ["s1"],
        prevalence: { sessions: 1, agents: 1 },
        rationale: "fixture",
      },
      reverse: { op: "delete_fact" as const, payload: {} },
    };
    store.appendCandidateEntries(run.id, [
      {
        ...entryBase,
        payload: { ...entryBase.payload, text: "scratch note", key: "one_off_debug" },
      },
      { ...entryBase, payload: { ...entryBase.payload, text: "durable user preference" } },
    ]);

    const report = evaluateDreamGates(store, run.id, cfg, factsDb);
    expect(report.decisions.filter((d) => d.reason === "steering_ignore")).toHaveLength(1);
    expect(report.decisions.filter((d) => d.pass)).toHaveLength(1);
  });
});

describe("dream outcome probe (#2173)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;
  let workflowStore: WorkflowStore;
  let workflowDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-probe-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
    workflowDbPath = join(tmpDir, "workflow-traces.db");
    workflowStore = new WorkflowStore(workflowDbPath);
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scopes feedback metrics to dream sessions — ignores unrelated global corrections", () => {
    const now = Math.floor(Date.now() / 1000);
    factsDb.store({
      text: "unrelated global correction",
      category: "preference",
      importance: 0.5,
      source: "self-correction",
      entity: null,
      key: null,
      value: null,
      scope: "global",
    });
    factsDb.store({
      text: "in-session correction",
      category: "preference",
      importance: 0.5,
      source: "self-correction",
      entity: null,
      key: null,
      value: null,
      scope: "session",
      scopeTarget: "s1",
    });
    const metrics = collectDreamMetricSet(factsDb, {
      fromSec: now - 60,
      toSec: now + 60,
      sessionIds: ["s1"],
    });
    expect(metrics.retryRate).toBe(1);
    expect(metrics.sessionsObserved).toBe(1);
  });

  it("tags promoted facts with dream-run id", () => {
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
          text: "tagged fact",
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

    const result = promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    expect(result.applied).toBe(true);
    const factId = result.appliedFactIds[0]!;
    const fact = factsDb.getById(factId);
    expect(fact?.tags).toContain(dreamRunTag(run.id));
    expect(store.getDreamRun(run.id)?.metricsBaselineJson).toBeTruthy();
  });

  it("probe rolls back on regression after observe window", () => {
    const cfg = structuredClone(DEFAULT_DREAMING_CONFIG);
    cfg.autoPromote.enabled = true;
    cfg.autoRollback.enabled = true;
    cfg.autoRollback.regressionThreshold = 0.15;
    cfg.candidateStore.shadow = false;
    cfg.permissionBoundary.targetScope = "session";

    const sessionIds = ["s1", "s2", "s3"];
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds,
      shadow: false,
    });
    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "probe rollback",
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
          sessionIds,
          prevalence: { sessions: 3, agents: 1 },
          rationale: "ok",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    promoteDreamRun(factsDb, store, run.id, { force: true, cfg });
    const promotedAt = store.getDreamRun(run.id)?.promotedAt ?? Math.floor(Date.now() / 1000);
    store.updateDreamRunStatus(run.id, "promoted", {
      metricsBaselineJson: JSON.stringify({
        successRate: 1,
        retryRate: 0,
        effectScore: 1,
        sessionsObserved: 3,
      }),
      metricsObserveUntil: promotedAt - 1,
    });
    for (const sid of sessionIds) {
      factsDb.store({
        text: `post-promote failure ${sid}`,
        category: "preference",
        importance: 0.5,
        source: "self-correction",
        entity: null,
        key: null,
        value: null,
        scope: "session",
        scopeTarget: sid,
      });
    }

    const probe = probeDreamOutcomes(factsDb, store, {
      cfg,
      applyRollback: true,
      nowSec: promotedAt + 99999,
      force: true,
      limit: 5,
    });
    expect(probe.examined).toBe(1);
    expect(probe.rolledBack).toBe(1);
  });
});
