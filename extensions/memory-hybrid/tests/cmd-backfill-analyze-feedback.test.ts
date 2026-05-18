import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnalyzeFeedbackPhrasesForCli } from "../cli/cmd-backfill.js";
import type { HandlerContext } from "../cli/handlers.js";

describe("runAnalyzeFeedbackPhrasesForCli session JSONL parsing", () => {
  let tempHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "hybrid-backfill-analyze-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (previousHome === undefined) process.env.HOME = undefined;
    else process.env.HOME = previousHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeSessionFile(contents: string): void {
    const sessionsDir = join(tempHome, ".openclaw", "agents", "agent-1", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "session.jsonl"), contents, "utf-8");
  }

  function makeContext(): HandlerContext {
    return {
      cfg: {} as HandlerContext["cfg"],
      logger: {},
      openai: {} as HandlerContext["openai"],
    } as HandlerContext;
  }

  it("returns a controlled error for malformed session JSONL", async () => {
    writeSessionFile('{"type":"message"\n');

    const result = await runAnalyzeFeedbackPhrasesForCli(makeContext(), { days: 30 });

    expect(result.error).toContain("Malformed session JSONL at");
    expect(result.error).toContain("session.jsonl:1");
    expect(result.reinforcement).toEqual([]);
    expect(result.correction).toEqual([]);
    expect(result.sessionsScanned).toBe(1);
  });

  it("keeps valid JSONL behavior unchanged", async () => {
    writeSessionFile(
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "all good" }] },
      })}\n`,
    );

    const result = await runAnalyzeFeedbackPhrasesForCli(makeContext(), { days: 30 });

    expect(result.error).toBeUndefined();
    expect(result.reinforcement).toEqual([]);
    expect(result.correction).toEqual([]);
    expect(result.sessionsScanned).toBe(1);
  });
});
