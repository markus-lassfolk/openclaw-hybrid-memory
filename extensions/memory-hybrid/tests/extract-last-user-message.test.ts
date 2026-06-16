import { describe, expect, it } from "vitest";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";

describe("extractLastUserMessageText", () => {
  it("returns event.prompt when present (agent heartbeat / before_agent_start)", () => {
    expect(
      extractLastUserMessageText({
        prompt: "Read HEARTBEAT.md if it exists. Workspace ok. Reply HEARTBEAT_OK.",
      }),
    ).toBe("Read HEARTBEAT.md if it exists. Workspace ok. Reply HEARTBEAT_OK.");
  });

  it("prefers prompt over messages when both are set", () => {
    expect(
      extractLastUserMessageText({
        prompt: "cron heartbeat — assess goals",
        messages: [{ role: "user", content: "older message without heartbeat keyword" }],
      }),
    ).toBe("cron heartbeat — assess goals");
  });

  it("falls back to last user message in messages array", () => {
    expect(
      extractLastUserMessageText({
        messages: [
          { role: "assistant", content: "ok" },
          { role: "user", content: "scheduled ping" },
        ],
      }),
    ).toBe("scheduled ping");
  });

  it("extracts text blocks from structured message content", () => {
    expect(
      extractLastUserMessageText({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
          },
        ],
      }),
    ).toBe("line one\nline two");
  });

  it("returns undefined when prompt is blank and messages are absent", () => {
    expect(extractLastUserMessageText({ prompt: "   " })).toBeUndefined();
    expect(extractLastUserMessageText({})).toBeUndefined();
  });
});
