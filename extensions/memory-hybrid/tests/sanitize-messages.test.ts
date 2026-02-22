import { describe, it, expect } from "vitest";
import { sanitizeMessagesForClaude, type MessageLike } from "../utils/sanitize-messages.js";

describe("sanitizeMessagesForClaude", () => {
  it("returns same array when no assistant message has tool_use", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];
    const out = sanitizeMessagesForClaude(messages);
    expect(out).toBe(messages);
  });

  it("returns same array when tool_use is followed by matching tool_result", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "Run ls" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "process1", name: "process", input: {} },
          { type: "text", text: "Running..." },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "process1", content: "file1\nfile2" }],
      },
    ];
    const out = sanitizeMessagesForClaude(messages);
    expect(out).toBe(messages);
  });

  it("inserts tool message when assistant tool_use has no following tool_result", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "Run it" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "process1771772163946288", name: "process", input: {} },
          { type: "tool_use", id: "subagents1771772163961289", name: "subagents", input: {} },
        ],
      },
      { role: "user", content: "Next turn" },
    ];
    const out = sanitizeMessagesForClaude(messages);
    expect(out).not.toBe(messages);
    expect(out.length).toBe(4);
    expect(out[2].role).toBe("tool");
    const content = out[2].content as Array<{ type?: string; tool_use_id?: string; content?: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content!.length).toBe(2);
    const ids = content!.map((b) => b.tool_use_id).sort();
    expect(ids).toEqual(["process1771772163946288", "subagents1771772163961289"]);
    content!.forEach((b) => {
      expect(b.type).toBe("tool_result");
      expect(b.content).toBe("[Output omitted or truncated.]");
    });
    expect(out[3]).toBe(messages[2]);
  });

  it("appends missing tool_result to existing tool message", () => {
    const messages: MessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "x", input: {} },
          { type: "tool_use", id: "b", name: "y", input: {} },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "a", content: "result a" }],
      },
    ];
    const out = sanitizeMessagesForClaude(messages);
    expect(out.length).toBe(2);
    expect(out[1].role).toBe("tool");
    const content = out[1].content as Array<{ tool_use_id?: string; content?: string }>;
    expect(content.length).toBe(2);
    const toolResultIds = content.map((b) => b.tool_use_id).sort();
    expect(toolResultIds).toEqual(["a", "b"]);
  });

  it("leaves non-assistant messages unchanged", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "orphan", name: "run", input: {} }],
      },
    ];
    const out = sanitizeMessagesForClaude(messages);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    expect(out[2].role).toBe("tool");
  });
});
