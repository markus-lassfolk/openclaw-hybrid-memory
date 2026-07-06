import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageDigest } from "../cli/commands/manage/register-digest.js";
import { type HybridMemoryConfig, hybridConfigSchema } from "../config.js";
import { parseExitLine, validateMaintenanceExecution } from "../services/cron-exit-validator.js";
import { runPendingDigestAutopilotCron } from "../services/pending-digest-autopilot-cron.js";
import type { PendingDigestFactsDb } from "../services/pending-digest-autopilot.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-digest-autopilot-cron-"));
  dirs.push(dir);
  return dir;
}

function configFor(sqlitePath: string, digest?: Record<string, unknown>): HybridMemoryConfig {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-embed-key-that-is-long-enough",
      model: "text-embedding-3-small",
    },
    sqlitePath,
    lanceDbPath: join(dirname(sqlitePath), "lancedb"),
    credentials: { enabled: false },
    wal: { enabled: false },
    personaProposals: { enabled: true },
    verification: { enabled: false },
    provenance: { enabled: false },
    nightlyCycle: { enabled: false },
    ...(digest ? { digest } : {}),
  });
}

function factsDb(): PendingDigestFactsDb {
  return {
    proceduresCount: () => 0,
    proceduresValidatedCount: () => 0,
    proceduresPromotedCount: () => 0,
    countVerifiedFacts: () => 0,
    proceduresValidatedSince: () => 0,
    triageProcedures: () => ({
      rows: [],
      summary: {
        total: 0,
        byReason: {
          awaiting_approval: 0,
          missing_anchor: 0,
          unknown: 0,
          duplicate_skill: 0,
          low_recall: 0,
        },
        topReason: "unknown",
      },
    }),
  };
}

function seedLatestDigestSuccess(openclawHome: string): void {
  const day = join(openclawHome, "logs", "cron-hybrid-mem", "20260512");
  const exitPath = join(day, "weekly-pending-digest-2026-05-12T08-00-00Z.exit.txt");
  const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
  rmSync(day, { recursive: true, force: true });
  mkdirSync(day, { recursive: true });
  writeFileSync(
    exitPath,
    "2026-05-12T08:00:00Z step=digest-pending exit=0 status=ok reason=ok duration_ms=1\n",
    "utf-8",
  );
  writeFileSync(logPath, "weekly pending digest ok\n", "utf-8");
}

function seedLatestDigestFailedWithOlderSuccess(openclawHome: string): void {
  const day = join(openclawHome, "logs", "cron-hybrid-mem", "20260512");
  rmSync(day, { recursive: true, force: true });
  mkdirSync(day, { recursive: true });
  const older = join(day, "weekly-pending-digest-2026-05-12T07-00-00Z.exit.txt");
  const newer = join(day, "weekly-pending-digest-2026-05-12T09-00-00Z.exit.txt");
  writeFileSync(older, "2026-05-12T07:00:00Z step=digest-pending exit=0 status=ok reason=ok duration_ms=1\n", "utf-8");
  writeFileSync(
    newer,
    "2026-05-12T09:00:00Z step=digest-pending exit=1 status=failed reason=inner_command_failed duration_ms=1\n",
    "utf-8",
  );
  utimesSync(older, new Date("2026-05-12T07:00:00Z"), new Date("2026-05-12T07:00:00Z"));
  utimesSync(newer, new Date("2026-05-12T09:00:00Z"), new Date("2026-05-12T09:00:00Z"));
}

describe("pending digest autopilot cron wrapper", () => {
  it("writes required HM_EXIT rows for disabled config as explicit skip", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });
    expect(result.summary.status).toBe("skipped");
    expect(result.summary.skipReason).toBe("autopilot_disabled");

    const lines = readFileSync(result.summary.artifacts.hmExit, "utf-8")
      .trim()
      .split("\n")
      .map((line) => parseExitLine(line))
      .filter((line): line is NonNullable<typeof line> => !!line);
    const names = new Set(lines.map((line) => line.step));
    expect(names).toEqual(
      new Set([
        "guard-check",
        "config-load",
        "latest-digest-check",
        "digest-autopilot",
        "persona-triage",
        "procedure-promotion",
        "verified-triage",
        "tool-proposals",
        "crystallization-proposals",
        "summary-write",
        "validate-cron-exit",
        "notification-policy",
      ]),
    );
  });

  it("mirrors internal step-ledger progress to an onProgress sink without changing the hmLog artifact", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const progressLines: string[] = [];

    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
      onProgress: (line) => progressLines.push(line),
    });

    expect(result.summary.status).toBe("skipped");
    expect(result.summary.skipReason).toBe("autopilot_disabled");

    // The free-text run.* lines and every markStep step transition must reach the
    // operator-facing sink (e.g. stdout via --verbose), not just the private hmLog file.
    expect(progressLines.some((line) => line.startsWith("run.start run_id="))).toBe(true);
    expect(progressLines.some((line) => line.startsWith("run.finish status=skipped"))).toBe(true);
    expect(progressLines).toContainEqual(expect.stringMatching(/^step=guard-check status=ok reason=ok/));
    expect(progressLines).toContainEqual(
      expect.stringMatching(/^step=config-load status=skipped reason=autopilot_disabled/),
    );
    expect(progressLines).toContainEqual(
      expect.stringMatching(/^step=persona-triage status=skipped reason=autopilot_disabled/),
    );
    expect(progressLines).toContainEqual(expect.stringMatching(/^step=summary-write status=ok reason=ok/));

    // The private hmLog artifact must still receive every line unchanged, since other
    // consumers (validate-cron-exit, other tests) depend on it continuing to see this content.
    const hmLogContent = readFileSync(result.summary.artifacts.hmLog, "utf-8");
    for (const line of progressLines) {
      expect(hmLogContent).toContain(line);
    }
  });

  it("stays silent by default when no onProgress sink is provided", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });
    expect(result.summary.status).toBe("skipped");
    // No onProgress wired: hmLog is still written (unaffected), just nothing extra happens.
    const hmLogContent = readFileSync(result.summary.artifacts.hmLog, "utf-8");
    expect(hmLogContent).toContain("step=guard-check status=ok reason=ok");
  });

  it("runs dry-run safely, validates exit ledger compatibility, and stays quiet on no-op by default", async () => {
    const dir = newDir();
    seedLatestDigestSuccess(dir);
    const cfg = configFor(join(dir, "facts.db"), {
      autopilot: {
        enabled: true,
        mode: "dry-run",
      },
    });

    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });

    expect(result.summary.status).toBe("ok");
    expect(result.summary.mode).toBe("dry-run");
    expect(result.summary.notificationSent).toBe(false);
    const validation = validateMaintenanceExecution(
      result.summary.artifacts.hmExit,
      result.summary.artifacts.hmLog,
      [
        "guard-check",
        "config-load",
        "latest-digest-check",
        "digest-autopilot",
        "persona-triage",
        "procedure-promotion",
        "verified-triage",
        "tool-proposals",
        "crystallization-proposals",
        "summary-write",
        "validate-cron-exit",
        "notification-policy",
      ],
      true,
    );
    expect(validation.maintenanceStatus).toBe("success");
  });

  it("skips when newest weekly pending digest failed even if an older digest succeeded", async () => {
    const dir = newDir();
    seedLatestDigestFailedWithOlderSuccess(dir);
    const cfg = configFor(join(dir, "facts.db"), {
      autopilot: {
        enabled: true,
        mode: "dry-run",
      },
    });

    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });

    expect(result.summary.status).toBe("skipped");
    expect(result.summary.skipReason).toBe("latest_digest_failed");
    expect(result.summary.latestDigest.found).toBe(false);
    expect(result.summary.latestDigest.status).toBe("failed");
  });

  it("ignores autopilot HM_EXIT artifacts when resolving latest digest", async () => {
    const dir = newDir();
    const day = join(dir, "logs", "cron-hybrid-mem", "20260512");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "weekly-pending-digest-autopilot-2026-05-12T10-00-00Z.exit.txt"),
      "2026-05-12T10:00:00Z step=digest-autopilot exit=1 status=failed reason=inner_command_failed duration_ms=1\n",
      "utf-8",
    );
    utimesSync(
      join(day, "weekly-pending-digest-autopilot-2026-05-12T10-00-00Z.exit.txt"),
      new Date("2026-05-12T10:00:00Z"),
      new Date("2026-05-12T10:00:00Z"),
    );
    const cfg = configFor(join(dir, "facts.db"), {
      autopilot: {
        enabled: true,
        mode: "dry-run",
      },
    });

    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });

    expect(result.summary.status).toBe("skipped");
    expect(result.summary.skipReason).toBe("latest_digest_missing");
  });

  it("skips apply mode when lock is already held", async () => {
    const dir = newDir();
    seedLatestDigestSuccess(dir);
    const lockPath = join(dir, "cron", "locks", "weekly-pending-digest-autopilot.lock.json");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        runId: "other-run",
        acquiredAt: Date.UTC(2026, 4, 13, 8, 19, 0),
        expiresAt: Date.UTC(2026, 4, 13, 9, 19, 0),
      }),
      "utf-8",
    );
    const cfg = configFor(join(dir, "facts.db"), {
      autopilot: {
        enabled: true,
        mode: "apply",
      },
    });

    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });

    expect(result.summary.status).toBe("skipped");
    expect(result.summary.skipReason).toBe("lock_already_held");
  });

  it("CLI: routes --verbose progress to stderr in --json mode so stdout stays pure JSON (#2055)", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerManageDigest(program as never, { cfg, factsDb: factsDb() } as ManageBindings);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await program.parseAsync(["digest", "autopilot-cron", "--json", "--verbose"], { from: "user" });

    const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");

    // stdout must contain exactly the final JSON summary — parseable as pure JSON, no progress
    // lines mixed in — so a downstream consumer of --json output isn't broken by --verbose.
    expect(() => JSON.parse(stdoutText)).not.toThrow();
    expect(stdoutText).not.toContain("run.start");

    // Progress lines go to stderr instead, so --verbose still gives an operator liveness signal.
    expect(stderrText).toContain("run.start");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("CLI: routes --verbose progress to stdout when --json is not set", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerManageDigest(program as never, { cfg, factsDb: factsDb() } as ManageBindings);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await program.parseAsync(["digest", "autopilot-cron", "--verbose"], { from: "user" });

    const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");

    expect(stdoutText).toContain("run.start");
    expect(stderrText).not.toContain("run.start");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
