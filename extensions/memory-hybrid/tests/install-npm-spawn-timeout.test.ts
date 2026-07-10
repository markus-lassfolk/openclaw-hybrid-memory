/**
 * Regression test (#2067-followup) for missing timeouts on install/upgrade `npm`/`npx`
 * spawnSync calls in cli/install/workspace.ts and cli/install/upgrade-config-preflight.ts.
 *
 * Sibling calls in upgrade-config-preflight.ts (`npm pack`/`tar`) already bound their spawnSync
 * with NPM_PACK_PREFLIGHT_TIMEOUT_MS -- these `npm install`/`npx` calls didn't, so a stalled
 * registry or network partition could hang the install/upgrade CLI indefinitely instead of
 * failing with a clear error. All three now pass NPM_INSTALL_TIMEOUT_MS (workspace.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("install/upgrade npm spawnSync timeout wiring (#2067-followup)", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  // Asserted against a hardcoded floor (not a re-imported constant): re-importing
  // NPM_INSTALL_TIMEOUT_MS from workspace.js would also disappear under a stash-based
  // regression check of the source fix, making `opts?.timeout === NPM_INSTALL_TIMEOUT_MS`
  // vacuously true (undefined === undefined) instead of catching the missing option.
  const MIN_EXPECTED_TIMEOUT_MS = 60_000;

  it("runNpmInstallExactPin passes a timeout to spawnSync", async () => {
    const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawnSync: spawnSyncMock };
    });

    const { runNpmInstallExactPin } = await import("../cli/install/workspace.js");

    const result = runNpmInstallExactPin("/tmp/fixture-project-root", "1.2.3");

    expect(result.ok).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const opts = (spawnSyncMock.mock.calls[0] as unknown[] | undefined)?.[2] as { timeout?: number } | undefined;
    expect(typeof opts?.timeout).toBe("number");
    expect(opts?.timeout).toBeGreaterThanOrEqual(MIN_EXPECTED_TIMEOUT_MS);
  });

  it("runStandaloneUpgradeInstall passes a timeout to spawnSync", async () => {
    const spawnSyncMock = vi.fn(() => ({ status: 0 }));
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawnSync: spawnSyncMock };
    });

    const { runStandaloneUpgradeInstall } = await import("../cli/install/upgrade-config-preflight.js");

    const result = runStandaloneUpgradeInstall("1.2.3", "/tmp/fixture-extensions-dir");

    expect(result.ok).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const opts = (spawnSyncMock.mock.calls[0] as unknown[] | undefined)?.[2] as { timeout?: number } | undefined;
    expect(typeof opts?.timeout).toBe("number");
    expect(opts?.timeout).toBeGreaterThanOrEqual(MIN_EXPECTED_TIMEOUT_MS);
  });
});
