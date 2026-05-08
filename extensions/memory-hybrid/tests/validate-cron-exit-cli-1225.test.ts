/**
 * Issue #1225 — validate-cron-exit must call process.exit after emitting JSON so one-shot CLI
 * does not linger on plugin handles.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerValidateCronExit } from "../cli/commands/manage/register-validate-cron-exit.js";

describe("validate-cron-exit CLI (#1225)", () => {
  const origArgv = process.argv.slice();

  afterEach(() => {
    process.argv = origArgv;
    vi.restoreAllMocks();
  });

  function stubOpenclawArgv() {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
  }

  it("exits 0 promptly after JSON for a successful ledger", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "success.exit");
    const logPath = join(dir, "success.log");
    writeFileSync(
      exitPath,
      `2026-05-08T21:10:00Z prune exit=0
2026-05-08T21:10:01Z distill exit=0
2026-05-08T21:10:02Z extract-daily exit=0
`,
    );
    writeFileSync(logPath, "all good\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "prune",
        "distill",
        "extract-daily",
        "--allow-skip",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(logSpy.mock.calls.length).toBe(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      maintenanceStatus: string;
    };
    expect(payload.maintenanceStatus).toBe("success");
  });

  it("exits non-zero after JSON when a required step is missing (partial)", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "missing.exit");
    const logPath = join(dir, "missing.log");
    writeFileSync(
      exitPath,
      `2026-05-08T21:10:00Z prune exit=0
2026-05-08T21:10:02Z extract-daily exit=0
`,
    );
    writeFileSync(logPath, "missing distill\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "prune",
        "distill",
        "extract-daily",
        "--allow-skip",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      maintenanceStatus: string;
      missingSteps: string[];
    };
    expect(payload.maintenanceStatus).toBe("partial");
    expect(payload.missingSteps).toContain("distill");
  });

  it("exits non-zero after JSON when a step has non-zero exit (failed)", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "partial.exit");
    const logPath = join(dir, "partial.log");
    writeFileSync(
      exitPath,
      `2026-05-08T21:10:00Z prune exit=0
2026-05-08T21:10:01Z distill exit=124
2026-05-08T21:10:02Z extract-daily exit=0
`,
    );
    writeFileSync(logPath, "distill timed out\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "prune",
        "distill",
        "extract-daily",
        "--allow-skip",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      maintenanceStatus: string;
      failedSteps: Array<{ name: string; exit: number }>;
    };
    expect(payload.maintenanceStatus).toBe("failed");
    expect(payload.failedSteps.some((s) => s.name === "distill" && s.exit === 124)).toBe(true);
  });
});
