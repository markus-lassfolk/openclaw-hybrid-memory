import { describe, expect, it } from "vitest";
import {
  extractBalancedArraySlice,
  extractFirstJsonArraySubstring,
  parseStructuredItems,
  parseStructuredItemsAcceptingEmpty,
  stripBracketContextPreamble,
  stripMarkdownCodeFence,
  stripThinkingWrapperBlocks,
  tryParseFirstJsonArray,
  tryParseFirstJsonObject,
} from "../utils/llm-json-array.js";

describe("stripMarkdownCodeFence", () => {
  it("returns inner content for json fence", () => {
    expect(stripMarkdownCodeFence('```json\n["a"]\n```')).toBe('["a"]');
  });

  it("returns trimmed raw when no fence", () => {
    expect(stripMarkdownCodeFence('  ["x"]  ')).toBe('["x"]');
  });
});

// Issue #2006: MiniMax M2.7-highspeed emits a `<think>` reasoning block before
// the JSON payload and frequently truncates before the closing tag, so the
// JSON disappears along with the half-finished reasoning. `stripThinkingWrapperBlocks`
// must handle both well-formed AND unclosed/truncated thinking blocks.
describe("stripThinkingWrapperBlocks (#2006)", () => {
  it("strips well-formed <think>...</think> blocks before JSON", () => {
    const raw = '<think>let me think</think>\n["fact","entity"]';
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact","entity"]');
  });

  it("strips well-formed <thinking>...</thinking> blocks before JSON", () => {
    const raw = '<thinking>analysis</thinking>\n["fact"]';
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact"]');
  });

  it("strips <redacted_thinking> blocks", () => {
    const raw = '<redacted_thinking>redacted</redacted_thinking>\n["fact"]';
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact"]');
  });

  it("strips <reasoning> blocks", () => {
    const raw = '<reasoning>r</reasoning>\n["fact"]';
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact"]');
  });

  // --- Unclosed / truncated tags (the #2006 regression) ---

  it("strips unclosed <think>... suffix when response is truncated", () => {
    const raw = '<think>Let me analyze each fact and determine the appropriate category:\n\n1. "Need to revert" ...';
    expect(stripThinkingWrapperBlocks(raw)).toBe("");
  });

  it("preserves JSON that appears before an unclosed <think> block", () => {
    const raw =
      '<think>should not appear</think>["fact", "entity"]\n<think>truncated mid-reasoning with no closing tag at all';
    // The first <think> is closed → dropped. The second is unclosed → dropped too,
    // and its trailing prose disappears with it. We only expect the JSON that
    // appears BEFORE the second (unclosed) opening tag to survive — in this case
    // there is none, so the empty trimmed result is correct.
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact", "entity"]');
  });

  it("preserves JSON that appears before an unclosed <thinking> block", () => {
    const raw = '["fact", "entity"]\n<thinking>now reasoning that never finishes';
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact", "entity"]');
  });

  it("preserves JSON that appears before an unclosed <reasoning> block", () => {
    const raw = '["fact"]\n<reasoning>partial reasoning, no close';
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact"]');
  });

  it("strips unclosed <redacted_thinking> suffix", () => {
    const raw = "<redacted_thinking>truncated redaction never closes";
    expect(stripThinkingWrapperBlocks(raw)).toBe("");
  });

  it("handles real-world MiniMax truncated output (think + no JSON)", () => {
    // ~2KB of thinking prose, no JSON, truncated mid-reasoning.
    // Regression capture from Maeve #2006: `classifyBatch` returned success=false
    // because tryParseFirstJsonArray(stripThinkingWrapperBlocks(raw)) returned null.
    const raw =
      "<think>Let me analyze each fact and determine the appropriate category:\n" +
      "\n" +
      '1. "Need to revert the auto-formatted routeTree.gen.ts"' +
      "\nCategory: fact\n\n" +
      '2. "Some other fact about config"\nCategory: preference\n\n';
    expect(stripThinkingWrapperBlocks(raw)).toBe("");
    expect(tryParseFirstJsonArray(stripThinkingWrapperBlocks(raw))).toBeNull();
  });

  it("does not mis-strip a well-formed block when an unclosed tag follows", () => {
    const raw = '<think>reasoning</think>["fact"]<think>unfinished';
    // First block closed → stripped. JSON survives. Unclosed block is at the
    // end → dropped along with its prose.
    expect(stripThinkingWrapperBlocks(raw)).toBe('["fact"]');
  });

  it("returns input unchanged when there are no thinking tags", () => {
    expect(stripThinkingWrapperBlocks('["fact","entity"]')).toBe('["fact","entity"]');
  });

  it("returns empty string when response is purely an unclosed <think> block", () => {
    expect(stripThinkingWrapperBlocks("<think>just reasoning, no payload")).toBe("");
  });
});

describe("extractBalancedArraySlice", () => {
  it("returns a nested array in full", () => {
    expect(extractBalancedArraySlice('[["a"]]', 0)).toBe('[["a"]]');
  });
});

describe("extractFirstJsonArraySubstring", () => {
  it("parses a plain array", () => {
    expect(extractFirstJsonArraySubstring('["one", "two"]')).toBe('["one", "two"]');
  });

  it("takes only the first balanced span", () => {
    expect(extractFirstJsonArraySubstring('[x]\n["a"]')).toBe("[x]");
  });

  it("handles brackets inside strings", () => {
    const s = '["a]b", "c"]';
    expect(extractFirstJsonArraySubstring(s)).toBe(s);
  });

  it("extracts from markdown fence", () => {
    expect(extractFirstJsonArraySubstring('```json\n["x"]\n```')).toBe('["x"]');
  });

  it("returns null when there is no array", () => {
    expect(extractFirstJsonArraySubstring("no brackets here")).toBeNull();
  });
});

describe("tryParseFirstJsonArray", () => {
  it("parses a plain array", () => {
    expect(tryParseFirstJsonArray('["one", "two"]')).toEqual(["one", "two"]);
  });

  it("skips an invalid bracket span and uses the next valid JSON array", () => {
    const raw = `[bad]
["alpha", "beta"]`;
    expect(tryParseFirstJsonArray(raw)).toEqual(["alpha", "beta"]);
  });

  it("handles prose with multiple brackets before the real array", () => {
    const raw = `Here [are] my labels: ["x", "y"]`;
    expect(tryParseFirstJsonArray(raw)).toEqual(["x", "y"]);
  });

  it("handles brackets inside strings", () => {
    expect(tryParseFirstJsonArray('["a]b"]')).toEqual(["a]b"]);
  });

  it("returns null for non-array JSON", () => {
    expect(tryParseFirstJsonArray('{"a":1}')).toBeNull();
  });

  it("returns null when nothing parses as array", () => {
    expect(tryParseFirstJsonArray("[oops")).toBeNull();
  });

  // GitHub #1153 / #1154 (GlitchTip): model echoes tool/template placeholders instead of JSON
  it("returns null for [[reply_to_current]] placeholder (no SyntaxError)", () => {
    expect(tryParseFirstJsonArray("[[reply_to_current]]")).toBeNull();
  });

  it("returns null for truncated [[reply_to_c… placeholder", () => {
    expect(tryParseFirstJsonArray("[[reply_to_c")).toBeNull();
  });

  it("finds a valid array after a non-JSON [[placeholder]] line", () => {
    const raw = `[[reply_to_current]]
["preference", "entity"]`;
    expect(tryParseFirstJsonArray(raw)).toEqual(["preference", "entity"]);
  });

  // GitHub #1151 / #1152: greedy /\[[\s\S]*\]/ grabbed junk + broke JSON.parse; balanced slice + retry fixes this
  it("finds valid labels after an invalid balanced bracket span", () => {
    const raw = `[[not valid json inside]]
["alpha", "beta"]`;
    expect(tryParseFirstJsonArray(raw)).toEqual(["alpha", "beta"]);
  });

  it("strips [Context: …] preamble before JSON array (#1166)", () => {
    expect(stripBracketContextPreamble(`[Context: Tool]\n["a"]`)).toBe(`["a"]`);
    expect(tryParseFirstJsonArray(`[Context: Topics]\n["fact","entity"]`)).toEqual(["fact", "entity"]);
  });
});

describe("tryParseFirstJsonObject", () => {
  it("returns filtered items from the first valid object", () => {
    expect(
      tryParseFirstJsonObject('{"items":["x"]}', (parsed) =>
        Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: string[] }).items : null,
      ),
    ).toEqual(["x"]);
  });

  it("returns null when filter rejects parsed object", () => {
    expect(tryParseFirstJsonObject('{"a":1}', () => null)).toBeNull();
  });
});

describe("parseStructuredItems", () => {
  const isStringItem = (item: unknown): item is string => typeof item === "string";

  it("parses a JSON array of valid items", () => {
    expect(parseStructuredItems('["alpha","beta"]', isStringItem)).toEqual(["alpha", "beta"]);
  });

  it("unwraps {items:[...]} envelopes", () => {
    expect(parseStructuredItems(JSON.stringify({ items: ["x"] }), isStringItem)).toEqual(["x"]);
  });

  it("unwraps tool_calls.function.arguments payloads", () => {
    const raw = JSON.stringify({
      tool_calls: [{ function: { arguments: JSON.stringify({ items: ["from-tools"] }) } }],
    });
    expect(parseStructuredItems(raw, isStringItem)).toEqual(["from-tools"]);
  });

  it("merges items from multiple tool_calls argument strings (#1876 envelope)", () => {
    const raw = JSON.stringify({
      tool_calls: [JSON.stringify({ items: ["first"] }), JSON.stringify({ items: ["second"] })],
    });
    expect(parseStructuredItems(raw, isStringItem)).toEqual(["first", "second"]);
  });

  it("accepts a single valid object", () => {
    expect(parseStructuredItems('{"a":"solo"}', (item) => typeof item === "object")).toEqual([{ a: "solo" }]);
  });

  it("returns null for invalid items", () => {
    expect(parseStructuredItems('{"not":"valid"}', isStringItem)).toBeNull();
  });

  it("returns empty array when acceptEmptyArray is set", () => {
    expect(parseStructuredItems("[]", isStringItem, { acceptEmptyArray: true })).toEqual([]);
  });

  it("returns null for empty array without acceptEmptyArray", () => {
    expect(parseStructuredItems("[]", isStringItem)).toBeNull();
  });
});

describe("parseStructuredItemsAcceptingEmpty", () => {
  const isStringItem = (item: unknown): item is string => typeof item === "string";

  it("returns [] for a valid empty array", () => {
    expect(parseStructuredItemsAcceptingEmpty("[]", isStringItem)).toEqual([]);
  });

  it("returns null for unparseable output", () => {
    expect(parseStructuredItemsAcceptingEmpty("not json", isStringItem)).toBeNull();
  });

  it("parses non-empty arrays like parseStructuredItems", () => {
    expect(parseStructuredItemsAcceptingEmpty('["a"]', isStringItem)).toEqual(["a"]);
  });
});
