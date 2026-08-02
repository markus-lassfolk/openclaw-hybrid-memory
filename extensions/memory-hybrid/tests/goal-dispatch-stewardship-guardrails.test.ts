import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GoalDispatchBroker } from "../services/goal-dispatch-broker.js";
import {
  evaluateGoalDispatch,
  reconcileTargetProgress,
  type GoalDispatchPolicy,
} from "../services/goal-dispatch-authorization.js";
const policy: GoalDispatchPolicy = {
  version: 1,
  classes: {
    write: {
      allowedAgents: ["writer"],
      readOnly: false,
      canonical: { repository: "owner/repo", prNumber: 909, branch: "feat/example", remoteHead: "abc" },
      writeScope: ["src"],
      forbidNewPr: true,
      forbidNewBranch: true,
    },
  },
};
const request = {
  taskClass: "write",
  requestedAgent: "writer",
  actualAgent: "writer",
  readOnly: false,
  repository: "owner/repo",
  prNumber: 909,
  branch: "feat/example",
  liveRemoteHead: "abc",
  writeScope: ["src/file.ts"],
  createsPr: false,
  createsBranch: false,
};
describe("target stewardship guardrails", () => {
  it("fences wrong canonical targets and diff scope", () => {
    expect(evaluateGoalDispatch(policy, { ...request, branch: "wrong" }).allowed).toBe(false);
    expect(
      reconcileTargetProgress(
        {
          sourceTasksReference: "TASKS.md#M",
          implementationEvidence: ["commit"],
          verificationEvidence: ["test"],
          changedPaths: ["outside/x"],
        },
        { allow: ["src"] },
      ).allowed,
    ).toBe(false);
  });
  it("requires each manifest evidence category", () => {
    expect(
      reconcileTargetProgress({ implementationEvidence: ["commit"], verificationEvidence: ["test"] }).allowed,
    ).toBe(false);
    expect(
      reconcileTargetProgress(
        {
          sourceTasksReference: "TASKS#M",
          implementationEvidence: ["commit"],
          verificationEvidence: ["test"],
          changedPaths: ["src/x"],
        },
        { allow: ["src"] },
      ).allowed,
    ).toBe(true);
  });
  it("uses owner/run/session leases and rejects stale or wrong receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "broker-"));
    try {
      let t = 1_000;
      const broker = new GoalDispatchBroker(dir, () => new Date(t));
      const r = await broker.reserve({
        goalId: "goal",
        targetAgent: "writer",
        runtime: "subagent",
        budget: {},
        ttlMs: 100,
        owner: "owner",
        sessionId: "session",
      });
      expect(r).not.toBeNull();
      await broker.launch(r!.id, "run");
      expect(await broker.heartbeat(r!.id, "other", "run", 100)).toBe(false);
      expect(
        await broker.recordReceipt(r!.id, {
          owner: "other",
          runId: "run",
          sessionId: "session",
          requestedModel: "m",
          resolvedModel: "m",
          modelApplied: true,
          startingHead: "a",
          endingHead: "b",
          outcome: "success",
          evidence: ["test"],
          recordedAt: "",
        }),
      ).toBe(false);
      expect(
        await broker.recordReceipt(r!.id, {
          owner: "owner",
          runId: "run",
          sessionId: "session",
          requestedModel: "m",
          resolvedModel: "m",
          modelApplied: true,
          startingHead: "a",
          endingHead: "b",
          outcome: "success",
          evidence: [],
          recordedAt: "",
        }),
      ).toBe(false);
      expect(await broker.heartbeat(r!.id, "owner", "run", 100)).toBe(true);
      t += 101;
      expect(await broker.heartbeat(r!.id, "owner", "run", 100)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
