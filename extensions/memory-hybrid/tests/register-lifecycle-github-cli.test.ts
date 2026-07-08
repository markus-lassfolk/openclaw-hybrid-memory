/**
 * CLI wiring coverage for `hybrid-mem lifecycle sync github` (silent-hang audit fix).
 *
 * Verifies the three fixes applied on top of the unbounded, per-row `gh api` scan in
 * services/lifecycle/github-adapter.ts:
 *   1. `--verbose` is a real option on the command.
 *   2. The CLI now passes a real (non-no-op) logger into `syncLifecycleFromGitHub`, so its
 *      internal `logger.info` line is no longer silently swallowed.
 *   3. The CLI drives a `runMaintenanceHeartbeat` progress heartbeat off `onProgress` ticks
 *      forwarded from the adapter's row-scan loop.
 *
 * `syncLifecycleFromGitHub` itself is mocked here — the adapter's own scan/progress behaviour is
 * covered by tests/lifecycle-github-adapter.test.ts. This file only asserts the CLI layer wires
 * `logger`/`onProgress`/`--verbose` through correctly.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerLifecycleSyncCommands } from "../cli/commands/manage/register-lifecycle.js";
import type { LifecycleSyncReport } from "../services/lifecycle/github-adapter.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

const syncLifecycleFromGitHubMock = vi.fn();

vi.mock("../services/lifecycle/github-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/lifecycle/github-adapter.js")>();
  return {
    ...actual,
    syncLifecycleFromGitHub: (...args: unknown[]) => syncLifecycleFromGitHubMock(...args),
  };
});

const EMPTY_REPORT: LifecycleSyncReport = {
  ok: true,
  scanned: 0,
  matched: 0,
  expiredNow: 0,
  expiredSoon: 0,
  keptStable: 0,
  errors: [],
};

function makeProgram(): Command {
  const program = new Command("hybrid-mem");
  program.exitOverride();
  const bindings = {
    factsDb: {},
    cfg: { lifecycle: { adapters: { github: { enabled: true, repos: ["openclaw/clawdbot"] } } } },
  } as unknown as ManageBindings;
  registerLifecycleSyncCommands(program, bindings);
  return program;
}

describe("lifecycle sync github CLI wiring", () => {
  beforeEach(() => {
    syncLifecycleFromGitHubMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a real --verbose option (not silently ignored by Commander)", () => {
    const program = makeProgram();
    const githubCmd = program.commands
      .find((c) => c.name() === "lifecycle")
      ?.commands.find((c) => c.name() === "sync")
      ?.commands.find((c) => c.name() === "github");
    expect(githubCmd).toBeDefined();
    const verboseOption = githubCmd?.options.find((o) => o.long === "--verbose");
    expect(verboseOption).toBeDefined();
    expect(verboseOption?.short).toBe("-v");
  });

  it("passes a real (non-no-op) logger into syncLifecycleFromGitHub — the internal info line fires", async () => {
    syncLifecycleFromGitHubMock.mockImplementation(async (_factsDb: unknown, opts: { logger?: { info: (m: string) => void } }) => {
      opts.logger?.info("lifecycle.github: scanning 0 candidate row(s) across 1 repo(s)");
      return EMPTY_REPORT;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = makeProgram();
    await program.parseAsync(["lifecycle", "sync", "github"], { from: "user" });

    expect(syncLifecycleFromGitHubMock).toHaveBeenCalledTimes(1);
    const passedOpts = syncLifecycleFromGitHubMock.mock.calls[0]?.[1] as { logger?: { info: unknown; warn: unknown } };
    expect(typeof passedOpts.logger?.info).toBe("function");
    expect(typeof passedOpts.logger?.warn).toBe("function");
    // Prove it's a real sink, not the adapter's `{ info: () => {}, warn: () => {} }` fallback:
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("lifecycle.github: scanning 0 candidate"))).toBe(true);
  });

  it("--verbose emits a maintenance heartbeat start line and forwards onProgress ticks from a multi-row scan", async () => {
    syncLifecycleFromGitHubMock.mockImplementation(
      async (_factsDb: unknown, opts: { onProgress?: (p: { scanned: number; total: number; matched: number }) => void }) => {
        opts.onProgress?.({ scanned: 25, total: 100, matched: 3 });
        opts.onProgress?.({ scanned: 100, total: 100, matched: 9 });
        return { ...EMPTY_REPORT, scanned: 100, matched: 9 };
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = makeProgram();
    await program.parseAsync(["lifecycle", "sync", "github", "--verbose"], { from: "user" });

    expect(syncLifecycleFromGitHubMock).toHaveBeenCalledTimes(1);
    const passedOpts = syncLifecycleFromGitHubMock.mock.calls[0]?.[1] as { onProgress?: unknown };
    expect(typeof passedOpts.onProgress).toBe("function");
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("lifecycle-sync-github — start"))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("lifecycle-sync-github — complete in"))).toBe(true);
  });

  it("without --verbose, no heartbeat start/still-running lines are emitted", async () => {
    syncLifecycleFromGitHubMock.mockResolvedValue(EMPTY_REPORT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = makeProgram();
    await program.parseAsync(["lifecycle", "sync", "github"], { from: "user" });

    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("lifecycle-sync-github — start"))).toBe(false);
  });

  it("--json routes the adapter's logger.info progress to stderr so stdout stays pure JSON", async () => {
    syncLifecycleFromGitHubMock.mockImplementation(async (_factsDb: unknown, opts: { logger?: { info: (m: string) => void } }) => {
      opts.logger?.info("lifecycle.github: scanning 0 candidate row(s) across 1 repo(s)");
      return EMPTY_REPORT;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = makeProgram();
    await program.parseAsync(["lifecycle", "sync", "github", "--json"], { from: "user" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("lifecycle.github: scanning 0 candidate"))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("lifecycle.github: scanning 0 candidate"))).toBe(
      false,
    );
    // stdout must be pure, parseable JSON with --json (no leaked adapter progress lines).
    const jsonCall = logSpy.mock.calls.find((c) => String(c[0]).trim().startsWith("{"));
    expect(jsonCall).toBeDefined();
    expect(() => JSON.parse(String(jsonCall?.[0]))).not.toThrow();
  });
});
