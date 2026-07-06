/**
 * Tests for extract-daily's heartbeat + no-op-sink-survival fix.
 *
 * Audit finding: `cmd-extract-daily.ts` (a) never emitted any progress signal during the
 * potentially-slow per-line embedding/classification work inside a day scan, and (b) wrote every
 * diagnostic exclusively through `sink`, which the default cron path (`maintenance-step-runners.ts`
 * `buildCliMaintenanceRunners`) substitutes with a no-op `{ log, warn }` — silently dropping
 * warnings (e.g. embedding failures) regardless of `--verbose`.
 *
 * These tests assert the fix: (1) a verbose run emits heartbeat start/complete lines even with a
 * no-op sink, and (2) an embedding failure still surfaces via `ctx.logger.warn` even with a no-op
 * sink.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { runExtractDailyForCli } from "../cli/cmd-extract-daily.js";
import type { HandlerContext } from "../cli/handlers.js";
import { formatDateUtc } from "../utils/dates.js";

/** The no-op sink the orchestrator's default cron path substitutes for extract-daily. */
function noopLog(): void {}
const NOOP_SINK = { log: noopLog, warn: noopLog };

function makeCtx(
  db: FactsDB,
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> },
  embedImpl: () => Promise<number[]>,
): HandlerContext {
  return {
    factsDb: db,
    vectorDb: {
      delete: vi.fn().mockResolvedValue(false),
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
    },
    embeddings: { embed: vi.fn(embedImpl), modelName: "test-embedding" },
    openai: {} as unknown as HandlerContext["openai"],
    cfg: {
      credentials: { enabled: false },
      store: { classifyBeforeWrite: true },
      autoClassify: { batchSize: 10 },
    } as unknown as HandlerContext["cfg"],
    credentialsDb: null,
    aliasDb: null,
    detectCategory: () => "decision",
    logger,
  } as unknown as HandlerContext;
}

// Frozen instant shared by test setup and the SUT's own `new Date()` calls, so the day-file name
// the test writes always matches the day the function scans for — independent of real wall-clock
// timing/queuing jitter when this file runs alongside many others.
const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");

describe("runExtractDailyForCli — heartbeat + no-op-sink diagnostics survival", () => {
  let dir: string | null = null;
  let db: FactsDB | null = null;
  let originalHome: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else Reflect.deleteProperty(process.env, "HOME");
  });

  function writeTodayMemoryFile(homeDir: string, lines: string[]): void {
    const memoryDir = join(homeDir, ".openclaw", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const dateStr = formatDateUtc(Math.floor(FIXED_NOW.getTime() / 1000));
    writeFileSync(join(memoryDir, `${dateStr}.md`), lines.join("\n"), "utf-8");
  }

  it("emits heartbeat start/complete lines via console when verbose, even with a no-op sink", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-daily-heartbeat-"));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    writeTodayMemoryFile(dir, ["A perfectly ordinary decision about the deployment rollout plan."]);
    db = new FactsDB(join(dir, "facts.db"));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const ctx = makeCtx(db, logger, async () => [0.1]);
    await runExtractDailyForCli(ctx, { days: 1, dryRun: false, verbose: true }, NOOP_SINK);

    expect(logs.some((l) => l.includes("extract-daily — start"))).toBe(true);
    expect(logs.some((l) => l.includes("extract-daily — complete in"))).toBe(true);
  });

  it("does not emit heartbeat lines when verbose is false", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-daily-heartbeat-off-"));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    writeTodayMemoryFile(dir, ["A perfectly ordinary decision about the deployment rollout plan."]);
    db = new FactsDB(join(dir, "facts.db"));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const ctx = makeCtx(db, logger, async () => [0.1]);
    await runExtractDailyForCli(ctx, { days: 1, dryRun: false, verbose: false }, NOOP_SINK);

    expect(logs.some((l) => l.includes("extract-daily — start"))).toBe(false);
  });

  it("surfaces an embedding failure warning via ctx.logger even when sink.warn is a no-op", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-daily-diag-"));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    writeTodayMemoryFile(dir, ["A perfectly ordinary decision about the deployment rollout plan."]);
    db = new FactsDB(join(dir, "facts.db"));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sinkWarn = vi.fn();

    const ctx = makeCtx(db, logger, async () => {
      throw new Error("embedding backend unavailable");
    });

    const result = await runExtractDailyForCli(
      ctx,
      { days: 1, dryRun: false, verbose: false },
      { log: noopLog, warn: sinkWarn },
    );

    // The standalone-CLI sink still receives the warning (unchanged behavior)...
    expect(sinkWarn).toHaveBeenCalledWith(expect.stringContaining("extract-daily embedding failed"));
    // ...but under the orchestrator's no-op sink substitution, ctx.logger must ALSO receive it, or
    // the failure would be invisible in the default cron path regardless of --verbose (the bug).
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("extract-daily embedding failed"));
    expect(result.totalStored).toBe(1);
    expect(result.vectorFailures ?? 0).toBeGreaterThan(0);
    expect(result.semanticOutcome).toBe("partial");
  });

  it("still records the warning via ctx.logger when the sink itself is the orchestrator's no-op sink", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-daily-diag-noop-"));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    writeTodayMemoryFile(dir, ["A perfectly ordinary decision about the deployment rollout plan."]);
    db = new FactsDB(join(dir, "facts.db"));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const ctx = makeCtx(db, logger, async () => {
      throw new Error("embedding backend unavailable");
    });

    await runExtractDailyForCli(ctx, { days: 1, dryRun: false, verbose: false }, NOOP_SINK);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("extract-daily embedding failed"));
  });

  it("honors maintenance.privacyRedaction when enabled — a home path is scrubbed from the stored fact", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-daily-redaction-"));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    writeTodayMemoryFile(dir, ["Decision: back up photos to /home/alice/Pictures every night automatically."]);
    db = new FactsDB(join(dir, "facts.db"));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const ctx = makeCtx(db, logger, async () => [0.1]);
    (ctx.cfg as { maintenance?: unknown }).maintenance = {
      privacyRedaction: { enabled: true, exemptCategories: [], exemptKeys: [] },
    };

    await runExtractDailyForCli(ctx, { days: 1, dryRun: false, verbose: false }, NOOP_SINK);

    const facts = db.getAll();
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.text.includes("[private-path]"))).toBe(true);
    expect(facts.some((f) => f.text.includes("/home/alice"))).toBe(false);
  });

  it("honors maintenance.privacyRedaction on the classify-before-write batched path too (a pre-existing similar fact routes the line through flushPendingExtractClassify, not the direct store path)", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-daily-redaction-batched-"));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    // Same entity+key ("user"/"prefer") as the new line below, so findSimilarForClassification
    // finds this as a similar fact and routes the new line through the batch classify path
    // instead of the direct (already-covered) store path.
    db = new FactsDB(join(dir, "facts.db"));
    db.store({
      text: "I prefer the old backup folder for photos.",
      category: "decision",
      importance: 0.5,
      entity: "user",
      key: "prefer",
      value: "the old backup folder for photos",
      source: "conversation",
    });
    writeTodayMemoryFile(dir, [
      "I prefer to back up photos to /home/alice/Pictures every night automatically.",
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const ctx = makeCtx(db, logger, async () => [0.1]);
    (ctx.cfg as { maintenance?: unknown }).maintenance = {
      privacyRedaction: { enabled: true, exemptCategories: [], exemptKeys: [] },
    };
    // A fast, working classification response avoids the adaptive-retry backoff path a broken
    // openai stub would otherwise trigger (which hangs under fake timers in this test).
    ctx.openai = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "ADD | test" } }] }) } },
    } as unknown as HandlerContext["openai"];
    const vectorDbStore = (ctx.vectorDb as unknown as { store: ReturnType<typeof vi.fn> }).store;

    await runExtractDailyForCli(ctx, { days: 1, dryRun: false, verbose: false }, NOOP_SINK);

    // Classification has no working LLM in this test harness (openai is an empty stub) and falls
    // back to {action: "ADD"} on failure, which still routes through flushPendingExtractClassify's
    // default store branch — exactly the path that leaked unredacted text before this fix.
    expect(vectorDbStore).toHaveBeenCalled();
    const storedTexts = vectorDbStore.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(storedTexts.some((t) => t.includes("[private-path]"))).toBe(true);
    expect(storedTexts.some((t) => t.includes("/home/alice"))).toBe(false);

    const facts = db.getAll();
    const newFact = facts.find((f) => f.text.includes("back up photos"));
    expect(newFact).toBeDefined();
    expect(newFact?.text).toContain("[private-path]");
    expect(newFact?.text).not.toContain("/home/alice");
  });
});
