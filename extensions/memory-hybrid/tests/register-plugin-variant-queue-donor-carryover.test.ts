/**
 * Regression test (#2067-followup) for setup/register-plugin.ts:
 *
 * `variantQueue` was rebuilt unconditionally on every register() call instead of being carried
 * over from `donorRuntime` on a `reuse-databases` hot-reload, unlike every sibling optional
 * service (eventBus, pythonBridge, learningsDb, auditStore, agentHealthStore). With
 * contextualVariants.enabled: true, a burst of memory_store calls enqueues facts into the live
 * VariantGenerationQueue; VariantGenerationQueue has no dispose/drain/shutdown method, so
 * discarding the old instance on any hot-reload -- even one triggered by an unrelated config
 * change -- silently lost that pending work.
 *
 * canReuseDatabasesOnReregister()'s own eligibility gate (bootstrap-settled, no closed handles,
 * etc.) is covered separately by reregister-policy.test.ts; it's mocked to always approve reuse
 * here so this test isolates just the donor-carryover assignment this fix touches.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRegistrationStateForTests, runtimeRef } from "../setup/register-plugin.js";
import {
  type FullStackApi,
  getFullStackConfig,
  makeFullStackApi,
  registerFullPlugin,
} from "./helpers/comprehensive-e2e-harness.js";

vi.mock("../setup/reregister-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../setup/reregister-policy.js")>();
  // register-plugin.ts consumes evaluateReregisterReuse (the structured-reason variant, #2136);
  // canReuseDatabasesOnReregister is the thin boolean wrapper. Mock both so reuse is always approved.
  return {
    ...actual,
    canReuseDatabasesOnReregister: () => true,
    evaluateReregisterReuse: () => ({ reuse: true, reason: "reusable" }),
  };
});

let tmpDir: string;
let api: FullStackApi;
let originalPolicy: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "register-plugin-variant-queue-"));
  api = makeFullStackApi(tmpDir);
  resetPluginRegistrationStateForTests();
  originalPolicy = process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY;
  process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = "reuse-databases";
});

afterEach(() => {
  resetPluginRegistrationStateForTests();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalPolicy === undefined) delete process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY;
  else process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = originalPolicy;
});

describe("register-plugin carries variantQueue over on a reuse-databases hot-reload (#2067-followup)", () => {
  it("keeps the same VariantGenerationQueue instance across a reuse-databases re-register instead of rebuilding it", () => {
    const cfg = getFullStackConfig(tmpDir, { contextualVariants: { enabled: true } });

    registerFullPlugin(api, cfg);
    const firstQueue = runtimeRef.value?.variantQueue;
    expect(firstQueue).toBeTruthy();

    registerFullPlugin(api, getFullStackConfig(tmpDir, { contextualVariants: { enabled: true } }));
    const secondQueue = runtimeRef.value?.variantQueue;

    expect(secondQueue).toBe(firstQueue);
  });
});
