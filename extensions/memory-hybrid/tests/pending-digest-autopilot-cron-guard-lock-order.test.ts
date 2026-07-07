import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HybridMemoryConfig, hybridConfigSchema } from "../config.js";
import { getGuardFilePath } from "../services/cron-guard.js";
import type { PendingDigestFactsDb } from "../services/pending-digest-autopilot.js";
import { runPendingDigestAutopilotCron } from "../services/pending-digest-autopilot-cron.js";

const fsCalls: Array<{ op: "writeFileSync" | "rmSync"; path: string }> = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      const path = args[0];
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
  const dir = mkdtempSync(join(tmpdir(), "pending-digest-autopilot-cron-order-"));
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

describe("pending digest autopilot cron guard/lock release ordering", () => {
  it("writes the guard timestamp before releasing the apply-mode lock on a successful run", async () => {
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

    expect(result.summary.status).toBe("ok");
    expect(result.summary.skipReason).toBeUndefined();

    const guardWriteIdx = fsCalls.findIndex((c) => c.op === "writeFileSync" && c.path === guardPath);
    const lockReleaseIdx = fsCalls.findIndex((c) => c.op === "rmSync" && c.path === lockPath);
    expect(guardWriteIdx).toBeGreaterThanOrEqual(0);
    expect(lockReleaseIdx).toBeGreaterThanOrEqual(0);
    // Regression guard for the TOCTOU race: a concurrent cron invocation reads the guard
    // timestamp to decide whether to run. If the lock were released first, a second
    // invocation could acquire it and start a duplicate apply pass before this run's guard
    // write becomes visible, defeating the guard window entirely.
    expect(guardWriteIdx).toBeLessThan(lockReleaseIdx);
  });
});
