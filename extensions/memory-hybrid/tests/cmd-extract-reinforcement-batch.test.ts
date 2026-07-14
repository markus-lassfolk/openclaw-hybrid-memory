import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import {
  readReinforcementBatchState,
  resolveReinforcementBatchStateDir,
  runExtractReinforcementForCli,
} from "../cli/cmd-extract-reinforcement.js";
import type { HandlerContext } from "../cli/handlers.js";
import { runReinforcementExtract } from "../services/reinforcement-extract.js";

vi.mock("../services/reinforcement-extract.js", () => ({
  runReinforcementExtract: vi.fn(),
}));

vi.mock("../services/session-pre-filter.js", () => ({
  preFilterSessions: vi.fn(async (paths: string[]) => ({ kept: paths, ollamaUnavailable: true })),
}));

vi.mock("../cli/cmd-extract-sessions.js", () => ({
  getSessionFilePathsSince: vi.fn(() => ["fake-session.jsonl"]),
  getMaxMtime: vi.fn(() => Date.now()),
}));

let tmpDir: string;
let factsDb: FactsDB;
let workspace: string;

const incident = {
  userMessage: "great job",
  agentBehavior: "done",
  precedingUserMessage: "go",
  sessionFile: "s.jsonl",
  timestamp: "2026-01-01",
  confidence: 0.9,
  recalledMemoryIds: [] as string[],
  toolCallSequence: [] as string[],
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reinf-batch-"));
  workspace = join(tmpDir, "workspace");
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  vi.mocked(runReinforcementExtract).mockResolvedValue({
    incidents: [incident],
    sessionsScanned: 1,
  });
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeCtx(openai: unknown): HandlerContext {
  return {
    factsDb,
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandlerContext["vectorDb"],
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
      modelName: "test",
    } as unknown as HandlerContext["embeddings"],
    openai,
    proposalsDb: null,
    cfg: {
      procedures: { sessionsDir: tmpDir },
      distill: { extractionModelTier: "nano" },
      llm: { maintenance: ["test-model"], nano: ["test-model"], _source: undefined },
      reinforcement: {
        reinforcementLLMAnalysis: true,
        maxIncidentsPerRun: 100,
        analysisBatchSize: 25,
      },
      selfCorrection: { semanticDedup: false },
    } as HandlerContext["cfg"],
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    identityReflectionStore: null,
    personaStateStore: null,
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    resolvedLancePath: join(tmpDir, "lance"),
    pluginId: "test",
    logger: { info: vi.fn(), warn: vi.fn() },
    detectCategory: () => "technical",
  } as HandlerContext;
}

describe("extract-reinforcement batching", () => {
  it("dry-run skips LLM analysis and does not create batch state dir", async () => {
    const create = vi.fn();
    const ctx = makeCtx({ chat: { completions: { create } } });

    await runExtractReinforcementForCli(ctx, {
      workspace,
      dryRun: true,
      full: true,
      force: true,
    });

    expect(create).not.toHaveBeenCalled();
    expect(existsSync(resolveReinforcementBatchStateDir(workspace))).toBe(false);
  });

  it("truncates incidents to maxIncidentsPerRun before analysis", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...incident,
      userMessage: `msg ${i}`,
      sessionFile: `${i}.jsonl`,
    }));
    vi.mocked(runReinforcementExtract).mockResolvedValue({
      incidents: many,
      sessionsScanned: 5,
    });

    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '[{"remediationType":"NO_ACTION","category":"technical","severity":"low","remediationContent":"ok","incidentIndex":0}]',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const ctx = makeCtx({ chat: { completions: { create } } });
    (ctx.cfg as HandlerContext["cfg"]).reinforcement = {
      ...(ctx.cfg.reinforcement ?? {}),
      maxIncidentsPerRun: 2,
      analysisBatchSize: 1,
    };

    const warn = vi.fn();
    ctx.logger = { info: vi.fn(), warn };

    await runExtractReinforcementForCli(ctx, { workspace, full: true, force: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("truncated=true"));
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("extract-reinforcement MEMORY_STORE merge re-embeds the merged text (loop iteration 62 regression)", () => {
  it("stores entry.text (the merged content), not the pre-merge fragment, when storeWithResult merges", async () => {
    // fuzzyDedupe + onDuplicate: merge for the "reinforcement-analysis" source, matching the
    // convention in tests/memory-store-merge-dedupe-vector.test.ts, so a plain case-insensitive
    // hash duplicate deterministically merges without needing a real embedding-similarity feed.
    factsDb.close();
    factsDb = new FactsDB(join(tmpDir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: { fuzzyDedupe: true, sourceProfiles: { "reinforcement-analysis": { onDuplicate: "merge" } } },
    });

    const firstText = "Deployed the payment service to production version one.";
    const secondText = "DEPLOYED THE PAYMENT SERVICE TO PRODUCTION VERSION ONE.";

    vi.mocked(runReinforcementExtract).mockResolvedValue({
      incidents: [
        { ...incident, sessionFile: "a.jsonl" },
        { ...incident, sessionFile: "b.jsonl" },
      ],
      sessionsScanned: 2,
    });

    const embedCalls: string[] = [];
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify([
              {
                remediationType: "MEMORY_STORE",
                category: "technical",
                severity: "low",
                remediationContent: { text: firstText },
                incidentIndex: 0,
              },
              {
                remediationType: "MEMORY_STORE",
                category: "technical",
                severity: "low",
                remediationContent: { text: secondText },
                incidentIndex: 1,
              },
            ]),
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const vectorDbStore = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ chat: { completions: { create } } });
    ctx.factsDb = factsDb;
    ctx.vectorDb = {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vectorDbStore,
    } as unknown as HandlerContext["vectorDb"];
    ctx.embeddings = {
      embed: vi.fn(async (text: string) => {
        embedCalls.push(text);
        return [0.1, 0.2, 0.3, 0.4];
      }),
      modelName: "test",
    } as unknown as HandlerContext["embeddings"];
    (ctx.cfg as HandlerContext["cfg"]).reinforcement = {
      ...(ctx.cfg.reinforcement ?? {}),
      maxIncidentsPerRun: 2,
      analysisBatchSize: 2,
    };

    // Bypass the cheap pre-check so the real storeWithResult merge path runs.
    vi.spyOn(factsDb, "hasDuplicate").mockReturnValue(false);

    await runExtractReinforcementForCli(ctx, { workspace, full: true, force: true });

    // list()'s category filter validates against a stricter enum than storeWithResult's own
    // write-time validation, so filtering by category:"technical" here would silently return []
    // even though the fact really was stored with that category -- list unfiltered instead.
    const stored = factsDb.list(20, {}).find((f) => f.source === "reinforcement-analysis");
    expect(stored?.text).toContain(firstText);
    expect(stored?.text).toContain(secondText);
    expect(stored?.text).not.toBe(firstText);

    const storedTexts = vectorDbStore.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(storedTexts).toContain(stored?.text);
    expect(storedTexts.every((t) => t !== secondText)).toBe(true);
    expect(embedCalls.some((t) => t === stored?.text)).toBe(true);
  });
});

describe("extract-reinforcement batch heartbeat (cron silence audit)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a heartbeat start/still-running/complete around a slow single-batch LLM call when verbose", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    let resolveCreate: ((value: unknown) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const ctx = makeCtx({ chat: { completions: { create } } });

    const runPromise = runExtractReinforcementForCli(ctx, {
      workspace,
      full: true,
      force: true,
      verbose: true,
    });

    // Drain microtasks so execution reaches the (still-pending) LLM call inside the batch loop.
    for (let i = 0; i < 25; i++) {
      await Promise.resolve();
    }
    expect(logs.some((line) => line.includes("memory-hybrid: extract-reinforcement — start"))).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);

    // Simulate the batch's LLM call blocking for a full heartbeat interval (default 60s) without
    // resolving — this is exactly the silent-hang scenario the audit flagged.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs.some((line) => line.includes("memory-hybrid: extract-reinforcement — still running after 60s"))).toBe(
      true,
    );

    resolveCreate?.({
      choices: [
        {
          message: {
            content:
              '[{"remediationType":"NO_ACTION","category":"technical","severity":"low","remediationContent":"ok","incidentIndex":0}]',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    expect(logs.some((line) => line.includes("memory-hybrid: extract-reinforcement — complete in"))).toBe(true);
  });
});

describe("readReinforcementBatchState", () => {
  it("preserves all seven diagnostic counters on resume", () => {
    const statePath = join(tmpdir(), `reinf-state-${Date.now()}.json`);
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        incidentsHash: "abc123",
        batchSize: 5,
        totalBatches: 2,
        completedBatchIndexes: [0],
        analysed: [],
        diagnostics: {
          parseFailures: 1,
          fallbacks: 2,
          parsedItems: 3,
          batchSplits: 4,
          truncations: 5,
          retries: 6,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const state = readReinforcementBatchState(statePath);
    expect(state?.diagnostics).toEqual({
      parseFailures: 1,
      fallbacks: 2,
      parsedItems: 3,
      batchSplits: 4,
      truncations: 5,
      retries: 6,
    });

    rmSync(statePath, { force: true });
  });
});
