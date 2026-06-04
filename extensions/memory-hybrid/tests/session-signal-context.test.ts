import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSignalContext,
  extractRecalledMemoryIds,
  extractToolCallSequence,
  parseSessionMessagesFromLines,
  testSignalRegex,
} from "../services/session-signal-context.js";
import { runSelfCorrectionExtract } from "../services/self-correction-extract.js";

function msg(role: string, content: unknown): string {
  return JSON.stringify({
    type: "message",
    message: { role, content },
  });
}

describe("session-signal-context", () => {
  it("extracts tool call sequence from assistant content blocks", () => {
    const content = [
      { type: "tool_use", name: "memory_recall" },
      { type: "tool_use", name: "exec" },
    ];
    expect(extractToolCallSequence(content)).toEqual(["memory_recall", "exec"]);
  });

  it("extracts recalled memory UUIDs from tool results", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const content = [{ type: "tool_result", content: `Found memory ${id} in results` }];
    expect(extractRecalledMemoryIds(content)).toEqual([id]);
  });

  it("buildSignalContext collects tools from consecutive assistant turns after preceding user", () => {
    const messages = parseSessionMessagesFromLines(
      [
        msg("user", [{ type: "text", text: "Deploy the app" }]),
        msg("assistant", [{ type: "tool_use", name: "memory_recall" }]),
        msg("assistant", [{ type: "tool_use", name: "exec" }, { type: "text", text: "Deploy ran without verification." }]),
        msg("user", [{ type: "text", text: "Wrong — verify logs before deploy." }]),
        msg("assistant", [{ type: "text", text: "I will verify first." }]),
      ],
      "test",
    );
    const userIdx = messages.findIndex((m) => m.role === "user" && m.text.includes("Wrong"));
    const ctx = buildSignalContext(messages, userIdx, { lookback: 20 });
    expect(ctx.precedingAssistant).toContain("Deploy ran");
    expect(ctx.toolCallSequence).toEqual(["memory_recall", "exec"]);
    expect(ctx.precedingUserMessage).toContain("Deploy the app");
  });

  it("buildSignalContext walks back past tool turns to find assistant", () => {
    const messages = parseSessionMessagesFromLines(
      [
        msg("user", [{ type: "text", text: "Run the deploy" }]),
        msg("assistant", [
          { type: "tool_use", name: "exec" },
          { type: "text", text: "Deploy completed without verification." },
        ]),
        msg("tool", [{ type: "text", text: "ok" }]),
        msg("user", [{ type: "text", text: "That was wrong — verify before deploy next time." }]),
        msg("assistant", [{ type: "text", text: "I will verify first." }]),
      ],
      "test",
    );
    const userIdx = messages.findIndex((m) => m.role === "user" && m.text.includes("wrong"));
    const ctx = buildSignalContext(messages, userIdx, { lookback: 20 });
    expect(ctx.precedingAssistant).toContain("Deploy completed");
    expect(ctx.toolCallSequence).toContain("exec");
    expect(ctx.followingAssistant).toContain("verify first");
  });

  it("testSignalRegex resets lastIndex on global regex", () => {
    const re = /fix|wrong/gi;
    expect(testSignalRegex(re, "wrong")).toBe(true);
    expect(testSignalRegex(re, "wrong again")).toBe(true);
  });
});

describe("self-correction-extract tool context", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sc-context-test-"));
  });

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("includes toolCallSequence when assistant is not immediately before user", () => {
    const jsonl = [
      msg("user", [{ type: "text", text: "Please deploy the app" }]),
      msg("assistant", [
        { type: "tool_use", name: "memory_recall" },
        { type: "text", text: "I ran deploy without checking logs first." },
      ]),
      msg("tool", [{ type: "text", text: "done" }]),
      msg("user", [{ type: "text", text: "That was wrong — you should have verified the logs first." }]),
      msg("assistant", [{ type: "text", text: "Understood." }]),
    ].join("\n");
    const path = join(tmpDir, "2026-02-20-session.jsonl");
    writeFileSync(path, jsonl, "utf-8");

    const re = /that was wrong|you should have/i;
    const result = runSelfCorrectionExtract({ filePaths: [path], correctionRegex: re });

    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0].precedingAssistant).toContain("deploy");
    expect(result.incidents[0].toolCallSequence).toEqual(["memory_recall"]);
    expect(result.incidents[0].precedingUserMessage).toContain("deploy the app");
  });
});
