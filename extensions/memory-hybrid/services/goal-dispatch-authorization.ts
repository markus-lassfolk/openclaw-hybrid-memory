/** Fail-closed authorization for goal-linked subagent dispatches. */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type GoalDispatchCanonical = { prNumber: number; branch: string; remoteHead: string };
export type GoalDispatchClassPolicy = {
  /** Exact agent ids allowed to receive this class of work. */
  allowedAgents: string[];
  /** Whether this class is strictly read-only. */
  readOnly: boolean;
  /** Required for write classes; pins work to one existing PR branch and head. */
  canonical?: GoalDispatchCanonical;
  /** Required, non-empty allow-list for write classes. */
  writeScope?: string[];
  forbidNewPr?: boolean;
  forbidNewBranch?: boolean;
};
export type GoalDispatchPolicy = {
  version: 1;
  /** Caller-defined class names; no built-in taxonomy or role mapping exists. */
  classes: Record<string, GoalDispatchClassPolicy>;
};
export type GoalDispatchRequest = {
  taskClass: string;
  requestedAgent: string;
  actualAgent: string;
  prNumber?: number;
  branch?: string;
  liveRemoteHead?: string;
  writeScope?: string[];
  createsPr?: boolean;
  createsBranch?: boolean;
  /** Required and must exactly match the selected class policy. */
  readOnly?: boolean;
};
export type GoalDispatchPreflight = { allowed: boolean; reason: string; at: string; request: GoalDispatchRequest };

function fail(request: GoalDispatchRequest, reason: string): GoalDispatchPreflight {
  return { allowed: false, reason, at: new Date().toISOString(), request };
}
const nonEmptyStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
function validCanonical(value: unknown): value is GoalDispatchCanonical {
  if (!value || typeof value !== "object") return false;
  const canonical = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(canonical.prNumber) &&
    (canonical.prNumber as number) > 0 &&
    typeof canonical.branch === "string" &&
    canonical.branch.trim().length > 0 &&
    typeof canonical.remoteHead === "string" &&
    canonical.remoteHead.trim().length > 0
  );
}
function validClassPolicy(value: unknown): value is GoalDispatchClassPolicy {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (!nonEmptyStrings(entry.allowedAgents) || typeof entry.readOnly !== "boolean") return false;
  if (entry.readOnly) return true;
  return (
    validCanonical(entry.canonical) &&
    nonEmptyStrings(entry.writeScope) &&
    typeof entry.forbidNewPr === "boolean" &&
    typeof entry.forbidNewBranch === "boolean"
  );
}

/** Pure validator: callers must persist its result before spawning. */
export function isValidGoalDispatchPolicy(policy: unknown): policy is GoalDispatchPolicy {
  if (!policy || policy.version !== 1 || !policy.classes || typeof policy.classes !== "object") return false;
  const classes = Object.entries(policy.classes);
  return classes.length > 0 && classes.every(([name, entry]) => name.trim().length > 0 && validClassPolicy(entry));
}

export function evaluateGoalDispatch(
  policy: GoalDispatchPolicy | undefined,
  request: GoalDispatchRequest,
): GoalDispatchPreflight {
  if (!isValidGoalDispatchPolicy(policy)) return fail(request, "dispatch policy missing or invalid");
  const classPolicy = policy.classes[request.taskClass];
  if (!classPolicy) return fail(request, "task class is not defined by goal policy");
  if (!request.requestedAgent || request.requestedAgent !== request.actualAgent)
    return fail(request, "requested agent must exactly match the host agentId");
  if (!classPolicy.allowedAgents.includes(request.actualAgent))
    return fail(request, "agent is not allowed for task class");
  if (typeof request.readOnly !== "boolean" || request.readOnly !== classPolicy.readOnly)
    return fail(request, "readOnly declaration must match task class policy");
  if (request.readOnly)
    return { allowed: true, reason: "authorized read-only dispatch", at: new Date().toISOString(), request };

  const canonical = classPolicy.canonical!;
  if (request.prNumber !== canonical.prNumber || request.branch !== canonical.branch)
    return fail(request, "non-canonical PR or branch");
  if (!request.liveRemoteHead || request.liveRemoteHead !== canonical.remoteHead)
    return fail(request, "canonical remote head is absent or stale");
  if (!nonEmptyStrings(request.writeScope)) return fail(request, "explicit non-empty write scope required");
  if (typeof request.createsPr !== "boolean" || typeof request.createsBranch !== "boolean")
    return fail(request, "explicit PR and branch creation declarations required");
  if (classPolicy.forbidNewPr && request.createsPr) return fail(request, "new PR forbidden by goal policy");
  if (classPolicy.forbidNewBranch && request.createsBranch) return fail(request, "new branch forbidden by goal policy");
  if (request.writeScope.some((path) => !classPolicy.writeScope!.includes(path)))
    return fail(request, "requested write scope exceeds policy");
  return { allowed: true, reason: "authorized canonical write dispatch", at: new Date().toISOString(), request };
}

export async function recordGoalDispatchPreflight(
  goalsDir: string,
  goalId: string,
  result: GoalDispatchPreflight,
): Promise<void> {
  const dir = join(goalsDir, "dispatch-audit");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${encodeURIComponent(goalId)}.jsonl`), `${JSON.stringify(result)}\n`, "utf8");
}

/** Extract a declaration from the standard spawn tool payload. No declaration means no request. */
export function dispatchRequestFromToolParams(params: Record<string, unknown>): {
  goalId: string | null;
  request: GoalDispatchRequest | null;
} {
  const obj = (key: string) =>
    params[key] && typeof params[key] === "object" ? (params[key] as Record<string, unknown>) : undefined;
  const declaration = obj("goal_dispatch");
  const declaredGoalId = declaration && typeof declaration.goalId === "string" ? declaration.goalId : undefined;
  const goalId = declaredGoalId ?? (typeof params.goal_id === "string" ? params.goal_id : null);
  if (!declaration) return { goalId, request: null };
  const str = (key: string) => (typeof declaration[key] === "string" ? declaration[key] : undefined);
  const bool = (key: string) => (typeof declaration[key] === "boolean" ? declaration[key] : undefined);
  const strings = (key: string) =>
    Array.isArray(declaration[key]) && declaration[key].every((item) => typeof item === "string")
      ? (declaration[key] as string[])
      : undefined;
  // agentId is the host tool payload that controls the child; never trust a declaration to override it.
  const actualAgent = typeof params.agentId === "string" ? params.agentId : undefined;
  const taskClass = str("taskClass");
  const requestedAgent = str("requestedAgent");
  if (!goalId || !taskClass || !requestedAgent || !actualAgent) return { goalId, request: null };
  return {
    goalId,
    request: {
      taskClass,
      requestedAgent,
      actualAgent,
      prNumber: typeof declaration.prNumber === "number" ? declaration.prNumber : undefined,
      branch: str("branch"),
      liveRemoteHead: str("liveRemoteHead"),
      writeScope: strings("writeScope"),
      createsPr: bool("createsPr"),
      createsBranch: bool("createsBranch"),
      readOnly: bool("readOnly"),
    },
  };
}
