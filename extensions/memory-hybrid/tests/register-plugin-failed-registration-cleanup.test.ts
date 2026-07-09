/**
 * Regression test (loop iteration 128) for setup/register-plugin.ts:
 *
 * `runtimeRef.value` is assigned to the newly-built runtime before `registerTools` /
 * `registerHybridMemCliWithApi` / `registerLifecycleHooks` run. Each of those three steps was
 * only wrapped in `try { ... } catch (err) { capturePluginError(...); throw err; }` -- none of
 * them closed the just-opened DB/service handles before rethrowing, so a registration failure
 * (e.g. a tool the manifest's `contracts.tools` doesn't cover) leaked every native SQLite/LanceDB
 * handle `newRuntime` had just opened, for the life of the process.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FactsDB } from "../backends/facts-db.js";
import { resetPluginRegistrationStateForTests, runtimeRef } from "../setup/register-plugin.js";
import {
  type FullStackApi,
  getFullStackConfig,
  makeFullStackApi,
  registerFullPlugin,
} from "./helpers/comprehensive-e2e-harness.js";

let tmpDir: string;
let api: FullStackApi;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "register-plugin-failed-cleanup-"));
  api = makeFullStackApi(tmpDir);
  resetPluginRegistrationStateForTests();
});

afterEach(() => {
  resetPluginRegistrationStateForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("register-plugin closes handles on failed registration (loop iteration 128 regression)", () => {
  it("closes the just-opened factsDb and clears runtimeRef when tool registration fails", () => {
    let capturedFactsDb: FactsDB | undefined;
    const originalRegisterTool = api.registerTool.bind(api);
    api.registerTool = (opts, options) => {
      if (!capturedFactsDb && runtimeRef.value) {
        capturedFactsDb = runtimeRef.value.factsDb;
      }
      if (opts.name === "memory_recall") {
        throw new Error("simulated tool registration failure (loop iteration 128 regression)");
      }
      return originalRegisterTool(opts, options);
    };

    expect(() => registerFullPlugin(api, getFullStackConfig(tmpDir))).toThrow(/simulated tool registration failure/);

    // The failed registration must not leave a half-wired runtime installed.
    expect(runtimeRef.value).toBeNull();
    // And the DB handle that runtime had just opened must actually be closed, not leaked.
    expect(capturedFactsDb).toBeDefined();
    expect(() => capturedFactsDb!.getAll()).toThrow(/not open/i);
  });
});
