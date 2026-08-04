import { isValidGoalDispatchPolicy, type GoalDispatchPolicy } from "./goal-dispatch-authorization.js";
import type { GoalVerification } from "./goal-stewardship-types.js";

export type GoalWorkClass = "advisory" | "implementation";
export type GoalPrerequisiteStatus = "ready" | "discovery_required" | "hitl";
export type GoalPreflight = {
  status: GoalPrerequisiteStatus;
  workClass: GoalWorkClass;
  reasons: string[];
  phase: "discovery" | "implementation";
};

/** Fail closed for writes, while allowing bounded read-only/advisory research. */
export function evaluateGoalPrerequisites(input: {
  description: string;
  acceptanceCriteria: string[];
  verification?: GoalVerification;
  dispatchPolicy?: GoalDispatchPolicy;
}): GoalPreflight {
  const writePolicy = input.dispatchPolicy && Object.values(input.dispatchPolicy.classes).some((c) => !c.readOnly);
  const implementationWords = /\b(implement|fix|code|repository|repo|branch|pull request|\bpr\b|commit|deploy)\b/i.test(
    input.description,
  );
  const workClass: GoalWorkClass = writePolicy || implementationWords ? "implementation" : "advisory";
  const reasons: string[] = [];
  if (!input.acceptanceCriteria.length) reasons.push("measurable acceptance criteria are required");
  if (input.dispatchPolicy && !isValidGoalDispatchPolicy(input.dispatchPolicy))
    reasons.push("dispatch policy is invalid");
  if (workClass === "implementation") {
    if (!input.dispatchPolicy) reasons.push("authorized dispatch policy is required for implementation");
    if (!input.verification) reasons.push("verification mode and target are required for implementation");
    if (input.dispatchPolicy && !writePolicy) reasons.push("implementation needs an authorized write dispatch class");
  }
  if (reasons.length) return { status: "hitl", workClass, reasons, phase: "implementation" };
  const needsDiscovery =
    workClass === "implementation" &&
    !!input.dispatchPolicy &&
    Object.entries(input.dispatchPolicy.classes).some(([name, c]) => c.readOnly && /discovery|preflight/i.test(name));
  return {
    status: needsDiscovery ? "discovery_required" : "ready",
    workClass,
    reasons: [],
    phase: needsDiscovery ? "discovery" : "implementation",
  };
}
export function validateMaxIterations(value: unknown): number | undefined {
  if (value === undefined) return 20;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : undefined;
}
