/**
 * Regression test (loop iteration 76) for cli/cmd-health.ts:
 *
 * `health --json` computed `overall`/exit status only inside the JSON branch's own
 * inline ternary, printed it, and then unconditionally `return`ed — it never called
 * `process.exit(1)` even when an indicator reported "error". Only the human-readable
 * branch (reached when `--json` is absent) called `process.exit(1)` for the same
 * condition. So a script that ran `health --json` and gated on the exit code (rather
 * than parsing/grepping the JSON body) would see `overall: "unhealthy"` in the output
 * but a successful (0) exit code — silently defeating automation.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/provider-detection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/provider-detection.js")>();
  return { ...actual, detectAvailableProviders: vi.fn() };
});

describe("health --json exit code (loop iteration 76 regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function setupHealthHarness(cfg: unknown, factsDb: unknown, vectorDb: unknown) {
    const { detectAvailableProviders } = await import("../utils/provider-detection.js");
    vi.mocked(detectAvailableProviders).mockResolvedValue([
      {
        provider: "openai",
        available: true,
        requiresApiKey: true,
        localOnly: false,
      },
    ]);

    const { registerHealthCommand } = await import("../cli/cmd-health.js");
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerHealthCommand(mem, cfg as never, factsDb as never, vectorDb as never, null);
    return mem;
  }

  it("calls process.exit(1) for `health --json` when an indicator is in error status", async () => {
    const cfg = { embedding: { provider: "openai" } };
    const factsDb = {
      getCount: () => {
        throw new Error("db down");
      },
    };
    const vectorDb = { getAllIds: async () => [] };
    const mem = await setupHealthHarness(cfg, factsDb, vectorDb);

    let jsonOutput = "";
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") jsonOutput += msg;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["health", "--json"], { from: "user" });

    const report = JSON.parse(jsonOutput) as { overall: string };
    expect(report.overall).toBe("unhealthy");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not call process.exit for `health --json` when all indicators are healthy", async () => {
    const cfg = { embedding: { provider: "openai" } };
    const factsDb = { getCount: () => 5 };
    const vectorDb = { getAllIds: async () => ["a", "b", "c", "d", "e"] };
    const mem = await setupHealthHarness(cfg, factsDb, vectorDb);

    let jsonOutput = "";
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") jsonOutput += msg;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["health", "--json"], { from: "user" });

    const report = JSON.parse(jsonOutput) as { overall: string };
    expect(report.overall).not.toBe("unhealthy");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
