/** Fail-closed authorization for goal-linked subagent dispatches. */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type GoalDispatchCanonical = { repository: string; prNumber: number; branch: string; remoteHead: string };
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
  repository?: string;
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
    typeof canonical.repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(canonical.repository) &&
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
/**
 * Detect the pre-repository v1 write-policy shape persisted by older releases.
 * It intentionally is not accepted as a write authorization: a PR number and branch
 * are not globally unique, so guessing a repository would weaken the canonical target
 * binding. Callers can preserve the goal and replace the policy with a current v1
 * policy containing canonical.repository.
 */
export function legacyGoalDispatchPolicyRemediation(policy: unknown): string | null {
  if (!policy || typeof policy !== "object") return null;
  const candidate = policy as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.classes || typeof candidate.classes !== "object") return null;
  const legacyClasses = Object.entries(candidate.classes).filter(([, entry]) => {
    if (!entry || typeof entry !== "object") return false;
    const classPolicy = entry as Record<string, unknown>;
    if (classPolicy.readOnly !== false || !classPolicy.canonical || typeof classPolicy.canonical !== "object")
      return false;
    const canonical = classPolicy.canonical as Record<string, unknown>;
    return (
      canonical.repository === undefined &&
      Number.isSafeInteger(canonical.prNumber) &&
      (canonical.prNumber as number) > 0 &&
      typeof canonical.branch === "string" &&
      canonical.branch.trim().length > 0 &&
      typeof canonical.remoteHead === "string" &&
      canonical.remoteHead.trim().length > 0
    );
  });
  if (legacyClasses.length === 0) return null;
  return "legacy write dispatch policy is missing canonical.repository; no repository was inferred. Resubmit dispatch_policy with canonical.repository for every write class.";
}

export function isValidGoalDispatchPolicy(policy: unknown): policy is GoalDispatchPolicy {
  if (!policy || typeof policy !== "object") return false;
  const candidate = policy as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.classes || typeof candidate.classes !== "object") return false;
  const classes = Object.entries(candidate.classes);
  return classes.length > 0 && classes.every(([name, entry]) => name.trim().length > 0 && validClassPolicy(entry));
}

export function evaluateGoalDispatch(
  policy: GoalDispatchPolicy | undefined,
  request: GoalDispatchRequest,
): GoalDispatchPreflight {
  if (!isValidGoalDispatchPolicy(policy))
    return fail(request, legacyGoalDispatchPolicyRemediation(policy) ?? "dispatch policy missing or invalid");
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
  if (
    request.repository !== canonical.repository ||
    request.prNumber !== canonical.prNumber ||
    request.branch !== canonical.branch
  )
    return fail(request, "non-canonical repository, PR, or branch");
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
      repository: str("repository"),
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

/**
 * Evidence required before a target manifest may advance. This is deliberately a
 * pure, caller-configured check: the plugin never embeds another repository's
 * identity as a production default.
 */
export type TargetProgressEvidence = {
  sourceTasksReference?: string;
  implementationEvidence?: string[];
  verificationEvidence?: string[];
  changedPaths?: string[];
};
export type DiffScopeSanity = { allow?: string[]; deny?: string[]; maxFiles?: number };

export function reconcileTargetProgress(
  evidence: TargetProgressEvidence,
  scope: DiffScopeSanity = {},
): { allowed: boolean; reason: string } {
  if (!evidence.sourceTasksReference?.trim()) return { allowed: false, reason: "source TASKS reference required" };
  if (!evidence.implementationEvidence?.some((x) => x.trim()))
    return { allowed: false, reason: "direct implementation evidence required" };
  if (!evidence.verificationEvidence?.some((x) => x.trim()))
    return { allowed: false, reason: "direct verification evidence required" };
  const paths = evidence.changedPaths ?? [];
  if (scope.maxFiles !== undefined && paths.length > scope.maxFiles)
    return { allowed: false, reason: "diff scope exceeds maxFiles" };
  if (scope.deny?.some((prefix) => paths.some((path) => path === prefix || path.startsWith(`${prefix}/`))))
    return { allowed: false, reason: "diff scope contains denied path" };
  const allow = scope.allow;
  if (allow && paths.some((path) => !allow.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))))
    return { allowed: false, reason: "diff scope contains non-allowlisted path" };
  return { allowed: true, reason: "manifest evidence reconciled" };
}
