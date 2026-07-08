import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HybridMemoryConfig, hybridConfigSchema } from "../config.js";
import { getGuardFilePath } from "../services/cron-guard.js";
import type { PendingDigestFactsDb } from "../services/pending-digest-autopilot.js";
import { runPendingDigestAutopilotCron } from "../services/pending-digest-autopilot-cron.js";

// Per-call log so we can assert the lock was released *after* the guard write attempt.
const fsCalls: Array<{ op: "writeFileSync" | "rmSync"; path: string }> = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      const path = args[0];
      // Throw EACCES when the cron tries to write the guard timestamp. The autopilot-cron's
      // guard-write block must catch this and continue into the lock release below — otherwise
      // the lock would be held until its TTL and every subsequent run would skip as locked.
      // Guard file is `<openclawHome>/cron/guard/<jobName>.ms`.
      if (typeof path === "string" && /weekly-pending-digest-autopilot\.ms$/.test(path)) {
        const err = new Error(`EACCES: permission denied, open '${path}'`);
        (err as NodeJS.ErrnoException).code = "EACCES";
        fsCalls.push({ op: "writeFileSync", path });
        throw err;
      }
      if (typeof path === "string") fsCalls.push({ op: "writeFileSync", path });
      return actual.writeFileSync(...args);
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      const path = args[0];
      if (typeof path === "string") fsCalls.push({ op: "rmSync", path });
      return actual.rmSync(...args);
    },
  };
});

const dirs: string[] = [];

afterEach(() => {
  fsCalls.length = 0;
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-digest-autopilot-cron-guard-fail-"));
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

describe("pending digest autopilot cron guard-write failure", () => {
  it("releases the autopilot lock even when the guard timestamp write fails (loop iteration 20 regression)", async () => {
    const dir = newDir();
    seedLatestDigestSuccess(dir);
    const cfg = configFor(join(dir, "facts.db"), {
      autopilot: {
        enabled: true,
        mode: "apply",
      },
    });
    const guardPath = getGuardFilePath("weekly-pending-digest-autopilot", dir);
    const lockPath = join(dir, "cron", "locks", "weekly-pending-digest-autopilot.lock.json");
    fsCalls.length = 0;

    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });

    // The run itself should be marked failed (guard write threw), but the lock must still have
    // been released — otherwise every subsequent autopilot-cron run would skip as locked.
    expect(result.summary.status).toBe("failed");
    const guardWriteAttempts = fsCalls.filter((c) => c.op === "writeFileSync" && c.path === guardPath);
    expect(guardWriteAttempts.length).toBeGreaterThan(0);
    const lockReleaseIdx = fsCalls.findIndex((c) => c.op === "rmSync" && c.path === lockPath);
    expect(lockReleaseIdx).toBeGreaterThan(0);
  });

  it("a subsequent run after a guard-write failure can still acquire the lock", async () => {
    const dir = newDir();
    seedLatestDigestSuccess(dir);
    const cfg = configFor(join(dir, "facts.db"), {
      autopilot: {
        enabled: true,
        mode: "apply",
      },
    });
    fsCalls.length = 0;

    await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });

    // Second run with the same EACCES-on-guard-write mock still in place must not skip as locked.
    const second = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:25:00Z"),
    });
    // The second run must NOT skip as "locked" — the only valid skips here would be a guard
    // window from the (mocked-failed) first run, or some other deterministic skip. If the fix
    // regresses, this assertion catches the lock-stuck behavior. Note: first-run guard write
    // still throws under the mock, so guard timestamp is not actually persisted, so second-run
    // status should be "failed" (the same path will throw again) — never "skipped: locked".
    expect(second.summary.skipReason).not.toBe("locked");
    expect(second.summary.status).toBe("failed");
  });
});
