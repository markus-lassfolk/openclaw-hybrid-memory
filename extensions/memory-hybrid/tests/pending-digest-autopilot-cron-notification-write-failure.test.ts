import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HybridMemoryConfig, hybridConfigSchema } from "../config.js";
import { parseExitLine } from "../services/cron-exit-validator.js";
import { runPendingDigestAutopilotCron } from "../services/pending-digest-autopilot-cron.js";
import type { PendingDigestFactsDb } from "../services/pending-digest-autopilot.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      const path = args[0];
      if (typeof path === "string" && path.includes(".notification.json")) {
        throw new Error("simulated notification failure");
      }
      return actual.writeFileSync(...args);
    },
  };
});

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-digest-autopilot-cron-notif-"));
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

describe("pending digest autopilot cron notification write failure (mocked fs)", () => {
  it("elevates skipped run to partial when notification payload write fails", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"), {
      autopilot: {
        enabled: false,
        notifyOnNoop: true,
      },
    });
    const result = await runPendingDigestAutopilotCron({
      cfg,
      factsDb: factsDb(),
      openclawHome: dir,
      now: new Date("2026-05-13T08:20:00Z"),
    });
    expect(result.summary.status).toBe("partial");
    expect(result.summary.skipReason).toBeUndefined();
    const notif = readFileSync(result.summary.artifacts.hmExit, "utf-8")
      .split("\n")
      .map((line) => parseExitLine(line))
      .find((l) => l?.step === "notification-policy");
    expect(notif?.exitCode).toBe(1);
    expect(notif?.status).toBe("failed");
  });
});
