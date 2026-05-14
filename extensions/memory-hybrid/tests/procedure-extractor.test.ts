import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FactsDB } from "../backends/facts-db.js";
import {
  extractProceduresFromSessions,
  type ParsedSession,
  minimalRecipe,
  parseSessionJsonl,
  taskSimilarity,
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
            content: [{ type: "tool_use", id: "t1", name: "web_fetch", input: { url: "https://example.com" } }],
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
      const result = parseSessionJsonl(lines.join("\n"), "session-1") as ParsedSession | null;
      expect(result).not.toBeNull();
      expect(result?.taskIntent).toBe("Check Moltbook notifications");
      expect(result?.steps).toHaveLength(2);
      expect(result?.steps[0].tool).toBe("web_fetch");
      expect(result?.steps[1].tool).toBe("message");
      expect(result?.success).toBe(true);
      expect(result?.sessionId).toBe("session-1");
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
      const result = parseSessionJsonl(lines.join("\n"), "s2") as ParsedSession | null;
      expect(result).not.toBeNull();
      expect(result?.success).toBe(false);
      expect(result?.errorMessage).toContain("404");
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
      const result = parseSessionJsonl(lines.join("\n"), "s3") as ParsedSession | null;
      expect(result).not.toBeNull();
      expect(result?.taskIntent).toHaveLength(300);
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
      const longUrl = `https://example.com/${"x".repeat(300)}`;
      const steps: ProcedureStep[] = [{ tool: "web_fetch", args: { url: longUrl } }];
      const out = minimalRecipe(steps);
      expect((out[0].args as Record<string, string>)?.url?.length).toBe(201);
      expect((out[0].args as Record<string, string>)?.url?.endsWith("…")).toBe(true);
    });

    it("preserves short args and tool name", () => {
      const steps: ProcedureStep[] = [{ tool: "memory_recall", args: { query: "test", limit: 5 }, summary: "recall" }];
      const out = minimalRecipe(steps);
      expect(out[0].tool).toBe("memory_recall");
      expect(out[0].args).toEqual({ query: "test", limit: 5 });
      expect(out[0].summary).toBe("recall");
    });
  });

  describe("taskSimilarity", () => {
    it("is symmetric", () => {
      const a = "fix bug";
      const b = "fix the failing ci bug that prevents deploys and update the release notes";
      expect(taskSimilarity(a, b)).toBe(taskSimilarity(b, a));
    });

    it("does not treat a short task as identical to a long task that contains its words", () => {
      const shortTask = "fix bug";
      const longTask = "fix the failing ci bug that prevents deploys and update the release notes";
      expect(taskSimilarity(shortTask, longTask)).toBeLessThan(0.35);
    });
  });

  describe("extractProceduresFromSessions", () => {
    function writeSession(taskIntent: string): string {
      const dir = mkdtempSync(join(tmpdir(), "proc-extractor-"));
      const filePath = join(dir, "session-1.jsonl");
      const lines = [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: taskIntent }] },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "web_fetch", input: { url: "https://example.com" } },
              { type: "tool_use", id: "t2", name: "message", input: { text: "Done" } },
            ],
          },
        }),
      ];
      writeFileSync(filePath, lines.join("\n"), "utf-8");
      return dir;
    }

    it("does not merge unrelated long task into short-task procedure", async () => {
      const dir = writeSession("fix the failing ci bug that prevents deploys and update the release notes");
      const findProcedureByTaskPattern = vi.fn(() => [{ id: "p1", taskPattern: "fix bug" }]);
      const recordProcedureSuccess = vi.fn(() => true);
      const upsertProcedure = vi.fn();
      const factsDb = {
        findProcedureByTaskPattern,
        recordProcedureSuccess,
        recordProcedureFailure: vi.fn(() => true),
        upsertProcedure,
      } as unknown as FactsDB;

      try {
        await extractProceduresFromSessions(factsDb, { filePaths: [join(dir, "session-1.jsonl")] }, { info: vi.fn(), warn: vi.fn() });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      expect(recordProcedureSuccess).not.toHaveBeenCalled();
      expect(upsertProcedure).toHaveBeenCalledTimes(1);
    });

    it("still merges true task matches", async () => {
      const dir = writeSession("fix deployment pipeline bug in ci");
      const findProcedureByTaskPattern = vi.fn(() => [{ id: "p1", taskPattern: "fix deployment pipeline bug" }]);
      const recordProcedureSuccess = vi.fn(() => true);
      const upsertProcedure = vi.fn();
      const factsDb = {
        findProcedureByTaskPattern,
        recordProcedureSuccess,
        recordProcedureFailure: vi.fn(() => true),
        upsertProcedure,
      } as unknown as FactsDB;

      try {
        await extractProceduresFromSessions(factsDb, { filePaths: [join(dir, "session-1.jsonl")] }, { info: vi.fn(), warn: vi.fn() });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      expect(recordProcedureSuccess).toHaveBeenCalledTimes(1);
      expect(upsertProcedure).not.toHaveBeenCalled();
    });
  });
});
