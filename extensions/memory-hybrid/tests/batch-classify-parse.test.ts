import { describe, expect, it } from "vitest";
import { parseBatchClassifyResponseContent } from "../services/classification.js";

describe("parseBatchClassifyResponseContent (#1007)", () => {
  const row = { action: "ADD", targetId: null, reason: "ok" };

  it("parses a bare JSON array", () => {
    const raw = JSON.stringify([row]);
    expect(parseBatchClassifyResponseContent(raw)).toEqual([row]);
  });

  it("parses array inside a markdown json fence", () => {
    const inner = JSON.stringify([row, row]);
    const raw = `Here you go:\n\`\`\`json\n${inner}\n\`\`\`\n`;
    expect(parseBatchClassifyResponseContent(raw)).toEqual([row, row]);
  });

  it("parses array after redacted_thinking blocks", () => {
    const inner = JSON.stringify([row]);
    const raw = `<redacted_thinking>step 1</redacted_thinking>\n${inner}`;
    expect(parseBatchClassifyResponseContent(raw)).toEqual([row]);
  });

  it("parses array when prose precedes the opening bracket", () => {
    const inner = JSON.stringify([row, row]);
    const raw = `Sure! The classifications are:\n${inner}\nHope this helps.`;
    expect(parseBatchClassifyResponseContent(raw)).toEqual([row, row]);
  });

  it("parses wrapped object with classifications key", () => {
    const inner = [row, row];
    const raw = JSON.stringify({ classifications: inner });
    expect(parseBatchClassifyResponseContent(raw)).toEqual(inner);
  });

  it("parses array when a string value contains bracket characters", () => {
    const inner = [{ action: "NOOP", targetId: null, reason: "see [note] and ] end" }];
    const raw = JSON.stringify(inner);
    expect(parseBatchClassifyResponseContent(raw)).toEqual(inner);
  });

  it("skips a citation-like bracket preamble and parses the real array (Copilot PR#1006)", () => {
    const inner = JSON.stringify([row, row]);
    const raw = `See [1] and [2] for details.\n${inner}`;
    expect(parseBatchClassifyResponseContent(raw)).toEqual([row, row]);
  });

  it("skips invalid JSON bracket snippets before the real array", () => {
    const inner = JSON.stringify([row]);
    const raw = `Note: see [note] in the manual.\n${inner}`;
    expect(parseBatchClassifyResponseContent(raw)).toEqual([row]);
  });

  it("throws when no array can be recovered", () => {
    expect(() => parseBatchClassifyResponseContent("just prose")).toThrow(/no JSON array/);
  });

  it("parses lenient array when one row is missing action", () => {
    const raw = JSON.stringify([
      { action: "NOOP", targetId: null, reason: "ok" },
      { targetId: null, reason: "model forgot action" },
    ]);
    const out = parseBatchClassifyResponseContent(`Here:\n${raw}`) as Array<Record<string, unknown>>;
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("parses wrapper object with 'answers' key", () => {
    const inner = [{ action: "ADD", targetId: null, reason: "x" }];
    const raw = JSON.stringify({ answers: inner });
    expect(parseBatchClassifyResponseContent(raw)).toEqual(inner);
  });

  it("parses wrapper object with 'operations' key", () => {
    const inner = [{ action: "NOOP", targetId: null, reason: "ok" }];
    const raw = JSON.stringify({ operations: inner });
    expect(parseBatchClassifyResponseContent(raw)).toEqual(inner);
  });

  it("parses wrapper object with 'classifyResults' key", () => {
    const inner = [{ action: "ADD", targetId: null, reason: "r" }];
    const raw = JSON.stringify({ classifyResults: inner });
    expect(parseBatchClassifyResponseContent(raw)).toEqual(inner);
  });

  it("strips <reasoning> blocks before parsing", () => {
    const inner = JSON.stringify([{ action: "NOOP", targetId: null, reason: "ok" }]);
    const raw = `<reasoning>Think about it</reasoning>\n${inner}`;
    expect(parseBatchClassifyResponseContent(raw)).toEqual([{ action: "NOOP", targetId: null, reason: "ok" }]);
  });

  it("rejects lenient array where less than half have action", () => {
    const raw = JSON.stringify([
      { targetId: null, reason: "no action" },
      { targetId: null, reason: "also no action" },
      { action: "ADD", targetId: null, reason: "only one" },
    ]);
    expect(() => parseBatchClassifyResponseContent(`${raw}`)).toThrow(/no JSON array/);
  });
});
