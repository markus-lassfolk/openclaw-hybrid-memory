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
