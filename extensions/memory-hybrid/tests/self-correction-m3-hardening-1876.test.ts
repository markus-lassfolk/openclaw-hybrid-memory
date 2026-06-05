/**
 * Acceptance tests for issue #1876 — self-correction M3 output-format drift,
 * semantic-empty detection, batch resume, retry/backoff, and verbose diagnostics.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import {
  parseSelfCorrectionLLMResponse,
  resolveSelfCorrectionBatchStateDir,
  runSelfCorrectionRunForCli,
  SELF_CORRECTION_BATCH_STATE_PREFIX,
} from "../cli/cmd-selfcorrection.js";
import type { HandlerContext } from "../cli/handlers.js";
import type { CorrectionIncident } from "../services/self-correction-extract.js";

const SAMPLE_INCIDENT: CorrectionIncident = {
  userMessage: "That was wrong — verify first.",
  precedingAssistant: "I ran the command without checking.",
  followingAssistant: "I will verify next time.",
  sessionFile: "2026-01-01-session.jsonl",
  timestamp: "2026-01-01",
};

const SAMPLE_REMEDIATION = {
  category: "workflow",
  severity: "medium",
  remediationType: "MEMORY_STORE",
  remediationContent: { text: "Always verify before running commands.", entity: "Fact", tags: ["workflow"] },
};

const SAMPLE_NO_ACTION = {
  category: "INFO",
  severity: "LOW",
  remediationType: "NO_ACTION",
};

const sampleParserItem = {
  category: "WRONG_APPROACH",
  severity: "MEDIUM",
  remediationType: "MEMORY_STORE",
  remediationContent: { text: "Verify first.", entity: "Behavior", tags: ["safety"] },
};

let tmpDir: string;
let factsDb: FactsDB;
let proposalsDb: ProposalsDB;

function listSelfCorrectionBatchStateFiles(workspace: string): string[] {
  const stateDir = resolveSelfCorrectionBatchStateDir(workspace);
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir).filter((name) => name.startsWith(SELF_CORRECTION_BATCH_STATE_PREFIX));
}

function makeOpenAIMock(responseText: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseText } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      },
    },
  } as any;
}

function makeOpenAINativeToolCallsMock(argumentsJson: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "self_correction_result",
                      arguments: argumentsJson,
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      },
    },
  } as any;
}

function makeCtx(openai: any, overrides?: { selfCorrection?: Record<string, unknown>; llm?: Record<string, unknown> }): HandlerContext {
  return {
    factsDb,
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    } as any,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      modelName: "test-model",
    } as any,
    openai,
    proposalsDb,
    cfg: {
      procedures: { sessionsDir: tmpDir },
      distill: {},
      selfCorrection: {
        semanticDedup: false,
        semanticDedupThreshold: 0.92,
        toolsSection: "Self-correction rules",
        applyToolsByDefault: false,
        autoRewriteTools: false,
        analyzeViaSpawn: false,
        spawnThreshold: 15,
        spawnModel: "",
        ...overrides?.selfCorrection,
      },
      llm: { default: ["test-model"], heavy: ["test-model"], _source: undefined, ...overrides?.llm },
      store: { classifyBeforeWrite: false },
      autoRecall: { enabled: false },
      personaProposals: {
        enabled: true,
        allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md"],
        proposalTTLDays: 30,
        minConfidence: 0.5,
        maxProposalsPerWeek: 5,
        autoApply: false,
      },
    } as any,
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
  } as unknown as HandlerContext;
}

function minimaxCtx(openai: any): HandlerContext {
  return makeCtx(openai, {
    llm: { default: ["minimax/MiniMax-M3"], heavy: ["minimax/MiniMax-M3"] },
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sc-m3-1876-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
});

afterEach(() => {
  vi.restoreAllMocks();
  factsDb.close();
  proposalsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("#1876 — M3 parser output shapes", () => {
  it("parses { items: [...] } envelope", () => {
    const result = parseSelfCorrectionLLMResponse(JSON.stringify({ items: [sampleParserItem] }));
    expect(result).toHaveLength(1);
  });

  it("parses nested { arguments: { items: [...] } } envelope", () => {
    const result = parseSelfCorrectionLLMResponse(JSON.stringify({ arguments: { items: [sampleParserItem] } }));
    expect(result).toHaveLength(1);
  });

  it("parses tool_calls function.arguments string envelope", () => {
    const result = parseSelfCorrectionLLMResponse(
      JSON.stringify({
        tool_calls: [
          {
            type: "function",
            function: {
              name: "self_correction_result",
              arguments: JSON.stringify({ items: [sampleParserItem] }),
            },
          },
        ],
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("parses M3 tool_calls envelope with stringified argument payloads", () => {
    const result = parseSelfCorrectionLLMResponse(
      JSON.stringify({
        tool_calls: [JSON.stringify({ items: [sampleParserItem] })],
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("returns empty array for { items: [] } (semantic zero, not parse failure)", () => {
    const result = parseSelfCorrectionLLMResponse(JSON.stringify({ items: [] }));
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });

  it("returns null when M3 envelope items fail remediation validation", () => {
    const result = parseSelfCorrectionLLMResponse(
      JSON.stringify({ items: [{ id: 1, note: "not a remediation item" }] }),
    );
    expect(result).toBeNull();
  });
});

describe("#1876 — CLI M3 integration and semantic outcomes", () => {
  it("accepts native tool_calls with empty content and nested items payload", async () => {
    const ctx = makeCtx(makeOpenAINativeToolCallsMock(JSON.stringify({ items: [SAMPLE_REMEDIATION] })));
    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });
    expect(res.status).toBe("success_analyzed");
    expect(res.analysed).toBe(1);
  });

  it("accepts M3-style nested arguments payload in message content", async () => {
    const ctx = makeCtx(makeOpenAIMock(JSON.stringify({ arguments: { items: [SAMPLE_REMEDIATION] } })));
    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });
    expect(res.status).toBe("success_analyzed");
    expect(res.analysed).toBe(1);
  });

  it("analyses multiple incidents from a single M3 { items: [...] } batch response", async () => {
    const incident2: CorrectionIncident = {
      ...SAMPLE_INCIDENT,
      userMessage: "Second correction signal",
      sessionFile: "2026-01-02-session.jsonl",
    };
    const items = [
      { ...SAMPLE_REMEDIATION, incidentIndex: 0 },
      { ...SAMPLE_REMEDIATION, incidentIndex: 1, remediationContent: { text: "Second fix", entity: "Fact", tags: [] } },
    ];
    const ctx = makeCtx(makeOpenAINativeToolCallsMock(JSON.stringify({ items })));
    (ctx.cfg as any).selfCorrection = { ...(ctx.cfg as any).selfCorrection, analysisBatchSize: 2 };

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT, incident2],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("success_analyzed");
    expect(res.analysed).toBe(2);
  });

  it("returns failed_parse when LLM output is unparseable with incidents present", async () => {
    const ctx = makeCtx(makeOpenAIMock("plain prose with no JSON array"));
    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });
    expect(res.status).toBe("failed_parse");
    expect(res.analysed).toBe(0);
    expect(res.error).toMatch(/could not be parsed/i);
  });

  it("returns failed_suspect_zero_parsed when resume skips all batches with empty analysed", async () => {
    const incidents = [
      SAMPLE_INCIDENT,
      { ...SAMPLE_INCIDENT, userMessage: "Second incident", sessionFile: "2026-01-02-session.jsonl" },
    ];
    const openaiFirst = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            })
            .mockRejectedValueOnce(new Error("permanent failure after first batch")),
        },
      },
    } as any;
    const ctxFirst = makeCtx(openaiFirst);
    (ctxFirst.cfg as any).selfCorrection = { ...(ctxFirst.cfg as any).selfCorrection, analysisBatchSize: 1 };

    await runSelfCorrectionRunForCli(ctxFirst, {
      incidents,
      workspace: tmpDir,
      applyTools: false,
    });

    const stateFiles = listSelfCorrectionBatchStateFiles(tmpDir);
    expect(stateFiles).toHaveLength(1);
    const statePath = join(resolveSelfCorrectionBatchStateDir(tmpDir), stateFiles[0] as string);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.analysed = [];
    state.completedBatchIndexes = [0, 1];
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const openaiSecond = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
        },
      },
    } as any;

    const ctxSecond = makeCtx(openaiSecond);
    (ctxSecond.cfg as any).selfCorrection = { ...(ctxSecond.cfg as any).selfCorrection, analysisBatchSize: 1 };

    const res = await runSelfCorrectionRunForCli(ctxSecond, {
      incidents,
      workspace: tmpDir,
      applyTools: false,
    });

    expect(res.status).toBe("failed_suspect_zero_parsed");
    expect(res.incidentsFound).toBe(2);
    expect(res.analysed).toBe(0);
    expect(res.error).toMatch(/zero parsed\/analysed remediation items/i);
    expect(openaiSecond.chat.completions.create).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
  });

  it("populates final summary counters on successful MiniMax batch run", async () => {
    const ctx = minimaxCtx(makeOpenAIMock(JSON.stringify([SAMPLE_REMEDIATION])));
    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
      model: "minimax/MiniMax-M3",
    });

    expect(res.status).toBe("success_analyzed");
    expect(res.incidentsFound).toBe(1);
    expect(res.analysed).toBe(1);
    expect(res.batchesStarted).toBe(1);
    expect(res.batchesCompleted).toBe(1);
    expect(res.totalBatches).toBe(1);
    expect(res.retryCount).toBe(0);
    expect(res.fallbackCount).toBe(0);
    expect(res.parseFailures).toBe(0);
    expect(res.unparseableFailures).toBe(0);
  });
});

describe("#1876 — retry/backoff and resume resilience", () => {
  it("retries transient Request was aborted without lowering maxTokens", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(new Error("Request was aborted"))
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }),
        },
      },
    } as any;

    const res = await runSelfCorrectionRunForCli(makeCtx(openai), {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("success_analyzed");
    expect(res.retryCount).toBe(1);
    const callBodies = ((openai.chat.completions.create as any).mock?.calls ?? []).map(
      (args: unknown[]) => args[0] as { max_tokens?: number; max_completion_tokens?: number },
    );
    const tokenBudgets = callBodies.map(
      (body: { max_tokens?: number; max_completion_tokens?: number }) => body.max_tokens ?? body.max_completion_tokens,
    );
    expect(tokenBudgets[0]).toBeDefined();
    expect(tokenBudgets[1]).toBe(tokenBudgets[0]);
  });

  it("retries transient timeout errors with backoff without lowering maxTokens", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(new Error("LLM request timeout after 120000ms"))
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }),
        },
      },
    } as any;

    const res = await runSelfCorrectionRunForCli(makeCtx(openai), {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("success_analyzed");
    expect(res.retryCount).toBe(1);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    const callBodies = ((openai.chat.completions.create as any).mock?.calls ?? []).map(
      (args: unknown[]) => args[0] as { max_tokens?: number; max_completion_tokens?: number },
    );
    const tokenBudgets = callBodies.map(
      (body: { max_tokens?: number; max_completion_tokens?: number }) => body.max_tokens ?? body.max_completion_tokens,
    );
    expect(tokenBudgets[0]).toBeDefined();
    expect(tokenBudgets[1]).toBe(tokenBudgets[0]);
  });

  it("persists resume state and skips completed batches on rerun", async () => {
    const incidents = [
      { ...SAMPLE_INCIDENT, userMessage: `${SAMPLE_INCIDENT.userMessage} #0`, sessionFile: "s-0.jsonl" },
      { ...SAMPLE_INCIDENT, userMessage: `${SAMPLE_INCIDENT.userMessage} #1`, sessionFile: "s-1.jsonl" },
    ];
    const item0 = { ...SAMPLE_REMEDIATION, remediationContent: { text: "first batch" } };
    const item1 = { ...SAMPLE_REMEDIATION, remediationContent: { text: "second batch" } };

    const openaiFirst = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([item0]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            })
            .mockRejectedValueOnce(new Error("permanent failure after first batch")),
        },
      },
    } as any;
    const ctxFirst = makeCtx(openaiFirst);
    (ctxFirst.cfg as any).selfCorrection = { ...(ctxFirst.cfg as any).selfCorrection, analysisBatchSize: 1 };

    const first = await runSelfCorrectionRunForCli(ctxFirst, { incidents, workspace: tmpDir, applyTools: false });
    expect(first.error).toBeDefined();

    const stateFiles = listSelfCorrectionBatchStateFiles(tmpDir);
    expect(stateFiles).toHaveLength(1);
    const statePath = join(resolveSelfCorrectionBatchStateDir(tmpDir), stateFiles[0] as string);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).completedBatchIndexes).toEqual([0]);

    const openaiSecond = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify([item1]) } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
        },
      },
    } as any;

    const ctxSecond = makeCtx(openaiSecond);
    (ctxSecond.cfg as any).selfCorrection = { ...(ctxSecond.cfg as any).selfCorrection, analysisBatchSize: 1 };

    const second = await runSelfCorrectionRunForCli(ctxSecond, {
      incidents,
      workspace: tmpDir,
      applyTools: false,
    });

    expect(second.status).toBe("success_analyzed");
    expect(second.analysed).toBe(2);
    expect(openaiSecond.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(existsSync(statePath)).toBe(false);
  });

  it("does not reuse stale resume state when model fingerprint changes", async () => {
    const incidents = [SAMPLE_INCIDENT, { ...SAMPLE_INCIDENT, userMessage: "Second", sessionFile: "s-2.jsonl" }];
    const failBatch2 = Object.assign(new Error("model not found for batch 2"), { status: 404 });
    const partialOpenai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            })
            .mockRejectedValue(failBatch2),
        },
      },
    } as any;
    const ctxA = makeCtx(partialOpenai);
    (ctxA.cfg as any).selfCorrection = { ...(ctxA.cfg as any).selfCorrection, analysisBatchSize: 1 };

    await runSelfCorrectionRunForCli(ctxA, { incidents, workspace: tmpDir, model: "model-a", applyTools: false });
    expect(listSelfCorrectionBatchStateFiles(tmpDir)).toHaveLength(1);

    const openaiB = makeOpenAIMock(JSON.stringify([SAMPLE_REMEDIATION]));
    const ctxB = makeCtx(openaiB);
    (ctxB.cfg as any).selfCorrection = { ...(ctxB.cfg as any).selfCorrection, analysisBatchSize: 1 };

    await runSelfCorrectionRunForCli(ctxB, { incidents, workspace: tmpDir, model: "model-b", applyTools: false });
    expect(openaiB.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(listSelfCorrectionBatchStateFiles(tmpDir)).toHaveLength(0);
  });

  it("does not write resume state during dry-run", async () => {
    const incidents = Array.from({ length: 26 }, (_, i) => ({
      ...SAMPLE_INCIDENT,
      userMessage: `${SAMPLE_INCIDENT.userMessage} #${i}`,
      sessionFile: `2026-01-01-session-${i}.jsonl`,
    }));
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            })
            .mockRejectedValue(new Error("fail after first batch")),
        },
      },
    } as any;

    await runSelfCorrectionRunForCli(makeCtx(openai), { incidents, workspace: tmpDir, dryRun: true });
    expect(listSelfCorrectionBatchStateFiles(tmpDir)).toHaveLength(0);
  });
});

describe("#1876 — verbose diagnostics and partial failure semantics", () => {
  it("logs batch mode, maxTokens, and parsed_items when verbose is enabled", async () => {
    const ctx = minimaxCtx(makeOpenAIMock(JSON.stringify([SAMPLE_REMEDIATION])));
    await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
      verbose: true,
      model: "minimax/MiniMax-M3",
    });

    const infoLines = ((ctx.logger.info as ReturnType<typeof vi.fn>).mock?.calls ?? []).flat().map(String);
    expect(infoLines.some((line) => /batch mode.*maxTokens=/i.test(line))).toBe(true);
    expect(infoLines.some((line) => /parsed_items=1/.test(line))).toBe(true);
    expect(infoLines.some((line) => /batch 1\/1 start/.test(line))).toBe(true);
  });

  it("returns failed_partial and retains resume state when a later batch fails", async () => {
    const incident2: CorrectionIncident = {
      ...SAMPLE_INCIDENT,
      userMessage: "Second incident",
      sessionFile: "2026-01-02-session.jsonl",
    };
    let callCount = 0;
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
              return {
                choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              };
            }
            throw new Error("simulated batch 2 LLM failure");
          }),
        },
      },
    } as any;
    const ctx = makeCtx(openai);
    (ctx.cfg as any).selfCorrection = { ...(ctx.cfg as any).selfCorrection, analysisBatchSize: 1 };

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT, incident2],
      workspace: tmpDir,
    });

    expect(res.status).toBe("failed_partial");
    expect(res.batchesCompleted).toBe(1);
    expect(res.totalBatches).toBe(2);
    expect(res.analysed).toBeGreaterThan(0);
    expect(listSelfCorrectionBatchStateFiles(tmpDir).length).toBeGreaterThan(0);
  });

  it("records fallback usage when primary model fails and fallback succeeds", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (req: { model?: string }) => {
            if (req?.model === "heavy-primary") throw new Error("simulated failure for heavy-primary");
            if (req?.model === "heavy-fallback-1") {
              return {
                choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              };
            }
            throw new Error(`unexpected model: ${String(req?.model)}`);
          }),
        },
      },
    } as any;
    const ctx = makeCtx(openai, {
      llm: { default: ["default-model"], heavy: ["heavy-primary"] },
    });
    (ctx.cfg as any).distill = { fallbackModels: ["heavy-fallback-1"] };

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("success_analyzed");
    expect(res.fallbackCount).toBeGreaterThanOrEqual(1);
  });

  it("treats valid NO_ACTION items as analysed (not semantic-empty)", async () => {
    const ctx = makeCtx(makeOpenAIMock(JSON.stringify([SAMPLE_NO_ACTION])));
    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });
    expect(res.status).toBe("success_analyzed");
    expect(res.analysed).toBe(1);
  });
});
