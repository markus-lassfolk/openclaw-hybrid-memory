/**
 * Regression tests for issue #2006 — auto-classify on MiniMax-M2.7-highspeed.
 *
 * Symptoms observed in production:
 *   1. classifyBatch returns success=false because the response is truncated
 *      thinking prose (`<redacted_thinking>…` with no closing tag) and no JSON payload.
 *   2. The error surfaces as `batchFailures=1, reclassified=0/20, semantic=partial`.
 *   3. Even after adding `thinkingMode: "disabled"`, MiniMax M2.7-highspeed still
 *      emits ~2KB of thinking prose before truncation.
 *
 * Fix acceptance:
 *   1. classifyBatch must pass `thinkingMode: "disabled"` for MiniMax models.
 *   2. classifyBatch must use a larger output budget (`Math.min(800, 80 * facts.length)`).
 *   3. classifyBatch must retry once on parse failure with a higher budget.
 *   4. After retry, if the model STILL emits only thinking prose, the batch must
 *      surface as failure (success=false), not silently succeed.
 *   5. Stripping of unclosed `<redacted_thinking>` / `<thinking>` / `<reasoning>` /
 *      `<redacted_thinking>` suffixes must work even when there is no closing tag.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { runAutoClassify } from "../services/auto-classifier.js";

const { FactsDB } = _testing;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-thinking-retry-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFactsDb(dir: string, otherCount: number): InstanceType<typeof FactsDB> {
  const db = new FactsDB(join(dir, "facts.db"));
  for (let i = 0; i < otherCount; i++) {
    db.store({
      text: `other fact ${i}: short fact about subject ${i}`,
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
  }
  return db;
}

const noop = { info: () => {}, warn: () => {} };

/**
 * Mock that returns thinking-only content on the first attempt (truncated,
 * no JSON) and a valid JSON array on the retry. Asserts the retry happens
 * with a HIGHER maxTokens than the first call.
 */
function mockThinkingThenJson({
  firstResponse,
  secondResponse,
  requestLog,
}: {
  firstResponse: string;
  secondResponse: string;
  requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }>;
}): unknown {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(
          async (req: {
            max_tokens?: number;
            max_completion_tokens?: number;
            thinking?: { type?: string };
            model?: string;
          }) => {
            const effMax = req.max_tokens ?? req.max_completion_tokens;
            requestLog.push({ maxTokens: effMax, thinking: req.thinking, model: req.model });
            const content = callIndex === 0 ? firstResponse : secondResponse;
            callIndex++;
            return {
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
            };
          },
        ),
      },
    },
  };
}

describe("auto-classify MiniMax thinking-only retry (#2006)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    factsDb?.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("passes thinkingMode=disabled for MiniMax models on the first attempt", async () => {
    factsDb = makeFactsDb(tmpDir, 3);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse: "<redacted_thinking>truncated mid-reasoning with no closing tag and definitely no JSON",
      secondResponse: '["fact", "entity", "preference"]',
      requestLog,
    });

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    // The very first classify call must include thinking=disabled for MiniMax models.
    const firstCall = requestLog[0];
    expect(firstCall).toBeDefined();
    expect(firstCall.model).toBe("minimax/MiniMax-M2.7-highspeed");
    expect(firstCall.thinking).toEqual({ type: "disabled" });
  });

  it("does NOT pass thinkingMode for non-MiniMax models", async () => {
    factsDb = makeFactsDb(tmpDir, 2);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse: '["fact", "entity"]',
      secondResponse: '["fact", "entity"]',
      requestLog,
    });

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "google/gemini-2.0-flash", batchSize: 20 },
      noop,
    );

    expect(requestLog[0].thinking).toBeUndefined();
  });

  it("uses Math.min(800, 80 * facts.length) output budget (parity with classifyMemoryOperationsBatch)", async () => {
    // 10 facts → 80 * 10 = 800 (capped at 800).
    factsDb = makeFactsDb(tmpDir, 10);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse:
        '<redacted_thinking>truncated no JSON</redacted_thinking>["fact", "entity", "preference", "fact", "entity", "preference", "fact", "entity", "preference", "fact"]',
      secondResponse:
        '["fact", "entity", "preference", "fact", "entity", "preference", "fact", "entity", "preference", "fact"]',
      requestLog,
    });

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    // First call: budget = min(800, 80 * 10) = 800
    expect(requestLog[0].maxTokens).toBe(800);
  });

  it("retries once with HIGHER maxTokens when first response has no JSON", async () => {
    factsDb = makeFactsDb(tmpDir, 10);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse: "<redacted_thinking>truncated mid-reasoning no JSON here at all",
      secondResponse: '["fact","entity","preference","fact","entity","preference","fact","entity","preference","fact"]',
      requestLog,
    });

    const result = await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    // Two calls: original + retry
    expect(requestLog.length).toBe(2);
    // Retry uses a larger budget than the first call (up to 4x original, capped at 1600)
    expect(requestLog[1].maxTokens!).toBeGreaterThan(requestLog[0].maxTokens!);
    // The retry kept thinkingMode=disabled
    expect(requestLog[1].thinking).toEqual({ type: "disabled" });
    // Successful reclassification means batchFailures is undefined and reclassified = 10
    expect(result.batchFailures).toBeUndefined();
    expect(result.reclassified).toBe(10);
  });

  it("returns batchFailures=1 when even the retry produces no parseable JSON", async () => {
    factsDb = makeFactsDb(tmpDir, 5);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    // Both attempts return pure thinking prose — model is broken for JSON.
    // classifyBatch must surface this as success=false → batchFailures=1, NOT silently count.
    const openai = mockThinkingThenJson({
      firstResponse:
        "<redacted_thinking>Let me analyze each fact and determine the appropriate category:\n" +
        '1. "Some fact" → fact\n' +
        '2. "Another" → entity\n' +
        "...no JSON array ever emitted, just prose that gets truncated",
      secondResponse:
        "<redacted_thinking>retry also produced nothing but reasoning:\n1. fact\n2. entity\n3. preference\n" +
        "(still truncated mid-reasoning, no closing tag, no JSON)",
      requestLog,
    });

    const result = await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    // Both attempts failed → success=false → batchFailures=1
    expect(requestLog.length).toBe(2);
    expect(result.batchFailures).toBe(1);
    expect(result.reclassified).toBe(0);
    // facts remain in "other"
    const others = factsDb.getByCategory("other");
    expect(others.length).toBe(5);
  });

  it("does NOT retry when the first response has JSON after truncated thinking", async () => {
    factsDb = makeFactsDb(tmpDir, 3);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse: '<redacted_thinking>truncated reasoning\n["fact", "entity", "preference"]',
      secondResponse: '["would-be","retry","never-used"]',
      requestLog,
    });

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    expect(requestLog.length).toBe(1);
  });

  it("does NOT retry when the first response parses successfully", async () => {
    factsDb = makeFactsDb(tmpDir, 3);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse: '<redacted_thinking>thinking</redacted_thinking>["fact", "entity", "preference"]',
      secondResponse: '["would-be","retry","never-used"]',
      requestLog,
    });

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    // No retry — first call already returned valid JSON.
    expect(requestLog.length).toBe(1);
  });

  it("retry succeeds when thinking wrapper is closed and a valid JSON array follows", async () => {
    // First call: unclosed <redacted_thinking> block (truncated mid-reasoning). Parser sees
    // empty string → fail. Retry: closed block + valid JSON → success.
    factsDb = makeFactsDb(tmpDir, 4);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse: "<redacted_thinking>truncated mid-reasoning",
      secondResponse: '<redacted_thinking>reasoning</redacted_thinking>["fact","entity","preference","fact"]',
      requestLog,
    });

    const result = await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    expect(result.batchFailures).toBeUndefined();
    expect(result.reclassified).toBe(4);
  });

  it("retry still uses thinkingMode=disabled for MiniMax", async () => {
    factsDb = makeFactsDb(tmpDir, 3);
    const requestLog: Array<{ maxTokens?: number; thinking?: { type?: string }; model?: string }> = [];

    const openai = mockThinkingThenJson({
      firstResponse: "<redacted_thinking>truncated, no JSON</redacted_thinking>nothing useful",
      secondResponse: '["fact", "entity", "preference"]',
      requestLog,
    });

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "minimax/MiniMax-M3", batchSize: 20 },
      noop,
    );

    // MiniMax M3 also gets thinkingMode=disabled for batch classify (any MiniMax model).
    expect(requestLog[0].thinking).toEqual({ type: "disabled" });
    expect(requestLog[1].thinking).toEqual({ type: "disabled" });
  });

  it("transport failure is NOT silently counted as success", async () => {
    // Simulate a transport error (model unreachable) — classifyBatch must
    // return success=false so the orchestrator reports batchFailures=1.
    factsDb = makeFactsDb(tmpDir, 5);

    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new Error("ECONNREFUSED 127.0.0.1:443");
          }),
        },
      },
    };

    const result = await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOpenai as any,
      { model: "minimax/MiniMax-M2.7-highspeed", batchSize: 20 },
      noop,
    );

    expect(result.batchFailures).toBe(1);
    expect(result.reclassified).toBe(0);
  });
});
