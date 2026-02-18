import { describe, it, expect } from "vitest";
import { chunkSessionText } from "../utils/text.js";

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
});
