/**
 * Regression test for cli/skills.ts's `skills queue --limit` handling:
 *
 * `const limit = opts.limit ? Math.max(1, Math.min(100, Number(opts.limit))) : 20;` had no
 * `Number.isFinite` check, so a non-numeric `--limit` (e.g. a typo) produced `NaN`.
 * `CrystallizationStore.list()` guards the SQL `LIMIT` clause with `if (filter?.limit &&
 * filter.limit > 0)`, and `NaN` is falsy, so the clause was silently skipped -- returning the
 * entire unfiltered `crystallization_proposals` table instead of erroring or defaulting to 20.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { registerSkillsCommands } from "../cli/skills.js";

let tmpDir: string;
let store: CrystallizationStore;
let originalExitCode: string | number | null | undefined;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  tmpDir = mkdtempSync(join(tmpdir(), "skills-queue-limit-"));
  store = new CrystallizationStore(join(tmpDir, "crystallization.db"));
  for (let i = 0; i < 25; i++) {
    store.create({
      patternId: `pattern-${i}`,
      evidenceHash: `hash-${i}`,
      skillName: `test-skill-${i}`,
      skillContent: "# skill",
      patternSnapshot: "{}",
    });
  }
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildProgram(): Command {
  const program = new Command("hybrid-mem");
  program.exitOverride();
  registerSkillsCommands(program, {
    factsDb: null,
    crystallizationStore: store,
    cfg: {} as never,
  });
  return program;
}

describe("skills queue --limit validation (regression)", () => {
  it("rejects a non-numeric --limit instead of silently returning every proposal", async () => {
    const program = buildProgram();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "queue", "--limit", "not-a-number"], { from: "user" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--limit must be a positive number"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("defaults to 20 results when --limit is omitted, even with more proposals queued", async () => {
    const program = buildProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "queue", "--json"], { from: "user" });

    const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { count?: number };
    expect(parsed.count).toBe(20);
  });

  it("still accepts a valid numeric --limit", async () => {
    const program = buildProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "queue", "--limit", "5", "--json"], { from: "user" });

    const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { count?: number };
    expect(parsed.count).toBe(5);
  });
});
