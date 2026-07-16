/**
 * Regression test for #2136: under OPENCLAW_HYBRID_MEM_REREGISTER_POLICY=reuse-databases, when the
 * reuse gate approves reuse, repeated hot re-registers must NOT accrue full teardowns or
 * teardown-timeout recoveries — the donor's SQLite/Lance handles are reused. Before #2136 there was
 * no test pinning the counter behavior of the register flow on the reuse path.
 *
 * The reuse *decision* (bootstrap-settled, no closed handles, no config drift) is covered
 * deterministically by reregister-policy.test.ts (evaluateReregisterReuse). Here we mock that
 * decision to always approve reuse — exactly as the sibling variant-queue carryover test does —
 * so this test isolates register-plugin's counter wiring on the reuse path from network-dependent
 * bootstrap/embedding I/O.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../setup/reregister-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../setup/reregister-policy.js")>();
  return {
    ...actual,
    canReuseDatabasesOnReregister: () => true,
    evaluateReregisterReuse: () => ({ reuse: true, reason: "reusable" }),
  };
});

import { resetPluginRegistrationStateForTests } from "../setup/register-plugin.js";
import { reregisterMetrics } from "../setup/reregister-policy.js";
import {
  type FullStackApi,
  getFullStackConfig,
  makeFullStackApi,
  registerFullPlugin,
} from "./helpers/comprehensive-e2e-harness.js";

let tmpDir: string;
let api: FullStackApi;
let originalPolicy: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reuse-db-teardown-flat-"));
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

describe("reuse-databases keeps full teardowns flat across re-registers (#2136)", () => {
  it("takes the reuse branch on unchanged-config reloads without incrementing teardown counters", () => {
    const cfg = () => getFullStackConfig(tmpDir);

    registerFullPlugin(api, cfg());
    expect(reregisterMetrics.fullTeardowns).toBe(0);

    // Two more re-registers with identical config — both must reuse the donor handles.
    registerFullPlugin(api, cfg());
    registerFullPlugin(api, cfg());

    expect(reregisterMetrics.fullTeardowns).toBe(0);
    expect(reregisterMetrics.teardownTimeoutRecoveries).toBe(0);
    expect(reregisterMetrics.databaseReuses).toBeGreaterThanOrEqual(2);
    // No teardown means no teardown-reason tally.
    expect(reregisterMetrics.fullTeardownReasons).toEqual({});
  });
});
