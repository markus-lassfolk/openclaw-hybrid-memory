/**
 * Regression test (loop iteration 123) for cli/commands/manage/register-lifecycle.ts:
 *
 * `expire-by-source --decay-class <c>` cast any free-form string directly to `DecayClass` with
 * no validation against the `DECAY_CLASSES` enum, so a typo'd value (e.g. `--decay-class temp`
 * instead of `--decay-class short`) would silently persist an out-of-enum `decay_class` value
 * on every matched fact instead of erroring — unlike every sibling CLI option in this codebase
 * (`--policy`, `--scope`, `--format`), which all validate against an explicit allow-list.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerExpireBySourceCommands } from "../cli/commands/manage/register-lifecycle.js";

function makeProgram(expireBySourcePattern: ReturnType<typeof vi.fn>): Command {
  const program = new Command("hybrid-mem");
  program.exitOverride();
  const bindings = {
    factsDb: { expireBySourcePattern },
  } as unknown as ManageBindings;
  registerExpireBySourceCommands(program, bindings);
  return program;
}

describe("expire-by-source --decay-class validation (loop iteration 123 regression)", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects an invalid --decay-class instead of silently persisting it", async () => {
    const expireBySourcePattern = vi.fn();
    const program = makeProgram(expireBySourcePattern);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["expire-by-source", "--pattern", "temp/*", "--days", "7", "--decay-class", "temp"], {
      from: "user",
    });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--decay-class must be one of"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(expireBySourcePattern).not.toHaveBeenCalled();
  });

  it("still accepts a valid --decay-class", async () => {
    const expireBySourcePattern = vi.fn().mockReturnValue({
      apply: false,
      pattern: "temp/*",
      matched: 0,
      changed: 0,
      decayClass: "ephemeral",
      ttlDays: 7,
    });
    const program = makeProgram(expireBySourcePattern);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["expire-by-source", "--pattern", "temp/*", "--days", "7", "--decay-class", "ephemeral"], {
      from: "user",
    });

    expect(expireBySourcePattern).toHaveBeenCalledWith(expect.objectContaining({ decayClass: "ephemeral" }));
    expect(process.exitCode).toBeUndefined();
  });

  it("defaults to the documented 'short' decay class when --decay-class is omitted", async () => {
    const expireBySourcePattern = vi.fn().mockReturnValue({
      apply: false,
      pattern: "temp/*",
      matched: 0,
      changed: 0,
      decayClass: "short",
      ttlDays: 7,
    });
    const program = makeProgram(expireBySourcePattern);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["expire-by-source", "--pattern", "temp/*", "--days", "7"], { from: "user" });

    expect(expireBySourcePattern).toHaveBeenCalledWith(expect.objectContaining({ decayClass: "short" }));
    expect(process.exitCode).toBeUndefined();
  });
});
