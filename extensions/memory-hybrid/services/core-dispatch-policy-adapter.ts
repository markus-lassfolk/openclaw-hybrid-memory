import { randomUUID } from "node:crypto";
import type {
  CoreDispatchAuthorizationProvider,
  CoreDispatchContext,
  DispatchAuthorizationDecision,
  DispatchBudgetCaps,
} from "../contracts/core-dispatch-authorization.js";
import { CORE_DISPATCH_AUTHORIZATION_ABI_VERSION } from "../contracts/core-dispatch-authorization.js";
import {
  evaluateGoalDispatch,
  type GoalDispatchPolicy,
  type GoalDispatchRequest,
} from "./goal-dispatch-authorization.js";

export type GoalDispatchPolicyResolver = (goalId: string) => Promise<GoalDispatchPolicy | undefined>;

/**
 * Hybrid-memory policy provider for the core ABI. It intentionally does not
 * create children or reserve/reconcile usage; those actions must remain core
 * owned so every native, ACP, cron, and direct dispatch shares one boundary.
 */
export class HybridMemoryGoalDispatchPolicyAdapter implements CoreDispatchAuthorizationProvider {
  readonly abiVersion = CORE_DISPATCH_AUTHORIZATION_ABI_VERSION;

  constructor(
    private readonly resolvePolicy: GoalDispatchPolicyResolver,
    private readonly now: () => Date = () => new Date(),
    private readonly makeGrantId: () => string = randomUUID,
  ) {}

  async authorize(context: CoreDispatchContext): Promise<DispatchAuthorizationDecision> {
    if (!context.goalId) return { kind: "abstain", reason: "no explicit goal id" };
    const request = requestFromCoreContext(context);
    if (!request) return { kind: "deny", reason: "missing or malformed goal dispatch declaration" };
    const policy = await this.resolvePolicy(context.goalId);
    const result = evaluateGoalDispatch(policy, request);
    if (!result.allowed) return { kind: "deny", reason: result.reason };
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    return {
      kind: "allow",
      grant: {
        id: this.makeGrantId(),
        expiresAt,
        budget: context.requestedBudget,
        policyRef: `goal:${context.goalId}:v${policy?.version ?? "none"}`,
      },
    };
  }
}

function requestFromCoreContext(context: CoreDispatchContext): GoalDispatchRequest | null {
  const value = context.attributes.goal_dispatch;
  if (!value || typeof value !== "object") return null;
  const declaration = value as Record<string, unknown>;
  const str = (key: string) => (typeof declaration[key] === "string" ? declaration[key] : undefined);
  const bool = (key: string) => (typeof declaration[key] === "boolean" ? declaration[key] : undefined);
  const strings = (key: string) =>
    Array.isArray(declaration[key]) && declaration[key].every((item) => typeof item === "string")
      ? (declaration[key] as string[])
      : undefined;
  const taskClass = str("taskClass");
  const requestedAgent = str("requestedAgent");
  if (!taskClass || !requestedAgent) return null;
  return {
    taskClass,
    requestedAgent,
    actualAgent: context.target.agentId,
    prNumber: typeof declaration.prNumber === "number" ? declaration.prNumber : undefined,
    branch: str("branch"),
    liveRemoteHead: str("liveRemoteHead"),
    writeScope: strings("writeScope"),
    createsPr: bool("createsPr"),
    createsBranch: bool("createsBranch"),
    readOnly: bool("readOnly"),
  };
}

/** Exported for core integration tests to preserve the budget value verbatim. */
export function requestedBudgetForCore(context: CoreDispatchContext): DispatchBudgetCaps {
  return context.requestedBudget;
}
