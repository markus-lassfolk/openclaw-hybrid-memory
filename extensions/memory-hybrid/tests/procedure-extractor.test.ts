import { describe, it, expect } from "vitest";
import {
  parseSessionJsonl,
  minimalRecipe,
} from "../services/procedure-extractor.js";
import type { ProcedureStep } from "../types/memory.js";

describe("procedure-extractor", () => {
  describe("parseSessionJsonl", () => {
    it("returns null when no tool calls", () => {
      const content = JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      });
      expect(parseSessionJsonl(content, "s1")).toBeNull();
    });

    it("returns null when only one tool step", () => {
      const lines = [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Check the API" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "web_fetch", input: { url: "https://example.com" } },
            ],
          },
        }),
      ];
      expect(parseSessionJsonl(lines.join("\n"), "s1")).toBeNull();
    });

    it("parses task intent and multiple tool steps", () => {
      const lines = [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "  Check Moltbook notifications  " }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "web_fetch", input: { url: "https://api.example.com/agents" } },
              { type: "tool_use", id: "t2", name: "message", input: { text: "Done" } },
            ],
          },
        }),
      ];
      const result = parseSessionJsonl(lines.join("\n"), "session-1");
      expect(result).not.toBeNull();
      expect(result!.taskIntent).toBe("Check Moltbook notifications");
      expect(result!.steps).toHaveLength(2);
      expect(result!.steps[0].tool).toBe("web_fetch");
      expect(result!.steps[1].tool).toBe("message");
      expect(result!.success).toBe(true);
      expect(result!.sessionId).toBe("session-1");
    });

    it("marks success false when tool result contains error", () => {
      const lines = [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Call the API" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "web_fetch", input: {} },
              { type: "tool_use", id: "t2", name: "message", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "tool",
            content: [{ type: "tool_result", content: "Error: 404 Not Found" }],
          },
        }),
      ];
      const result = parseSessionJsonl(lines.join("\n"), "s2");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.errorMessage).toContain("404");
    });

    it("truncates task intent to 300 chars", () => {
      const long = "a".repeat(400);
      const lines = [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: long }] },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "exec", input: {} },
              { type: "tool_use", id: "t2", name: "message", input: {} },
            ],
          },
        }),
      ];
      const result = parseSessionJsonl(lines.join("\n"), "s3");
      expect(result).not.toBeNull();
      expect(result!.taskIntent).toHaveLength(300);
    });
  });

  describe("minimalRecipe", () => {
    it("strips secret keys from args", () => {
      const steps: ProcedureStep[] = [
        { tool: "api_call", args: { url: "https://api.example.com", apiKey: "sk-secret", query: "test" } },
      ];
      const out = minimalRecipe(steps);
      expect(out).toHaveLength(1);
      expect(out[0].args).not.toHaveProperty("apiKey");
      expect(out[0].args).toHaveProperty("url");
      expect(out[0].args).toHaveProperty("query");
    });

    it("truncates long string args to 200 chars", () => {
      const longUrl = "https://example.com/" + "x".repeat(300);
      const steps: ProcedureStep[] = [
        { tool: "web_fetch", args: { url: longUrl } },
      ];
      const out = minimalRecipe(steps);
      expect((out[0].args as Record<string, string>)?.url?.length).toBe(201);
      expect((out[0].args as Record<string, string>)?.url?.endsWith("…")).toBe(true);
    });

    it("preserves short args and tool name", () => {
      const steps: ProcedureStep[] = [
        { tool: "memory_recall", args: { query: "test", limit: 5 }, summary: "recall" },
      ];
      const out = minimalRecipe(steps);
      expect(out[0].tool).toBe("memory_recall");
      expect(out[0].args).toEqual({ query: "test", limit: 5 });
      expect(out[0].summary).toBe("recall");
    });
  });
});
