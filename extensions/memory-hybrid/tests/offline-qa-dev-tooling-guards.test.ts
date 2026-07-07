/**
 * loop iteration 101 regression: two dev-tooling gaps in benchmark/offline-qa/.
 *
 * 1. verify-fixtures.ts's `daily-logs-memory-dir` check called readdirSync on the sandbox
 *    memory dir with no existsSync guard (unlike the sibling `dailyInMemory` check a few lines
 *    below), so `offline-qa:verify --sandbox` crashed with ENOENT before the sandbox was
 *    populated instead of reporting the fixture as missing.
 * 2. run-maintenance-qa.ts's runTaskSubprocess had no 'error' listener on the spawned child, so
 *    a spawn failure (missing binary, EACCES, etc.) either threw an uncaught exception or left
 *    the promise unresolved forever.
 *
 * Both files unconditionally called their entrypoint at module load; guarded with the
 * `import.meta.url === file://process.argv[1]` idiom (already used by tests/perf/recall-benchmark.ts)
 * so they can be safely imported here without running the whole CLI script.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxHasDailyLogs } from "../benchmark/offline-qa/verify-fixtures.js";

vi.mock("../utils/process-runner.js", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

describe("sandboxHasDailyLogs (loop iteration 101 regression)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false without throwing when the sandbox memory dir does not exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "offline-qa-fixtures-"));
    const memDir = join(tmpDir, "does-not-exist", ".openclaw", "memory");
    expect(() => sandboxHasDailyLogs(memDir)).not.toThrow();
    expect(sandboxHasDailyLogs(memDir)).toBe(false);
  });

  it("returns true when a YYYY-MM-DD.md daily log is present", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "offline-qa-fixtures-"));
    writeFileSync(join(tmpDir, "2026-01-01.md"), "# daily log\n");
    expect(sandboxHasDailyLogs(tmpDir)).toBe(true);
  });

  it("returns false when the dir exists but has no matching daily log", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "offline-qa-fixtures-"));
    writeFileSync(join(tmpDir, "notes.txt"), "not a daily log");
    expect(sandboxHasDailyLogs(tmpDir)).toBe(false);
  });
});

describe("runTaskSubprocess spawn error handling (loop iteration 101 regression)", () => {
  it("resolves (does not hang or throw) when the spawned child emits an 'error' event", async () => {
    const { spawn } = await import("../utils/process-runner.js");
    const fakeChild = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const { runTaskSubprocess } = await import("../benchmark/offline-qa/run-maintenance-qa.js");
    const resultPromise = runTaskSubprocess(["config"], process.env, 5_000);

    // Simulate a spawn failure (e.g. ENOENT for a missing binary) instead of the child ever
    // starting -- 'close' never fires in this scenario.
    fakeChild.emit("error", new Error("simulated spawn failure: ENOENT"));

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("simulated spawn failure");
    expect(result.timedOut).toBe(false);
  });
});
