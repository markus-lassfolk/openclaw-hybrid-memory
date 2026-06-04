import { describe, expect, it } from "vitest";
import {
  extractBalancedArraySlice,
  extractFirstJsonArraySubstring,
  parseStructuredItems,
  parseStructuredItemsAcceptingEmpty,
  stripBracketContextPreamble,
  stripMarkdownCodeFence,
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
