import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  CORE_DISPATCH_AUTHORIZATION_ABI_VERSION,
  type CoreDispatchContext,
  type DispatchAuthorizationDecision,
} from "../contracts/core-dispatch-authorization.js";
import { readGoal, resolveGoalsDir } from "./goal-registry.js";
import { HybridMemoryGoalDispatchPolicyAdapter } from "./core-dispatch-policy-adapter.js";
import { CoreDispatchGrantStore } from "./core-dispatch-grant-store.js";
import type { HybridMemoryConfig } from "../config.js";

export const CORE_DISPATCH_AUTHORIZE_METHOD = "memory-hybrid.core-dispatch.v1.authorize";
export const CORE_DISPATCH_RECONCILE_METHOD = "memory-hybrid.core-dispatch.v1.reconcile";
export const CORE_DISPATCH_HEALTH_METHOD = "memory-hybrid.core-dispatch.v1.health";

type TrustedContext = CoreDispatchContext & { trustedByCore: true };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Only accepts a closed, host-derived ABI shape. Goal/task labels and arbitrary tool metadata are authority-free. */
export function parseTrustedCoreDispatchContext(value: unknown): TrustedContext | null {
  if (!isObject(value) || value.abiVersion !== CORE_DISPATCH_AUTHORIZATION_ABI_VERSION || value.trustedByCore !== true)
    return null;
  if (typeof value.traceId !== "string" || !isObject(value.requester) || typeof value.requester.sessionId !== "string")
    return null;
  if (
    !isObject(value.target) ||
    typeof value.target.agentId !== "string" ||
    (value.target.runtime !== "subagent" && value.target.runtime !== "acp")
  )
    return null;
  if (
    !isObject(value.requestedBudget) ||
    !isObject(value.attributes) ||
    (value.goalId !== undefined && typeof value.goalId !== "string")
  )
    return null;
  // Explicitly reject labels/task aliases and arbitrary authority metadata.
  if ("goalLabel" in value || "taskLabel" in value || "toolMetadata" in value) return null;
  const declaration = value.attributes.goal_dispatch;
  if (!isObject(declaration)) return null;
  const allowed = new Set(["goal_dispatch"]);
  if (Object.keys(value.attributes).some((key) => !allowed.has(key))) return null;
  return value as TrustedContext;
}

export function registerCoreDispatchPolicyBridge(
  api: ClawdbotPluginApi,
  cfg: HybridMemoryConfig,
  workspaceRoot: string,
): void {
  const register = (api as any).registerGatewayMethod as
    | undefined
    | ((name: string, handler: (o: any) => Promise<void>, opts?: any) => void);
  if (!register) return; // old cores retain existing behavior; no enforcement merely from installation.
  const goalsDir = resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir);
  const store = new CoreDispatchGrantStore(goalsDir);
  const adapter = new HybridMemoryGoalDispatchPolicyAdapter(
    async (id) => (await readGoal(goalsDir, id))?.dispatchPolicy,
    undefined,
    undefined,
    store,
  );
  const respond = (opts: any, payload: unknown) => opts.respond(true, payload);
  register(
    CORE_DISPATCH_AUTHORIZE_METHOD,
    async (opts) => {
      if (!cfg.goalStewardship.dispatchAuthorization.enabled)
        return respond(opts, { kind: "abstain", reason: "dispatch authorization disabled" });
      const context = parseTrustedCoreDispatchContext(opts.params?.context);
      if (!context) return respond(opts, { kind: "deny", reason: "malformed or untrusted core dispatch context" });
      let decision: DispatchAuthorizationDecision;
      try {
        decision = await adapter.authorizeCoreDispatch(context);
      } catch {
        decision = { kind: "abstain", reason: "policy provider unavailable" };
      }
      return respond(opts, decision);
    },
    { scope: "operator.admin" },
  );
  register(
    CORE_DISPATCH_RECONCILE_METHOD,
    async (opts) => {
      const id = opts.params?.grantId;
      const outcome = opts.params?.outcome;
      if (typeof id !== "string" || !["completed", "failed", "cancelled"].includes(outcome))
        return respond(opts, { ok: false, error: "invalid lifecycle event" });
      return respond(opts, { ok: await store.release(id, outcome) });
    },
    { scope: "operator.admin" },
  );
  register(
    CORE_DISPATCH_HEALTH_METHOD,
    async (opts) =>
      respond(opts, {
        abiVersion: CORE_DISPATCH_AUTHORIZATION_ABI_VERSION,
        available: cfg.goalStewardship.dispatchAuthorization.enabled,
        provider: "memory-hybrid",
        version: "v1",
        accounting: "local-posix-filesystem-only",
      }),
    { scope: "operator.admin" },
  );
}
