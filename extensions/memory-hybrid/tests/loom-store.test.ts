import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenLoopEvidenceRequiredError } from "../backends/loom/open-loops.js";
import { LoomStore } from "../backends/loom-store.js";

let tmpDir: string;
let store: LoomStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loom-store-test-"));
  store = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("LoomStore — evidence capsules (#2148)", () => {
  it("creates, gets, resolves by prefix, and lists capsules", () => {
    const capsule = store.createEvidenceCapsule({
      content: {
        title: "Doris M365 auth restored",
        claim: "Doris can authenticate to M365 as doris@lassfolk.net",
        evidence: [{ kind: "command", text: "m365-agent-cli whoami" }],
        commandsRun: ["m365-agent-cli whoami"],
        artifacts: [],
        unverifiedItems: ["mailbox send not yet re-tested"],
        riskFlags: [],
        limits: undefined,
        redactionCount: 0,
        redacted: false,
      },
      actor: "maeve",
    });
    expect(capsule.id).toBeTruthy();
    expect(capsule.redactionStatus).toBe("clean");

    const fetched = store.getEvidenceCapsule(capsule.id);
    expect(fetched?.title).toBe("Doris M365 auth restored");

    const byPrefix = store.resolveEvidenceCapsule(capsule.id.slice(0, 8));
    expect(byPrefix?.id).toBe(capsule.id);

    const list = store.listEvidenceCapsules();
    expect(list).toHaveLength(1);
  });

  it("attaches to a task/goal and links to a claim", () => {
    const capsule = store.createEvidenceCapsule({
      content: {
        title: "t",
        claim: "c",
        evidence: [],
        commandsRun: [],
        artifacts: [],
        unverifiedItems: [],
        riskFlags: [],
        limits: undefined,
        redactionCount: 0,
        redacted: false,
      },
    });
    const attached = store.attachEvidenceCapsule(capsule.id, { linkedTaskLabel: "forge-99" });
    expect(attached.linkedTaskLabel).toBe("forge-99");

    const linked = store.linkEvidenceCapsuleToClaim(capsule.id, "claim-123");
    expect(linked.linkedClaimIds).toContain("claim-123");

    const filtered = store.listEvidenceCapsules({ linkedTaskLabel: "forge-99" });
    expect(filtered).toHaveLength(1);
  });
});

describe("LoomStore — belief graph / claim ledger (#2151)", () => {
  it("asserts, verifies, and lists claims for an entity", () => {
    const claim = store.assertClaim({
      entity: "Doris",
      predicate: "m365_identity",
      value: "doris@lassfolk.net",
      why: "confirmed via whoami",
      confidence: 0.6,
    });
    expect(claim.status).toBe("unverified");

    const verified = store.verifyClaim(claim.id, { confidence: 0.95 });
    expect(verified.status).toBe("verified");
    expect(verified.confidence).toBe(0.95);

    const beliefs = store.getBeliefsForEntity("Doris");
    expect(beliefs).toHaveLength(1);
  });

  it("contradicts two claims symmetrically", () => {
    const a = store.assertClaim({ entity: "X", predicate: "state", value: "up" });
    const b = store.assertClaim({ entity: "X", predicate: "state", value: "down" });
    store.contradictClaim(a.id, b.id, "conflicting reports");
    expect(store.getClaim(a.id)?.status).toBe("contradicted");
    expect(store.getClaim(b.id)?.status).toBe("contradicted");
    expect(store.getClaim(a.id)?.contradictsClaimIds).toContain(b.id);
    expect(store.getClaim(b.id)?.contradictsClaimIds).toContain(a.id);
  });

  it("supersedes a claim and excludes it from primary beliefs", () => {
    const old = store.assertClaim({ entity: "Y", predicate: "endpoint", value: "old.example.com" });
    const fresh = store.assertClaim({ entity: "Y", predicate: "endpoint", value: "new.example.com" });
    store.supersedeClaim(old.id, fresh.id);
    expect(store.getClaim(old.id)?.status).toBe("superseded");
    expect(store.getClaim(fresh.id)?.supersedesClaimIds).toContain(old.id);
    const primary = store.getBeliefsForEntity("Y");
    expect(primary.map((c) => c.id)).not.toContain(old.id);
  });

  it("degrades verified claims to stale after the configured window", () => {
    const claim = store.assertClaim({ entity: "Z", predicate: "k", value: "v" });
    store.verifyClaim(claim.id, { at: "2020-01-01T00:00:00.000Z" });
    const changed = store.sweepStaleClaims(30, "2020-06-01T00:00:00.000Z");
    expect(changed).toBe(1);
    expect(store.getClaim(claim.id)?.status).toBe("stale");
  });

  it("does not throw when status filter is a bare scalar instead of an array (regression, issue #2185)", () => {
    store.assertClaim({ entity: "W", predicate: "k", value: "v" });
    const asArray = store.listClaims({ status: ["unverified"] });
    let asScalar: ReturnType<typeof store.listClaims> = [];
    expect(() => {
      asScalar = store.listClaims({ status: "unverified" as any });
    }).not.toThrow();
    expect(asScalar.map((c) => c.id)).toEqual(asArray.map((c) => c.id));
  });
});

describe("LoomStore — live-check contracts (#2156)", () => {
  it("required + unsatisfied -> satisfied -> expired", () => {
    const claim = store.assertClaim({
      entity: "Doris",
      predicate: "m365_identity",
      value: "doris@lassfolk.net",
      liveCheckRequired: true,
      liveCheckReason: "mutable external auth state",
      suggestedChecks: [{ kind: "command", text: "m365-agent-cli whoami", expected: "doris@lassfolk.net" }],
    });
    expect(claim.status).toBe("must_live_check");

    const unsatisfied = store.getLiveCheckStatus(claim.id, "2026-01-01T00:00:00.000Z");
    expect(unsatisfied.state).toBe("required_unsatisfied");
    expect(store.listUnsatisfiedLiveChecks("2026-01-01T00:00:00.000Z").map((c) => c.id)).toContain(claim.id);

    store.satisfyLiveCheck({ claimId: claim.id, ttlHours: 1, satisfiedBy: "agent" });
    const satisfied = store.getLiveCheckStatus(claim.id);
    expect(satisfied.state).toBe("satisfied");
    expect(store.getClaim(claim.id)?.status).toBe("verified");

    const farFuture = new Date(Date.now() + 5 * 3_600_000).toISOString();
    const expired = store.getLiveCheckStatus(claim.id, farFuture);
    expect(expired.state).toBe("expired");
  });

  it("a claim with no live-check requirement reports not_required", () => {
    const claim = store.assertClaim({ entity: "A", predicate: "k", value: "v" });
    expect(store.getLiveCheckStatus(claim.id).state).toBe("not_required");
  });

  it("missing claim throws", () => {
    expect(() => store.getLiveCheckStatus("nope")).toThrow();
  });
});

describe("LoomStore — open-loop obligations ledger (#2152)", () => {
  it("creates, lists by status, and closes with evidence", () => {
    const loop = store.createOpenLoop({
      title: "Verify Doris M365 auth",
      loopType: "needs_verification",
      closureCriteria: "whoami + capabilities succeed",
      evidenceRequired: true,
      urgency: 0.8,
    });
    expect(loop.status).toBe("open");

    expect(() => store.closeOpenLoop(loop.id)).toThrow(OpenLoopEvidenceRequiredError);

    const closed = store.closeOpenLoop(loop.id, { evidenceCapsuleId: "cap-1", reason: "verified live" });
    expect(closed.status).toBe("closed");
    expect(closed.closeEvidenceCapsuleId).toBe("cap-1");

    const open = store.listOpenLoops({ status: ["open"] });
    expect(open).toHaveLength(0);
  });

  it("supersedes a loop", () => {
    const a = store.createOpenLoop({ title: "old", loopType: "watch_condition" });
    const b = store.createOpenLoop({ title: "new", loopType: "watch_condition" });
    const superseded = store.closeOpenLoop(a.id, { status: "superseded", supersededByLoopId: b.id });
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededByLoopId).toBe(b.id);
  });

  it("resurfaces due loops without duplicating", () => {
    const loop = store.createOpenLoop(
      { title: "due soon", loopType: "future_cleanup", resurfaceAt: "2020-01-01T00:00:00.000Z" },
      {},
    );
    const due = store.listLoopsDueForResurface("2020-06-01T00:00:00.000Z");
    expect(due.map((l) => l.id)).toContain(loop.id);
    store.markLoopResurfaced(loop.id, "2020-06-01T00:00:00.000Z");
    expect(store.getOpenLoop(loop.id)?.lastResurfacedAt).toBe("2020-06-01T00:00:00.000Z");
    // Once resurfaced for this due-cycle, it must not resurface again until re-armed (resurfaceAt bumped).
    const dueAgain = store.listLoopsDueForResurface("2020-07-01T00:00:00.000Z");
    expect(dueAgain.map((l) => l.id)).not.toContain(loop.id);
    // Re-arming by pushing resurfaceAt forward past the last resurface makes it due again.
    store.updateOpenLoop(loop.id, { resurfaceAt: "2020-08-01T00:00:00.000Z" });
    const dueAfterRearm = store.listLoopsDueForResurface("2020-09-01T00:00:00.000Z");
    expect(dueAfterRearm.map((l) => l.id)).toContain(loop.id);
  });

  it("defaults resurfaceAt from config when not provided", () => {
    const loop = store.createOpenLoop({ title: "x", loopType: "watch_condition" }, { defaultResurfaceDays: 7 });
    expect(loop.resurfaceAt).toBeTruthy();
  });

  it("does not throw when status/loopType filters are bare scalars instead of arrays (regression, issue #2185)", () => {
    store.createOpenLoop({ title: "loop A", loopType: "needs_verification" });
    store.createOpenLoop({ title: "loop B", loopType: "watch_condition" });
    const asArray = store.listOpenLoops({ status: ["open"], loopType: ["needs_verification"] });

    let asScalar: ReturnType<typeof store.listOpenLoops> = [];
    expect(() => {
      asScalar = store.listOpenLoops({ status: "open" as any, loopType: "needs_verification" as any });
    }).not.toThrow();
    expect(asScalar.map((l) => l.id)).toEqual(asArray.map((l) => l.id));
    expect(asScalar).toHaveLength(1);
  });
});

describe("LoomStore — drift scout (#2146)", () => {
  it("creates a finding and dedups by hash", () => {
    const finding = store.createDriftFinding({
      driftType: "deprecated_command",
      oldText: "openclaw hybrid-mem old-cmd",
      replacementText: "openclaw hybrid-mem new-cmd",
      severity: "high",
      repairability: "auto_safe",
    });
    expect(finding.status).toBe("open");

    const hash = finding.dedupHash;
    const dup = store.findDriftByDedupHash(hash);
    expect(dup?.id).toBe(finding.id);
  });

  it("updates status to acknowledged/snoozed/resolved", () => {
    const finding = store.createDriftFinding({ driftType: "contradicted_fact", oldText: "old fact text" });
    const snoozed = store.updateDriftStatus(finding.id, "snoozed", { snoozedUntil: "2027-01-01T00:00:00.000Z" });
    expect(snoozed.status).toBe("snoozed");
    expect(snoozed.snoozedUntil).toBe("2027-01-01T00:00:00.000Z");
  });

  it("does not throw when status filter is a bare scalar instead of an array (regression, issue #2185)", () => {
    store.createDriftFinding({ driftType: "deprecated_command", oldText: "old-cmd" });
    const asArray = store.listDriftFindings({ status: ["open"] });

    let asScalar: ReturnType<typeof store.listDriftFindings> = [];
    expect(() => {
      asScalar = store.listDriftFindings({ status: "open" as any });
    }).not.toThrow();
    expect(asScalar.map((f) => f.id)).toEqual(asArray.map((f) => f.id));
    expect(asScalar).toHaveLength(1);
  });
});

describe("LoomStore — attention overrides (#2153)", () => {
  it("sets and reads a snooze/demote override, latest wins", () => {
    store.setAttentionOverride({ targetKind: "claim", targetId: "c1", action: "snooze", snoozedUntil: "2027-01-01" });
    let ov = store.getAttentionOverride("claim", "c1");
    expect(ov?.action).toBe("snooze");

    store.setAttentionOverride({ targetKind: "claim", targetId: "c1", action: "demote", reason: "stale" });
    ov = store.getAttentionOverride("claim", "c1");
    expect(ov?.action).toBe("demote");
    expect(store.listAttentionOverrides()).toHaveLength(1);
  });
});

describe("LoomStore — memory lifecycle audit (#2155)", () => {
  it("records and lists audit entries", () => {
    store.recordLifecycleAudit({ targetKind: "fact", targetId: "f1", action: "demote", reason: "stale" });
    store.recordLifecycleAudit({
      targetKind: "fact",
      targetId: "f2",
      action: "delete",
      reason: "unsafe",
      confirmedBy: "operator",
    });
    const all = store.listLifecycleAudit();
    expect(all).toHaveLength(2);
    const forF1 = store.listLifecycleAudit({ targetId: "f1" });
    expect(forF1).toHaveLength(1);
  });
});

describe("LoomStore — procedure triage decisions (#2147)", () => {
  it("records and retrieves a no_action decision, upserts on repeat", () => {
    store.recordProcedureTriageDecision({ clusterId: "cluster-1", decision: "no_action", rationale: "too niche" });
    expect(store.getProcedureTriageDecision("cluster-1")?.decision).toBe("no_action");
    store.recordProcedureTriageDecision({ clusterId: "cluster-1", decision: "promote_to_skill" });
    expect(store.getProcedureTriageDecision("cluster-1")?.decision).toBe("promote_to_skill");
    expect(store.listProcedureTriageDecisions()).toHaveLength(1);
  });
});

describe("LoomStore — lifecycle", () => {
  it("reports isOpen and closes cleanly", () => {
    expect(store.isOpen()).toBe(true);
    store.close();
    expect(() => store.listClaims()).not.toThrow();
  });
});
