/** Fail-closed authorization for goal-linked subagent dispatches. */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type GoalDispatchTaskClass = "implementation" | "repair" | "research" | "rca" | "escalation" | "verification";
export type GoalDispatchRole = "furnace" | "scholar" | "forge";
export type GoalDispatchPolicy = {
  version: 1;
  taskClass: GoalDispatchTaskClass;
  canonical: { prNumber: number; branch: string; remoteHead: string };
  writeScope: string[];
  forbidNewPr: boolean;
  forbidNewBranch: boolean;
  /** Explicitly authorize read-only work; it never implies write authority. */
  allowReadOnlyVerification?: boolean;
};
export type GoalDispatchRequest = {
  taskClass: GoalDispatchTaskClass;
  requestedAgent: string;
  actualAgent: string;
  prNumber?: number;
  branch?: string;
  liveRemoteHead?: string;
  writeScope?: string[];
  createsPr?: boolean;
  createsBranch?: boolean;
  readOnly?: boolean;
};
export type GoalDispatchPreflight = { allowed: boolean; reason: string; at: string; request: GoalDispatchRequest };

const ROLE_FOR_CLASS: Record<GoalDispatchTaskClass, GoalDispatchRole> = {
  implementation: "furnace", repair: "furnace", research: "scholar", rca: "scholar", escalation: "forge", verification: "scholar",
};
function role(agent: string): GoalDispatchRole | null {
  const normalized = agent.trim().toLowerCase().replace(/^agent:/, "").split(":")[0];
  return normalized === "furnace" || normalized === "scholar" || normalized === "forge" ? normalized : null;
}
function fail(request: GoalDispatchRequest, reason: string): GoalDispatchPreflight { return { allowed: false, reason, at: new Date().toISOString(), request }; }

/** Pure validator: callers must persist its result before spawning. */
function isValidPolicy(policy: GoalDispatchPolicy | undefined): policy is GoalDispatchPolicy {
  if (!policy || policy.version !== 1 || !Object.hasOwn(ROLE_FOR_CLASS, policy.taskClass)) return false;
  const canonical = policy.canonical;
  return !!canonical && Number.isSafeInteger(canonical.prNumber) && canonical.prNumber > 0 &&
    typeof canonical.branch === "string" && canonical.branch.trim().length > 0 &&
    typeof canonical.remoteHead === "string" && canonical.remoteHead.trim().length > 0 &&
    Array.isArray(policy.writeScope) && policy.writeScope.every((p) => typeof p === "string" && p.length > 0) &&
    typeof policy.forbidNewPr === "boolean" && typeof policy.forbidNewBranch === "boolean";
}

export function evaluateGoalDispatch(policy: GoalDispatchPolicy | undefined, request: GoalDispatchRequest): GoalDispatchPreflight {
  if (!isValidPolicy(policy)) return fail(request, "dispatch policy missing or invalid (write dispatches default-deny)");
  if (request.taskClass !== policy.taskClass) return fail(request, "task class does not match goal policy");
  const expected = ROLE_FOR_CLASS[request.taskClass];
  if (role(request.requestedAgent) !== expected || role(request.actualAgent) !== expected) return fail(request, `task class ${request.taskClass} requires ${expected}`);
  if (request.readOnly) {
    if (!policy.allowReadOnlyVerification || request.taskClass !== "verification") return fail(request, "read-only verification not explicitly authorized");
    return { allowed: true, reason: "authorized read-only verification", at: new Date().toISOString(), request };
  }
  if (request.prNumber !== policy.canonical.prNumber || request.branch !== policy.canonical.branch) return fail(request, "non-canonical PR or branch");
  if (!request.liveRemoteHead || request.liveRemoteHead !== policy.canonical.remoteHead) return fail(request, "canonical remote head is absent or stale");
  if (policy.forbidNewPr && request.createsPr) return fail(request, "new PR forbidden by goal policy");
  if (policy.forbidNewBranch && request.createsBranch) return fail(request, "new branch forbidden by goal policy");
  const scope = request.writeScope ?? [];
  if (scope.some((p) => !policy.writeScope.includes(p))) return fail(request, "requested write scope exceeds policy");
  return { allowed: true, reason: "authorized canonical dispatch", at: new Date().toISOString(), request };
}

export async function recordGoalDispatchPreflight(goalsDir: string, goalId: string, result: GoalDispatchPreflight): Promise<void> {
  const dir = join(goalsDir, "dispatch-audit");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${goalId}.jsonl`), `${JSON.stringify(result)}\n`, "utf8");
}

/** Extract a declaration from the standard spawn tool payload. No declaration means deny. */
export function dispatchRequestFromToolParams(params: Record<string, unknown>): { goalId: string | null; request: GoalDispatchRequest | null } {
  const obj = (k: string) => (params[k] && typeof params[k] === "object" ? (params[k] as Record<string, unknown>) : {});
  const d = obj("goal_dispatch");
  const str = (k: string) => (typeof d[k] === "string" ? d[k] : undefined);
  const bool = (k: string) => d[k] === true;
  const strings = (k: string) => Array.isArray(d[k]) && d[k].every((v) => typeof v === "string") ? (d[k] as string[]) : undefined;
  // `agentId` is the host tool payload that controls the child; never trust a declaration to override it.
  const requestedAgent = str("requestedAgent");
  const actualAgent = typeof params.agentId === "string" ? params.agentId : undefined;
  const taskClass = str("taskClass") as GoalDispatchTaskClass | undefined;
  const goalId = str("goalId") ?? (typeof params.goal_id === "string" ? params.goal_id : null);
  if (!goalId || !taskClass || !requestedAgent || !actualAgent) return { goalId, request: null };
  return { goalId, request: { taskClass, requestedAgent, actualAgent, prNumber: typeof d.prNumber === "number" ? d.prNumber : undefined, branch: str("branch"), liveRemoteHead: str("liveRemoteHead"), writeScope: strings("writeScope"), createsPr: bool("createsPr"), createsBranch: bool("createsBranch"), readOnly: bool("readOnly") } };
}
