import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomStore } from "../backends/loom-store.js";
import { rankAttention } from "../services/attention-steward.js";

let tmpDir: string;
let loomStore: LoomStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "attention-steward-test-"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("rankAttention", () => {
  it("categorizes an unsatisfied live-check claim as needs_verification and ranks it highly", () => {
    loomStore.assertClaim({
      entity: "Doris",
      predicate: "m365_identity",
      value: "doris@lassfolk.net",
      liveCheckRequired: true,
      liveCheckReason: "mutable auth state",
    });
    const report = rankAttention({ loomStore });
    expect(report.items[0]?.category).toBe("needs_verification");
  });

  it("categorizes a blocked open loop as blocked", () => {
    const loop = loomStore.createOpenLoop({
      title: "Blocked thing",
      loopType: "blocked_task",
      urgency: 0.9,
      importance: 0.9,
    });
    loomStore.updateOpenLoop(loop.id, { status: "blocked" });
    const report = rankAttention({ loomStore }, { targetKinds: ["open_loop"] });
    const item = report.items.find((i) => i.targetId === loop.id);
    expect(item?.category).toBe("blocked");
  });

  it("categorizes a high-severity drift finding as urgent", () => {
    loomStore.createDriftFinding({ driftType: "deprecated_command", oldText: "old-cmd", severity: "high" });
    const report = rankAttention({ loomStore }, { targetKinds: ["drift_finding"] });
    expect(report.items[0]?.category).toBe("urgent");
  });

  it("excludes snoozed items unless includeSnoozed is set", () => {
    const claim = loomStore.assertClaim({ entity: "X", predicate: "k", value: "v" });
    loomStore.setAttentionOverride({
      targetKind: "claim",
      targetId: claim.id,
      action: "snooze",
      snoozedUntil: "2099-01-01",
    });
    const withoutSnoozed = rankAttention({ loomStore }, { targetKinds: ["claim"] });
    expect(withoutSnoozed.items.find((i) => i.targetId === claim.id)).toBeUndefined();
    const withSnoozed = rankAttention({ loomStore }, { targetKinds: ["claim"], includeSnoozed: true });
    expect(withSnoozed.items.find((i) => i.targetId === claim.id)?.overridden).toBe("snooze");
  });

  it("demoting an item lowers its score without deleting it", () => {
    const claim = loomStore.assertClaim({ entity: "Y", predicate: "k", value: "v" });
    loomStore.verifyClaim(claim.id, { confidence: 0.95 });
    const before = rankAttention({ loomStore }, { targetKinds: ["claim"] }).items.find((i) => i.targetId === claim.id);
    loomStore.setAttentionOverride({ targetKind: "claim", targetId: claim.id, action: "demote", reason: "noisy" });
    const after = rankAttention({ loomStore }, { targetKinds: ["claim"] }).items.find((i) => i.targetId === claim.id);
    expect(after?.overridden).toBe("demote");
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after?.score).toBeLessThan(before?.score ?? Number.POSITIVE_INFINITY);
    expect(loomStore.getClaim(claim.id)).not.toBeNull();
  });

  it("respects the limit option and reports totalConsidered separately", () => {
    for (let i = 0; i < 5; i++) {
      loomStore.assertClaim({ entity: `E${i}`, predicate: "k", value: "v" });
    }
    const report = rankAttention({ loomStore }, { targetKinds: ["claim"], limit: 2 });
    expect(report.items).toHaveLength(2);
    expect(report.totalConsidered).toBe(5);
  });
});
