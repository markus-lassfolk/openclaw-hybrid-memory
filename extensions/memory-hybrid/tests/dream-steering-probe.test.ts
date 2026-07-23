/**
 * Dream steering + outcome probe (#2176 / #2173).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { evaluateDreamGates } from "../services/dream-promote.js";
import { promoteDreamRun } from "../services/dream-promote.js";
import { dreamRunTag } from "../services/dream-metrics.js";
import { probeDreamOutcomes } from "../services/dream-outcome-probe.js";
import {
  formatSteeringPromptBlock,
  resolveSteering,
  shouldSteeringIgnore,
} from "../services/dream-steering.js";

describe("dream steering (#2176)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-steer-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
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
    });
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
      { ...entryBase, payload: { ...entryBase.payload, text: "one_off_debug scratch note" } },
      { ...entryBase, payload: { ...entryBase.payload, text: "durable user preference" } },
    ]);

    const report = evaluateDreamGates(store, run.id, cfg);
    expect(report.decisions.filter((d) => d.reason === "steering_ignore")).toHaveLength(1);
    expect(report.decisions.filter((d) => d.pass)).toHaveLength(1);
  });
});

describe("dream outcome probe (#2173)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-probe-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
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

    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
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
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
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
    factsDb.store({
      text: "post-promote failure",
      category: "preference",
      importance: 0.5,
      source: "self-correction",
      entity: null,
      key: null,
      value: null,
      scope: "session",
      scopeTarget: "s1",
    });

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
