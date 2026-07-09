/**
 * `sensor-sweep` previously had no --verbose option and no progress output at all, despite
 * Tier 1's GitHub sensor shelling out to the `gh` CLI sequentially (up to ~7 execFile calls,
 * each with its own 15s timeout — worst case 100+ seconds of silence) and Tier 2's
 * weather/Home-Assistant-anomaly sensors being network-bound with their own timeouts. An
 * operator watching a cron log would see nothing and assume the process hung.
 *
 * These tests assert the new `-v/--verbose` flag produces start/complete heartbeat lines
 * (via the shared runMaintenanceHeartbeat house pattern) plus a per-sensor progress line
 * before each sensor runs, and that all of this output stays silent without --verbose.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSensorSweepCommand } from "../cli/commands/manage/register-sensor-sweep.js";
import { parseSensorSweepConfig } from "../config/parsers/sensors.js";

describe("sensor-sweep --verbose progress", () => {
  const origArgv = process.argv.slice();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sensor-sweep-cli-verbose-test-"));
  });

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProgram(): Command {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");
    const sensorSweep = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        // Keep this test deterministic: only session-history (no gh CLI / network / factsDb
        // dependency) runs. garmin/github/memoryPatterns are disabled on purpose.
        garmin: { enabled: false },
        github: { enabled: false },
        memoryPatterns: { enabled: false },
      },
    });
    const bindings = {
      cfg: { sensorSweep },
      factsDb: {},
      resolvedSqlitePath: join(tmpDir, "facts.db"),
    };
    registerSensorSweepCommand(mem, bindings as never);
    return mem;
  }

  it("emits start/complete heartbeat lines and a per-sensor progress line when --verbose is passed", async () => {
    const mem = makeProgram();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["sensor-sweep", "--tier", "1", "--verbose"], { from: "user" });

    expect(logs.some((l) => l.includes("sensor-sweep — start"))).toBe(true);
    expect(logs.some((l) => l.includes("sensor-sweep — complete in"))).toBe(true);
    expect(logs.some((l) => l.includes("sensor-sweep — session-history"))).toBe(true);
    expect(logs.some((l) => l.includes("sensor-sweep tier=1:"))).toBe(true);
  });

  it("also accepts the short -v alias", async () => {
    const mem = makeProgram();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["sensor-sweep", "--tier", "1", "-v"], { from: "user" });

    expect(logs.some((l) => l.includes("sensor-sweep — start"))).toBe(true);
    expect(logs.some((l) => l.includes("sensor-sweep — session-history"))).toBe(true);
  });

  it("stays silent (no heartbeat/progress lines) without --verbose, but still prints the summary line", async () => {
    const mem = makeProgram();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["sensor-sweep", "--tier", "1"], { from: "user" });

    expect(logs.some((l) => l.includes("sensor-sweep — start"))).toBe(false);
    expect(logs.some((l) => l.includes("sensor-sweep — session-history"))).toBe(false);
    // The final summary line must still be printed regardless of verbosity.
    expect(logs.some((l) => l.includes("sensor-sweep tier=1:"))).toBe(true);
  });

  it("rejects an invalid --tier value instead of silently falling back to tier 1 (loop iteration 121 regression)", async () => {
    const mem = makeProgram();
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["sensor-sweep", "--tier", "bogus"], { from: "user" });

    // Before the fix, `--tier bogus` silently ran as tier 1 with no indication the value was
    // invalid, matching the description "Tier to run: 1, 2, or all" but not enforcing it.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors.some((args) => String(args[0]).includes("--tier must be one of"))).toBe(true);
  });
});
