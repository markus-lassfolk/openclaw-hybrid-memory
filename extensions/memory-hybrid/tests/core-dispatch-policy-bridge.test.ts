import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDispatchGrantStore } from "../services/core-dispatch-grant-store.js";
import {
  parseTrustedCoreDispatchContext,
  registerCoreDispatchPolicyBridge,
  CORE_DISPATCH_AUTHORIZE_METHOD,
  CORE_DISPATCH_HEALTH_METHOD,
} from "../services/core-dispatch-policy-bridge.js";

const context = (overrides: any = {}) => ({
  abiVersion: 1,
  trustedByCore: true,
  traceId: "trace",
  origin: "sessions_spawn_native",
  requester: { sessionId: "s" },
  target: { agentId: "worker", runtime: "subagent" },
  goalId: "g",
  requestedBudget: { maxDispatches: 1 },
  attributes: { goal_dispatch: { taskClass: "read", requestedAgent: "worker", readOnly: true } },
  ...overrides,
});

describe("core dispatch policy bridge", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  it("rejects model-controlled labels and arbitrary metadata", () => {
    expect(parseTrustedCoreDispatchContext(context())).toBeTruthy();
    expect(parseTrustedCoreDispatchContext(context({ goalLabel: "model-says-so" }))).toBeNull();
    expect(
      parseTrustedCoreDispatchContext(context({ attributes: { goal_dispatch: {}, toolMetadata: {} } })),
    ).toBeNull();
    expect(parseTrustedCoreDispatchContext(context({ trustedByCore: false }))).toBeNull();
  });
  it("registers discoverable health and authorization methods, disabled defaults abstain", async () => {
    const methods = new Map<string, any>();
    registerCoreDispatchPolicyBridge(
      { registerGatewayMethod: (n: string, h: any) => methods.set(n, h) } as any,
      { goalStewardship: { goalsDir: "goals", dispatchAuthorization: { enabled: false } } } as any,
      "/tmp",
    );
    expect(methods.has(CORE_DISPATCH_AUTHORIZE_METHOD)).toBe(true);
    expect(methods.has(CORE_DISPATCH_HEALTH_METHOD)).toBe(true);
    const respond = vi.fn();
    await methods.get(CORE_DISPATCH_AUTHORIZE_METHOD)({ params: { context: context() }, respond });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ kind: "abstain" }));
  });
  it("atomically exhausts, releases, and expires local reservations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grants-"));
    dirs.push(dir);
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new CoreDispatchGrantStore(dir, () => now);
    expect(
      await store.reserve({ id: "a", goalId: "g", expiresAt: "2026-01-01T00:05:00Z", budget: { maxDispatches: 1 } }),
    ).toBe(true);
    expect(
      await store.reserve({ id: "b", goalId: "g", expiresAt: "2026-01-01T00:05:00Z", budget: { maxDispatches: 1 } }),
    ).toBe(false);
    expect(await store.release("a", "failed")).toBe(true);
    expect(
      await store.reserve({ id: "b", goalId: "g", expiresAt: "2026-01-01T00:05:00Z", budget: { maxDispatches: 1 } }),
    ).toBe(true);
    now = new Date("2026-01-01T00:06:00Z");
    expect((await store.get("b"))?.status).toBe("released");
  });
});
