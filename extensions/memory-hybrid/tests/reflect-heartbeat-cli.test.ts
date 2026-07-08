/**
 * `reflect` and `reflect-rules` each make a single blocking pattern-extraction LLM call via
 * `chatCompleteWithAdaptiveMaintenanceRetry` with no heartbeat during the call — an operator
 * tailing the cron log during a long call sees nothing and assumes the process hung. Their
 * sibling `reflect-meta` already wraps its call with `runMaintenanceHeartbeat`; this brings
 * `reflect`/`reflect-rules` up to the same standard (start / still-running / complete-or-failed
 * log lines gated on --verbose).
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

function makeMinimalBindings(overrides: Partial<ManageBindings>): ManageBindings {
  const bindings = {
    factsDb: { getRawDb: () => ({}) },
    cfg: {},
    reflectionConfig: { defaultWindow: 7, minObservations: 1, model: "test-model" },
    ...overrides,
  } as unknown as ManageBindings;
  // ManageBindings also exposes a self-referencing `ctx` for sparse `ctx.*` access
  // (see cli/commands/manage/bindings.ts's buildManageBindings) — some actions read config
  // through `ctx.cfg` rather than the flattened `cfg` field.
  bindings.ctx = bindings;
  return bindings;
}

function makeProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, bindings);
  return mem;
}

function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  return lines;
}

describe("reflect / reflect-rules CLI heartbeat during blocking LLM calls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('reflect --verbose logs a "reflect — start" line before the slow LLM call resolves', async () => {
    const lines = captureLogs();
    const runReflection = vi.fn(async () => {
      // The heartbeat's start line must already be flushed before the (slow) mocked LLM call
      // is even invoked — this is what an operator tailing the cron log would see immediately,
      // instead of silence until the call finishes.
      expect(lines.some((l) => l.includes("reflect — start"))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { factsAnalyzed: 5, patternsExtracted: 2, patternsStored: 2, window: 7 };
    });
    const mem = makeProgram(makeMinimalBindings({ runReflection }));

    await mem.parseAsync(["reflect", "--verbose"], { from: "user" });

    expect(runReflection).toHaveBeenCalledTimes(1);
    const joined = lines.join("\n");
    expect(joined).toContain("reflect — start");
    expect(joined).toMatch(/reflect — complete in \d+s/);
    expect(joined).toContain("Reflection complete: analyzed 5 facts");
  });

  it("reflect without --verbose does not emit heartbeat lines", async () => {
    const lines = captureLogs();
    const runReflection = vi.fn().mockResolvedValue({
      factsAnalyzed: 1,
      patternsExtracted: 0,
      patternsStored: 0,
      window: 7,
    });
    const mem = makeProgram(makeMinimalBindings({ runReflection }));

    await mem.parseAsync(["reflect"], { from: "user" });

    const joined = lines.join("\n");
    expect(joined).not.toContain("reflect — start");
    expect(joined).not.toContain("reflect — complete");
    expect(joined).toContain("Reflection complete: analyzed 1 facts");
  });

  it('reflect-rules --verbose logs a "reflect-rules — start" line before the slow LLM call resolves', async () => {
    const lines = captureLogs();
    const runReflectionRules = vi.fn(async () => {
      expect(lines.some((l) => l.includes("reflect-rules — start"))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rulesExtracted: 3, rulesStored: 3 };
    });
    const mem = makeProgram(makeMinimalBindings({ runReflectionRules }));

    await mem.parseAsync(["reflect-rules", "--verbose"], { from: "user" });

    expect(runReflectionRules).toHaveBeenCalledTimes(1);
    const joined = lines.join("\n");
    expect(joined).toContain("reflect-rules — start");
    expect(joined).toMatch(/reflect-rules — complete in \d+s/);
    expect(joined).toContain("Reflection (rules) complete: extracted 3 rules");
  });

  it("reflect-rules without --verbose does not emit heartbeat lines", async () => {
    const lines = captureLogs();
    const runReflectionRules = vi.fn().mockResolvedValue({ rulesExtracted: 0, rulesStored: 0 });
    const mem = makeProgram(makeMinimalBindings({ runReflectionRules }));

    await mem.parseAsync(["reflect-rules"], { from: "user" });

    const joined = lines.join("\n");
    expect(joined).not.toContain("reflect-rules — start");
    expect(joined).not.toContain("reflect-rules — complete");
    expect(joined).toContain("Reflection (rules) complete: extracted 0 rules");
  });

  it("reflect-rules --verbose surfaces a failed heartbeat line when the LLM call rejects", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    const runReflectionRules = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const mem = makeProgram(makeMinimalBindings({ runReflectionRules }));

    await expect(mem.parseAsync(["reflect-rules", "--verbose"], { from: "user" })).rejects.toThrow(
      "provider unavailable",
    );

    const joined = lines.join("\n");
    expect(joined).toContain("reflect-rules — start");
    expect(joined).toMatch(/reflect-rules — failed after \d+s: .*provider unavailable/);
  });
});
