import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hybridConfigSchema, type HybridMemoryConfig } from "../config.js";
import type { PendingDigestFactsDb } from "../services/pending-digest-autopilot.js";
import { runPendingDigestAutopilotCron } from "../services/pending-digest-autopilot-cron.js";
import { parseExitLine, validateMaintenanceExecution } from "../services/cron-exit-validator.js";

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
});
