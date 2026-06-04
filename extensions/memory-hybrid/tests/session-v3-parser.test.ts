import { describe, expect, it } from "vitest";
import {
  extractRecallEventsFromMessages,
  extractRecallEventsFromTrajectoryLines,
  extractToolSequenceFromMessages,
  extractToolSequenceFromTrajectoryLines,
} from "../services/session-v3-parser.js";
import { parseSessionMessagesFromLines } from "../services/session-signal-context.js";

describe("session-v3-parser", () => {
  it("parses toolResult role as tool messages", () => {
    const messages = parseSessionMessagesFromLines(
      [
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolName: "exec", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
        }),
      ],
      "test",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolName).toBe("exec");
  });

  it("extracts tool sequence from v3 toolCall and toolResult rows", () => {
    const messages = parseSessionMessagesFromLines(
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "memory_recall", arguments: { query: "x" } }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: "c1", toolName: "memory_recall", content: [{ type: "text", text: "hit" }] },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "c2", name: "exec", arguments: { command: "ls" } }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: "c2", toolName: "exec", content: [{ type: "text", text: "done" }] },
        }),
      ],
      "test",
    );
    expect(extractToolSequenceFromMessages(messages)).toEqual(["memory_recall", "exec"]);
  });

  it("pairs v3 memory_recall toolCall with toolResult details.memories", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const messages = parseSessionMessagesFromLines(
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "memory_recall", arguments: { query: "prefs" } }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "memory_recall",
            content: [{ type: "text", text: "Found 1 memories" }],
            details: { memories: [{ id, text: "User prefers dark mode", category: "preference" }] },
          },
        }),
      ],
      "test",
    );
    const events = extractRecallEventsFromMessages(messages);
    expect(events).toHaveLength(1);
    expect(events[0].query).toBe("prefs");
    expect(events[0].factIds).toContain(id);
    expect(events[0].hit).toBe(true);
  });

  it("extracts recall events from trajectory tool.call/tool.result lines", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const lines = [
      JSON.stringify({
        type: "tool.call",
        data: { toolCallId: "t1", name: "memory_recall", arguments: { query: "deploy" } },
      }),
      JSON.stringify({
        type: "tool.result",
        data: {
          toolCallId: "t1",
          name: "memory_recall",
          contentItems: [{ type: "inputText", text: `Memory ${id} found` }],
        },
      }),
    ];
    const events = extractRecallEventsFromTrajectoryLines(lines, "test");
    expect(events).toHaveLength(1);
    expect(events[0].factIds).toContain(id);
  });

  it("extracts tool sequence from trajectory tool.call events", () => {
    const lines = [
      JSON.stringify({ type: "tool.call", data: { toolCallId: "a", name: "read" } }),
      JSON.stringify({ type: "tool.call", data: { toolCallId: "b", name: "exec" } }),
    ];
    expect(extractToolSequenceFromTrajectoryLines(lines, "test")).toEqual(["read", "exec"]);
  });
});
