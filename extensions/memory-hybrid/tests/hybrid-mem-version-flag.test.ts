/**
 * Issue #2012 — root `--version` flag and shared version helpers.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVersionReport,
  comparePluginVersions,
  printVersionFlag,
  printVersionSubcommand,
  runHybridMemVersion,
} from "../cli/cmd-version.js";
import { registerHybridMemVersionFlag } from "../cli/register-hybrid-mem-version-flag.js";
import { versionInfo } from "../versionInfo.js";

describe("comparePluginVersions", () => {
  it("compares semver-like release numbers", () => {
    expect(comparePluginVersions("2026.2.220", "2026.2.222")).toBe(-1);
    expect(comparePluginVersions("2026.2.222", "2026.2.220")).toBe(1);
    expect(comparePluginVersions("2026.2.222", "2026.2.222")).toBe(0);
  });
});

describe("buildVersionReport", () => {
  it("marks updateAvailable when npm is newer", () => {
    const report = buildVersionReport("2026.6.292", "2026.6.292", "2026.6.300");
    expect(report.updateAvailable).toBe(true);
  });

  it("marks updateAvailable false when installed is current", () => {
    const report = buildVersionReport("2026.6.292", "2026.6.292", "2026.6.292");
    expect(report.updateAvailable).toBe(false);
  });
});

describe("printVersionFlag", () => {
  it("prints concise installed line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printVersionFlag(buildVersionReport("2026.6.292", null, null));
    expect(log).toHaveBeenCalledWith("openclaw-hybrid-memory 2026.6.292");
    log.mockRestore();
  });

  it("prints npm update notice when npm is newer", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printVersionFlag(buildVersionReport("2026.6.292", "2026.6.292", "2026.6.300"));
    expect(log).toHaveBeenNthCalledWith(1, "openclaw-hybrid-memory 2026.6.292");
    expect(log).toHaveBeenNthCalledWith(2, "Update available: npm 2026.6.300 (run: openclaw hybrid-mem upgrade)");
    log.mockRestore();
  });

  it("prints GitHub update notice when only GitHub is newer", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printVersionFlag(buildVersionReport("2026.6.292", "2026.6.300", "2026.6.292"));
    expect(log).toHaveBeenNthCalledWith(2, "Update available: GitHub 2026.6.300 (run: openclaw hybrid-mem upgrade)");
    log.mockRestore();
  });

  it("emits JSON payload with --json", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printVersionFlag(buildVersionReport("2026.6.292", null, "2026.6.300"), { json: true });
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      name: "openclaw-hybrid-memory",
      installed: "2026.6.292",
      npm: "2026.6.300",
      updateAvailable: true,
    });
    log.mockRestore();
  });
});

describe("printVersionSubcommand", () => {
  it("keeps detailed multi-line output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printVersionSubcommand(buildVersionReport("2026.6.292", "2026.6.292", "2026.6.300"));
    expect(log.mock.calls[0]?.[0]).toBe("openclaw-hybrid-memory");
    expect(log.mock.calls[1]?.[0]).toBe("  Installed:  2026.6.292");
    expect(String(log.mock.calls[3]?.[0])).toContain("npm:        2026.6.300");
    expect(String(log.mock.calls[3]?.[0])).toContain("update available");
    log.mockRestore();
  });
});

describe("runHybridMemVersion", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits gracefully when registry lookups fail", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runHybridMemVersion("2026.6.292", { format: "flag" });
    expect(log).toHaveBeenCalledWith("openclaw-hybrid-memory 2026.6.292");
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe("registerHybridMemVersionFlag (#2012)", () => {
  it("prints version and exits when --version is passed without a subcommand", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "2099.1.1" }),
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    program.exitOverride((err) => {
      throw err;
    });
    const mem = program.command("hybrid-mem").description("test");
    registerHybridMemVersionFlag(mem);
    mem.command("upgrade").action(() => {});

    await expect(program.parseAsync(["hybrid-mem", "--version"], { from: "user" })).rejects.toThrow("exit:0");

    expect(log).toHaveBeenCalledWith(`openclaw-hybrid-memory ${versionInfo.pluginVersion}`);
    expect(log.mock.calls.some((call) => String(call[0]).startsWith("Update available:"))).toBe(true);

    exit.mockRestore();
    log.mockRestore();
    vi.restoreAllMocks();
  });

  it("supports --version --json", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    global.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    program.exitOverride((err) => {
      throw err;
    });
    const mem = program.command("hybrid-mem");
    registerHybridMemVersionFlag(mem);

    await expect(program.parseAsync(["hybrid-mem", "--version", "--json"], { from: "user" })).rejects.toThrow("exit:0");

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.installed).toBe(versionInfo.pluginVersion);
    expect(payload).toHaveProperty("updateAvailable");

    exit.mockRestore();
    log.mockRestore();
    vi.restoreAllMocks();
  });
});
