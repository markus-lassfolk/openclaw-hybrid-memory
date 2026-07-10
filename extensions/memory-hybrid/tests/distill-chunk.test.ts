import { describe, expect, it } from "vitest";
import { distillBatchTokenLimit } from "../services/chat.js";
import { chunkSessionText, chunkTextByChars } from "../utils/text.js";

describe("chunkSessionText", () => {
  it("returns single-element array when text fits in maxTokens", () => {
    const text = "short session";
    const result = chunkSessionText(text, 5000);
    expect(result).toEqual([text]);
  });

  it("returns single-element array for empty string", () => {
    const result = chunkSessionText("", 100);
    expect(result).toEqual([""]);
  });

  it("chunks text when it exceeds maxTokens (maxTokens * 4 chars)", () => {
    // maxTokens=5 -> maxChars=20
    const text = "a".repeat(50);
    const result = chunkSessionText(text, 5, 0.1);
    expect(result.length).toBeGreaterThan(1);
  });

  it("creates overlapping chunks (10% overlap by default)", () => {
    // maxTokens=10 -> maxChars=40, overlap=4
    const text = "x".repeat(100);
    const chunks = chunkSessionText(text, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk starts at 0, last chunk ends at text.length — no content dropped
    expect(chunks[0][0]).toBe("x");
    expect(chunks[chunks.length - 1].slice(-1)).toBe("x");
  });

  it("uses custom overlap ratio", () => {
    const text = "y".repeat(100);
    const chunks10 = chunkSessionText(text, 10, 0.1);
    const chunks15 = chunkSessionText(text, 10, 0.15);
    expect(chunks10.length).toBeGreaterThanOrEqual(2);
    expect(chunks15.length).toBeGreaterThanOrEqual(2);
    // Higher overlap -> more chunks (smaller step forward per chunk)
    expect(chunks15.length).toBeGreaterThanOrEqual(chunks10.length);
  });

  it("never drops content — first char in first chunk, last char in last chunk", () => {
    const text = "Hello world";
    const chunks = chunkSessionText(text, 2);
    expect(chunks[0][0]).toBe("H");
    expect(chunks[chunks.length - 1].slice(-1)).toBe("d");
  });

  it("covers full text for large inputs (no truncation)", () => {
    const text = "z".repeat(300);
    const chunks = chunkSessionText(text, 25);
    const firstChar = text[0];
    const lastChar = text[text.length - 1];
    expect(chunks[0].startsWith(firstChar)).toBe(true);
    expect(chunks[chunks.length - 1].endsWith(lastChar)).toBe(true);
  });

  it("each chunk except possibly last is at most maxTokens*4 chars", () => {
    const text = "z".repeat(500);
    const maxTokens = 25;
    const maxChars = maxTokens * 4;
    const chunks = chunkSessionText(text, maxTokens);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("terminates instead of looping forever when maxTokens is zero or negative (regression)", () => {
    const text = "a".repeat(100);
    for (const maxTokens of [0, -1, -100]) {
      const chunks = withIterationGuard(() => chunkSessionText(text, maxTokens));
      // Content must still be fully covered, never dropped.
      expect(chunks.join("").includes("a")).toBe(true);
      expect(chunks[0][0]).toBe("a");
      expect(chunks[chunks.length - 1].slice(-1)).toBe("a");
    }
  });
});

/**
 * Runs `fn` on a Proxy'd Array.prototype.push-instrumented call and throws if the underlying
 * chunking loop pushes more than a sane bound of chunks -- turns a would-be infinite loop into a
 * fast, deterministic test failure instead of hanging the whole suite.
 */
function withIterationGuard<T>(fn: () => T[]): T[] {
  const originalPush = Array.prototype.push;
  let pushCount = 0;
  // biome-ignore lint/suspicious/noExplicitAny: instrumenting the built-in for a bounded-loop test guard
  (Array.prototype as any).push = function guardedPush(...args: unknown[]) {
    pushCount++;
    if (pushCount > 10_000) {
      Array.prototype.push = originalPush;
      throw new Error("chunking loop exceeded 10,000 iterations -- likely non-terminating");
    }
    return originalPush.apply(this, args as never[]);
  };
  try {
    return fn();
  } finally {
    Array.prototype.push = originalPush;
  }
}

describe("chunkTextByChars", () => {
  it("returns single chunk when text fits", () => {
    const text = "short";
    expect(chunkTextByChars(text, 100, 10)).toEqual([text]);
  });

  it("chunks with overlap", () => {
    const text = "a".repeat(200);
    const chunks = chunkTextByChars(text, 80, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBe(80);
    expect(chunks[0][0]).toBe("a");
    expect(chunks[chunks.length - 1].slice(-1)).toBe("a");
  });

  it("covers full text (first and last char in chunks)", () => {
    const text = "abcdefgh";
    const chunks = chunkTextByChars(text, 4, 2);
    expect(chunks[0][0]).toBe("a");
    expect(chunks[chunks.length - 1].slice(-1)).toBe("h");
  });
});

// Test for Issue #97 fixes: conservative token limits to handle fallback models
describe("distillBatchTokenLimit", () => {
  it("uses conservative 400k limit for long-context models (down from 500k)", () => {
    // Gemini should be treated as long-context
    const geminiLimit = distillBatchTokenLimit("gemini-3-pro-preview");
    expect(geminiLimit).toBe(400_000);

    const geminiLimit2 = distillBatchTokenLimit("google/gemini-3.1-pro-preview");
    expect(geminiLimit2).toBe(400_000);
  });

  it("uses catalog limits for Claude and o-series (long context), 80k for standard models", () => {
    // Claude Opus 4-6 has 1M context → 400k batch (from model-capabilities)
    const claudeLimit = distillBatchTokenLimit("anthropic/claude-opus-4-6");
    expect(claudeLimit).toBe(400_000);

    // o3 has 200k context → 200k batch
    const openaiLimit = distillBatchTokenLimit("openai/o3");
    expect(openaiLimit).toBe(200_000);

    const gptLimit = distillBatchTokenLimit("gpt-4o-mini");
    expect(gptLimit).toBe(80_000);
  });
});
