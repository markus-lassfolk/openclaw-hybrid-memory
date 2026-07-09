/**
 * Regression test (loop iteration 120) for cli/task-queue-status.ts:
 *
 * `task-queue-touch --repair` printed a clear error to stderr when current.json failed to
 * parse as JSON, but never set process.exitCode -- Node defaults to exit code 0, so a
 * cron/automation caller checking the exit code would treat a reported failure as success.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chainable } from "../cli/shared.js";
import { registerTaskQueueStatusCommands } from "../cli/task-queue-status.js";

type ActionFn = (opts: Record<string, unknown>) => void | Promise<void>;

function captureActions(): { actions: Map<string, ActionFn>; mem: Chainable } {
  const actions = new Map<string, ActionFn>();
  let currentCommand = "";
  const chainable: Chainable = {
    command(name: string) {
      currentCommand = name;
      return chainable;
    },
    description() {
      return chainable;
    },
    option() {
      return chainable;
    },
    requiredOption() {
      return chainable;
    },
    action(fn: ActionFn) {
      actions.set(currentCommand, fn);
      return chainable;
    },
  };
  return { actions, mem: chainable };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "task-queue-status-test-"));
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("task-queue-touch --repair exit code (loop iteration 120 regression)", () => {
  it("sets process.exitCode when current.json is malformed", async () => {
    writeFileSync(join(tmpDir, "current.json"), "{not valid json", "utf-8");
    const { actions, mem } = captureActions();
    registerTaskQueueStatusCommands(mem);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await actions.get("task-queue-touch")!({ stateDir: tmpDir, repair: true });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("current.json is malformed"));
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });

  it("does not set process.exitCode when current.json is valid JSON", async () => {
    writeFileSync(join(tmpDir, "current.json"), JSON.stringify({ idle: true }), "utf-8");
    const { actions, mem } = captureActions();
    registerTaskQueueStatusCommands(mem);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await actions.get("task-queue-touch")!({ stateDir: tmpDir, repair: true });

    expect(process.exitCode).toBeUndefined();
    logSpy.mockRestore();
  });
});
