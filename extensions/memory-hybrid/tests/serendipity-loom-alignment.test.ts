import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomStore } from "../backends/loom-store.js";
import { SerendipityStore } from "../backends/serendipity-store.js";
import { rankAttention } from "../services/attention-steward.js";

let tmpDir: string;
let store: SerendipityStore;
let loomStore: LoomStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "serendipity-loom-test-"));
  store = new SerendipityStore(join(tmpDir, "serendipity.db"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  store.close();
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Serendipity inbox — Loom alignment (#2149)", () => {
  it("defaults notAnActiveTask to true on creation", () => {
    const finding = store.create({ title: "t", description: "d", findingType: "other" });
    expect(finding.notAnActiveTask).toBe(true);
    expect(finding.relatedClaims).toEqual([]);
    expect(finding.leverage).toBe(0);
  });

  it("accepts leverage/risk-reduction/time-saved/cognitive-load scores on create", () => {
    const finding = store.create({
      title: "t",
      description: "d",
      findingType: "repeated_friction",
      leverage: 0.8,
      riskReduction: 0.6,
      timeSaved: 0.5,
      cognitiveLoadReduction: 0.4,
    });
    expect(finding.leverage).toBe(0.8);
    expect(finding.riskReduction).toBe(0.6);
    expect(finding.timeSaved).toBe(0.5);
    expect(finding.cognitiveLoadReduction).toBe(0.4);
  });

  it("links a finding to a claim, open loop, and drift finding", () => {
    const claim = loomStore.assertClaim({ entity: "X", predicate: "k", value: "v" });
    const loop = loomStore.createOpenLoop({ title: "l", loopType: "watch_condition" });
    const drift = loomStore.createDriftFinding({ driftType: "other", oldText: "old" });
    const finding = store.create({ title: "t", description: "d", findingType: "other" });

    store.linkRecord(finding.id, "claim", claim.id);
    store.linkRecord(finding.id, "loop", loop.id);
    store.linkRecord(finding.id, "drift_finding", drift.id);

    const updated = store.get(finding.id);
    expect(updated?.relatedClaims).toContain(claim.id);
    expect(updated?.relatedLoops).toContain(loop.id);
    expect(updated?.relatedDriftFindings).toContain(drift.id);
  });

  it("flips notAnActiveTask to false once promoted (fixed/filed/proposed), stays true when merely remembered", () => {
    const promoted = store.create({ title: "promoted", description: "d", findingType: "other" });
    const remembered = store.create({ title: "remembered", description: "d", findingType: "other" });

    store.transition(promoted.id, "proposed");
    store.transition(remembered.id, "remembered");

    expect(store.get(promoted.id)?.notAnActiveTask).toBe(false);
    expect(store.get(remembered.id)?.notAnActiveTask).toBe(true);
  });

  it("attention steward only ranks still-noticing findings (notAnActiveTask=true)", () => {
    const inbox = store.create({ title: "inbox item", description: "d", findingType: "other", riskLevel: "high" });
    const promoted = store.create({
      title: "promoted item",
      description: "d",
      findingType: "other",
      riskLevel: "high",
    });
    store.transition(promoted.id, "fixed");

    const report = rankAttention({ loomStore, serendipityStore: store }, { targetKinds: ["serendipity_finding"] });
    const ids = report.items.map((i) => i.targetId);
    expect(ids).toContain(inbox.id);
    expect(ids).not.toContain(promoted.id);
  });
});
