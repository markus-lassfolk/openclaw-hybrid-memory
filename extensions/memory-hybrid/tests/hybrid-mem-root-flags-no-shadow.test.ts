import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runUpgradeForCli } from "../cli/install/run-install.js";
import { registerHybridMemCliUpgradeOnlyWithApi } from "../setup/cli-context/register-upgrade-only.js";

vi.mock("../cli/install/run-install.js", () => ({
  runUpgradeForCli: vi.fn(async () => ({ ok: true, version: "2026.6.999", pluginDir: "/tmp/plugin" })),
}));

/**
 * Regression coverage for PR #2013 review: a root-level `--version`/`--json` Commander option
 * previously shadowed an identically-named option on subcommands like `upgrade`, so
 * `hybrid-mem upgrade --json` silently ran `upgrade` while swallowing `--json` with no effect,
 * instead of surfacing the unknown-option error a user relying on `--json` output would expect.
 *
 * `registerHybridMemCliUpgradeOnlyWithApi` no longer registers `--version`/`--json` at the root,
 * so these flags now correctly fall through to Commander's normal unknown-option handling on the
 * `upgrade` subcommand instead of being silently consumed by the parent.
 */
function makeApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    resolvePath: (p: string) => p,
    registerCli: vi.fn(),
  };
}

function buildUpgradeOnlyProgram(): Command {
  const api = makeApi();
  registerHybridMemCliUpgradeOnlyWithApi(api as never);
  const registerCliCallback = api.registerCli.mock.calls[0]?.[0] as (args: { program: Command }) => void;
  const program = new Command();
  program.exitOverride();
  registerCliCallback({ program });
  return program;
}

describe("hybrid-mem upgrade-only fast path does not shadow subcommand flags", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("rejects `upgrade --version` instead of silently running upgrade", async () => {
    // attachHybridMemCliFatalExit schedules a real process.exit() alongside the rethrown error.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const program = buildUpgradeOnlyProgram();
    await expect(program.parseAsync(["hybrid-mem", "upgrade", "--version"], { from: "user" })).rejects.toThrow(
      /unknown option/,
    );
    expect(runUpgradeForCli).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("rejects `upgrade --json` instead of silently swallowing it", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const program = buildUpgradeOnlyProgram();
    await expect(program.parseAsync(["hybrid-mem", "upgrade", "--json"], { from: "user" })).rejects.toThrow(
      /unknown option/,
    );
    expect(runUpgradeForCli).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("still runs a normal `upgrade [version]` invocation", async () => {
    const program = buildUpgradeOnlyProgram();
    await program.parseAsync(["hybrid-mem", "upgrade", "2026.6.999"], { from: "user" });
    expect(runUpgradeForCli).toHaveBeenCalledWith(expect.anything(), "2026.6.999", { skipPostUpgradeCron: true });
  });
});

describe("hybrid-mem upgrade-only fast path — config parse guard (#62)", () => {
  afterEach(() => {
    vi.doUnmock("../config.js");
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("does not throw when both the primary and fallback config shapes fail to parse", async () => {
    vi.doMock("../config.js", () => ({
      hybridConfigSchema: {
        parse: vi.fn(() => {
          throw new Error("config schema is broken");
        }),
      },
    }));
    vi.resetModules();
    const { registerHybridMemCliUpgradeOnlyWithApi: registerWithBrokenSchema } = await import(
      "../setup/cli-context/register-upgrade-only.js"
    );

    const api = makeApi();
    expect(() => registerWithBrokenSchema(api as never)).not.toThrow();
    expect(api.registerCli).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("upgrade-only CLI registration skipped"));
  });
});
