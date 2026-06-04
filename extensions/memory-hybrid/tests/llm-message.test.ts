import { describe, expect, it } from "vitest";
import { extractAssistantMessageText } from "../utils/llm-message.js";

describe("extractAssistantMessageText", () => {
  it("returns string content when present", () => {
    expect(extractAssistantMessageText({ content: '["a"]' })).toEqual({
      text: '["a"]',
      source: "content",
    });
  });

  it("extracts text from array content blocks", () => {
    expect(
      extractAssistantMessageText({
        content: [
          { type: "text", text: '{"items":[]}' },
          { type: "text", text: "ignored second block" },
        ],
      }),
    ).toEqual({
      text: '{"items":[]}\nignored second block',
      source: "content_blocks",
    });
  });

  it("uses native tool_calls arguments when content is empty", () => {
    expect(
      extractAssistantMessageText({
        content: "",
        tool_calls: [
          {
            type: "function",
            function: {
              name: "emit_items",
              arguments: JSON.stringify({ items: [{ id: 1 }] }),
            },
          },
        ],
      }),
    ).toEqual({
      text: JSON.stringify({ items: [{ id: 1 }] }),
      source: "tool_calls",
    });
  });

  it("serializes multiple tool_calls into a JSON envelope when none look structured", () => {
    const result = extractAssistantMessageText({
      content: null,
      tool_calls: [{ function: { arguments: "plain" } }, { function: { arguments: "text" } }],
    });
    expect(result.source).toBe("tool_calls");
    expect(JSON.parse(result.text)).toEqual({ tool_calls: ["plain", "text"] });
  });

  it("prefers the first structured tool_calls argument when multiple are present", () => {
    const payload = JSON.stringify([{ remediationType: "NO_ACTION" }]);
    const result = extractAssistantMessageText({
      content: null,
      tool_calls: [{ function: { arguments: payload } }, { function: { arguments: '{"other":true}' } }],
    });
    expect(result).toEqual({ text: payload, source: "tool_calls" });
  });

  it("falls back to reasoning_content then reasoning after empty content", () => {
    expect(extractAssistantMessageText({ content: "", reasoning_content: "reasoning payload" })).toEqual({
      text: "reasoning payload",
      source: "reasoning",
    });
    expect(extractAssistantMessageText({ content: "", reasoning: "legacy reasoning" })).toEqual({
      text: "legacy reasoning",
      source: "reasoning",
    });
  });

  it("prefers string content over tool_calls", () => {
    expect(
      extractAssistantMessageText({
        content: '["from-content"]',
        tool_calls: [{ function: { arguments: '["from-tools"]' } }],
      }),
    ).toEqual({
      text: '["from-content"]',
      source: "content",
    });
  });

  it("uses tool_calls when content is placeholder empty array", () => {
    expect(
      extractAssistantMessageText({
        content: "[]",
        tool_calls: [{ function: { arguments: '[{"remediationType":"NO_ACTION"}]' } }],
      }),
    ).toEqual({
      text: '[{"remediationType":"NO_ACTION"}]',
      source: "tool_calls",
    });
  });

  it("uses tool_calls when content is placeholder empty object", () => {
    expect(
      extractAssistantMessageText({
        content: "{}",
        tool_calls: [{ function: { arguments: '{"items":[{"id":1}]}' } }],
      }),
    ).toEqual({
      text: '{"items":[{"id":1}]}',
      source: "tool_calls",
    });
  });

  it("returns empty for missing message", () => {
    expect(extractAssistantMessageText(null)).toEqual({ text: "", source: "empty" });
    expect(extractAssistantMessageText(undefined)).toEqual({ text: "", source: "empty" });
  });
});
