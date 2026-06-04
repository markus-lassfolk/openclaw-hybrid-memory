/**
 * Regression tests for issue #1637 — self-correction analysis fails on non-strict LLM JSON
 * and reports cooldown skips as success.
 *
 * Covers:
 *  - Strict JSON array response → parses correctly, status: "success_analyzed"
 *  - Markdown-fenced JSON response → fence stripped, parses correctly
 *  - JSON array with trailing prose → first balanced span used, parses correctly
 *  - Invalid/unparseable LLM response → status: "failed_parse", error message includes excerpt
 *  - Empty content (model returned nothing) → treated as no remediations (no crash)
 *  - Cooldown skip → status: "skipped_cooldown", NOT "success_no_incidents"
 *  - Zero-incident run → status: "success_no_incidents", NOT "skipped_cooldown"
 *  - Parse failure with incidents present does NOT update scan cursor as if analysis succeeded
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runSelfCorrectionRunForCli } from "../cli/cmd-selfcorrection.js";
import type { HandlerContext } from "../cli/handlers.js";
import type { CorrectionIncident } from "../services/self-correction-extract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: FactsDB;

const SAMPLE_INCIDENT: CorrectionIncident = {
  userMessage: "That was wrong — you should have verified first.",
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

function makeOpenAIFailoverMock(primaryModel: string, fallbackModel: string, responseText = JSON.stringify([SAMPLE_REMEDIATION])) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async (req: { model?: string }) => {
          if (req?.model === primaryModel) throw new Error(`simulated failure for ${primaryModel}`);
          if (req?.model === fallbackModel) {
            return {
              choices: [{ message: { content: responseText } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            };
          }
          throw new Error(`unexpected model: ${String(req?.model)}`);
        }),
      },
    },
  } as any;
}

function makeCtx(openai: any): HandlerContext {
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
    proposalsDb: null,
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
      },
      llm: { default: ["test-model"], heavy: ["test-model"], _source: undefined },
      store: { classifyBeforeWrite: false },
      autoRecall: { enabled: false },
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sc-json-parse-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JSON parsing: LLM response variants
// ---------------------------------------------------------------------------

describe("self-correction-run — JSON parsing robustness (#1637)", () => {
  it("parses a strict JSON array response", async () => {
    const llmContent = JSON.stringify([SAMPLE_REMEDIATION]);
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("parses a markdown-fenced JSON response", async () => {
    const llmContent = `\`\`\`json\n${JSON.stringify([SAMPLE_REMEDIATION])}\n\`\`\``;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("parses a JSON array followed by trailing prose", async () => {
    const llmContent = `${JSON.stringify([SAMPLE_REMEDIATION])}\n\nHope that helps! See [1] for reference.`;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("parses a JSON array preceded by introductory prose", async () => {
    const llmContent = `Here is my analysis:\n${JSON.stringify([SAMPLE_REMEDIATION])}`;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("parses array after a <thinking> block (MiniMax M2.7-highspeed, #1718)", async () => {
    const thinkingBlock = `<thinking>\nLet me analyze these incidents carefully.\nStep 1: review patterns.\n</thinking>`;
    const llmContent = `${thinkingBlock}\n${JSON.stringify([SAMPLE_REMEDIATION])}`;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("parses array after a <redacted_thinking> block (#1718)", async () => {
    const thinkingBlock = `<redacted_thinking>redacted reasoning content</redacted_thinking>`;
    const llmContent = `${thinkingBlock}\n${JSON.stringify([SAMPLE_REMEDIATION])}`;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("parses array after a <reasoning> block (#1718)", async () => {
    const thinkingBlock = `<reasoning>\nAnalyzing incident context...\n</reasoning>`;
    const llmContent = `${thinkingBlock}\n${JSON.stringify([SAMPLE_REMEDIATION])}`;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("parses fenced JSON after a thinking block (#1718)", async () => {
    const thinkingBlock = `<thinking>reasoning here</thinking>`;
    const fencedJson = `\`\`\`json\n${JSON.stringify([SAMPLE_REMEDIATION])}\n\`\`\``;
    const llmContent = `${thinkingBlock}\n${fencedJson}`;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.analysed).toBe(1);
    expect(res.status).toBe("success_analyzed");
  });

  it("returns failed_parse when response contains only a thinking block with no JSON (#1718)", async () => {
    const llmContent = `<thinking>\nI cannot determine the right remediation without more context.\n</thinking>`;
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("failed_parse");
    expect(res.error).toBeDefined();
    expect(res.analysed).toBe(0);
  });

  it("returns failed_parse when the LLM response cannot be parsed as a JSON array", async () => {
    const llmContent = "I cannot analyse these incidents due to missing context.";
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("failed_parse");
    expect(res.error).toBeDefined();
    expect(res.analysed).toBe(0);
    expect(res.autoFixed).toBe(0);
  });

  it("attempts a repair pass when initial JSON parsing fails", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: "This is not valid JSON output." } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            })
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([SAMPLE_REMEDIATION]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }),
        },
      },
    } as any;
    const ctx = makeCtx(openai);

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe("success_analyzed");
    expect(res.analysed).toBe(1);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("includes a sanitized response excerpt in the error message", async () => {
    const llmContent = "No JSON here, just plain text with 123 numbers and some [brackets].";
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("failed_parse");
    expect(res.error).toMatch(/excerpt=/);
  });



  it("accepts MiniMax M3-style nested arguments payload without losing analysed items", async () => {
    const llmContent = JSON.stringify({ arguments: { items: [SAMPLE_REMEDIATION] } });
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe("success_analyzed");
    expect(res.analysed).toBe(1);
  });

  it("accepts MiniMax M3-style tool_calls function.arguments payload", async () => {
    const llmContent = JSON.stringify({
      tool_calls: [
        {
          type: "function",
          function: {
            name: "self_correction_result",
            arguments: JSON.stringify({ items: [SAMPLE_REMEDIATION] }),
          },
        },
      ],
    });
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe("success_analyzed");
    expect(res.analysed).toBe(1);
  });

  it("marks a zero-parsed result with incidents as suspect instead of clean success", async () => {
    const ctx = makeCtx(makeOpenAIMock(""));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.analysed).toBe(0);
    expect(res.status).toBe("failed_suspect_zero_parsed");
    expect(res.error).toMatch(/zero parsed\/analysed/i);
  });



  it("retries transient Request was aborted failures with backoff without lowering maxTokens", async () => {
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
    const ctx = makeCtx(openai);

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.status).toBe("success_analyzed");
    expect(res.retryCount).toBe(1);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    const callBodies = ((openai.chat.completions.create as any).mock?.calls ?? []).map((args: unknown[]) =>
      args[0] as { max_tokens?: number; max_completion_tokens?: number },
    );
    const tokenBudgets = callBodies.map(
      (body: { max_tokens?: number; max_completion_tokens?: number }) => body.max_tokens ?? body.max_completion_tokens,
    );
    expect(tokenBudgets[0]).toBeDefined();
    expect(tokenBudgets[1]).toBe(tokenBudgets[0]);
  });

  it("persists batch resume state and skips completed batches on rerun", async () => {
    const manyIncidents = Array.from({ length: 26 }, (_, i) => ({
      ...SAMPLE_INCIDENT,
      userMessage: `${SAMPLE_INCIDENT.userMessage} #${i}`,
      sessionFile: `2026-01-01-session-${i}.jsonl`,
    }));
    const firstBatchItem = { ...SAMPLE_REMEDIATION, remediationContent: { text: "first batch" } };
    const secondBatchItem = { ...SAMPLE_REMEDIATION, remediationContent: { text: "second batch" } };
    const openaiFirst = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify([firstBatchItem]) } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            })
            .mockRejectedValueOnce(new Error("permanent failure after first batch")),
        },
      },
    } as any;
    const first = await runSelfCorrectionRunForCli(makeCtx(openaiFirst), {
      incidents: manyIncidents,
      workspace: tmpDir,
      dryRun: true,
    });
    expect(first.error).toBeDefined();
    const reportsDir = join(tmpDir, "memory", "reports");
    const stateFile = (await import("node:fs")).readdirSync(reportsDir).find((name) =>
      name.startsWith("self-correction-run-state-"),
    );
    expect(stateFile).toBeDefined();
    const statePath = join(reportsDir, stateFile as string);
    expect(existsSync(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).completedBatchIndexes).toEqual([0]);

    const openaiSecond = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify([secondBatchItem]) } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
        },
      },
    } as any;
    const second = await runSelfCorrectionRunForCli(makeCtx(openaiSecond), {
      incidents: manyIncidents,
      workspace: tmpDir,
      dryRun: true,
    });

    expect(second.status).toBe("success_analyzed");
    expect(second.analysed).toBe(2);
    expect(openaiSecond.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).completedBatchIndexes).toEqual([0, 1]);
  });

  it("#1715: uses heavy-tier fallback chain when llm.heavy has a single model", async () => {
    const openai = makeOpenAIFailoverMock("heavy-primary", "heavy-fallback-1");
    const ctx = makeCtx(openai);
    (ctx.cfg as any).llm = {
      default: ["default-model"],
      heavy: ["heavy-primary"],
    };
    (ctx.cfg as any).distill = {
      fallbackModels: ["heavy-fallback-1", "heavy-fallback-2"],
    };

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe("success_analyzed");
    const modelCalls = ((openai.chat.completions.create as any).mock?.calls ?? []).map((args: unknown[]) =>
      String((args?.[0] as { model?: string })?.model),
    );
    expect(modelCalls).toContain("heavy-primary");
    expect(modelCalls).toContain("heavy-fallback-1");
    const infoCalls = ((ctx.logger.info as any).mock?.calls ?? []).flat();
    expect(
      infoCalls.some((line: unknown) => String(line).includes("fallback chain = [heavy-fallback-1, heavy-fallback-2]")),
    ).toBe(true);
  });

  it("uses configured fallback chain when model is overridden via --model", async () => {
    const openai = makeOpenAIFailoverMock("custom-model", "heavy-primary");
    const ctx = makeCtx(openai);
    (ctx.cfg as any).llm = {
      default: ["default-model"],
      heavy: ["heavy-primary"],
    };
    (ctx.cfg as any).distill = {
      fallbackModels: ["heavy-fallback-1", "heavy-fallback-2"],
    };

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: true,
      model: "custom-model",
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe("success_analyzed");
    const modelCalls = ((openai.chat.completions.create as any).mock?.calls ?? []).map((args: unknown[]) =>
      String((args?.[0] as { model?: string })?.model),
    );
    expect(modelCalls).toContain("custom-model");
    expect(modelCalls).toContain("heavy-primary");
    const infoCalls = ((ctx.logger.info as any).mock?.calls ?? []).flat();
    expect(
      infoCalls.some((line: unknown) =>
        String(line).includes("fallback chain = [heavy-primary, heavy-fallback-1, heavy-fallback-2]"),
      ),
    ).toBe(true);
  });

  it("parse failure with incidents does not update scan cursor as if analysis succeeded", async () => {
    const llmContent = "This is not JSON.";
    const ctx = makeCtx(makeOpenAIMock(llmContent));

    // Confirm no cursor before run
    expect(factsDb.getScanCursor("self-correction-run")).toBeNull();

    // Pass incidents explicitly; cursor updates are disabled by design for explicit runs (line 557 guard).
    // This test verifies parse failure returns early and doesn't reach cursor update logic.
    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
    });

    // Parse failure should return status: "failed_parse" (not update cursor via success path)
    expect(res.status).toBe("failed_parse");
    const cursor = factsDb.getScanCursor("self-correction-run");
    expect(cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status semantics: skipped_cooldown vs success_no_incidents
// ---------------------------------------------------------------------------

describe("self-correction-run — cooldown skip vs zero-incident status (#1637)", () => {
  it("returns status=skipped_cooldown when 23h cooldown fires", async () => {
    const ctx = makeCtx(makeOpenAIMock("[]"));

    // Mark this scan as recently run; updateScanCursor records last_run_at as Date.now().
    factsDb.updateScanCursor("self-correction-run", 0, 0);

    const res = await runSelfCorrectionRunForCli(ctx, {
      workspace: tmpDir,
      // No --full, no incidents/extractPath → cooldown guard is active
    });

    expect(res.skipped).toBe(true);
    expect(res.status).toBe("skipped_cooldown");
    // Must NOT look like a real zero-incident analysis
    expect(res.status).not.toBe("success_no_incidents");
    expect(res.incidentsFound).toBe(0);
  });

  it("returns status=success_no_incidents when scan ran but found zero incidents", async () => {
    const ctx = makeCtx(makeOpenAIMock("[]"));

    // Pass incidents directly to bypass the extract step and cooldown guard
    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [],
      workspace: tmpDir,
    });

    expect(res.skipped).toBeFalsy();
    expect(res.status).toBe("success_no_incidents");
    expect(res.incidentsFound).toBe(0);
  });

  it("skipped_cooldown and success_no_incidents are distinguishable", async () => {
    const ctx = makeCtx(makeOpenAIMock("[]"));

    // Cooldown path: mark this scan as recently run.
    factsDb.updateScanCursor("self-correction-run", 0, 0);
    const skippedRes = await runSelfCorrectionRunForCli(ctx, { workspace: tmpDir });

    // Zero-incident path (forced --full with no actual incidents)
    const noIncidentsRes = await runSelfCorrectionRunForCli(ctx, {
      incidents: [],
      workspace: tmpDir,
    });

    expect(skippedRes.status).toBe("skipped_cooldown");
    expect(noIncidentsRes.status).toBe("success_no_incidents");
    expect(skippedRes.status).not.toBe(noIncidentsRes.status);
  });
});
