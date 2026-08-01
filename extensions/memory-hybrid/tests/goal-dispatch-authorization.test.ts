import { describe, expect, it } from "vitest";
import { evaluateGoalDispatch, type GoalDispatchPolicy, type GoalDispatchRequest } from "../services/goal-dispatch-authorization.js";
const policy: GoalDispatchPolicy = { version: 1, taskClass: "implementation", canonical: { prNumber: 909, branch: "armor/909", remoteHead: "abc123" }, writeScope: ["extensions/memory-hybrid"], forbidNewPr: true, forbidNewBranch: true };
const write = (actualAgent: string, changes = {}): GoalDispatchRequest => ({ taskClass: "implementation", requestedAgent: actualAgent, actualAgent, prNumber: 909, branch: "armor/909", liveRemoteHead: "abc123", writeScope: ["extensions/memory-hybrid"], ...changes });
describe("goal dispatch authorization", () => {
  it("rejects Scholar implementation", () => expect(evaluateGoalDispatch(policy, write("scholar")).allowed).toBe(false));
  it("rejects Builder implementation", () => expect(evaluateGoalDispatch(policy, write("builder")).allowed).toBe(false));
  it("accepts Furnace canonical write only with a valid policy", () => expect(evaluateGoalDispatch(policy, write("furnace")).allowed).toBe(true));
  it("rejects a sibling PR or branch", () => expect(evaluateGoalDispatch(policy, write("furnace", { prNumber: 910, branch: "armor/910" })).reason).toContain("non-canonical"));
  it("rejects a stale canonical SHA", () => expect(evaluateGoalDispatch(policy, write("furnace", { liveRemoteHead: "old" })).reason).toContain("stale"));
  it("accepts declared read-only Scholar verification", () => {
    const v = { ...policy, taskClass: "verification" as const, allowReadOnlyVerification: true };
    expect(evaluateGoalDispatch(v, { taskClass: "verification", requestedAgent: "scholar", actualAgent: "scholar", readOnly: true }).allowed).toBe(true);
  });
  it("rejects policy-missing write", () => expect(evaluateGoalDispatch(undefined, write("furnace")).allowed).toBe(false));
});
