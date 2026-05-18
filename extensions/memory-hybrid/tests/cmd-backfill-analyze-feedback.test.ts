import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnalyzeFeedbackPhrasesForCli } from "../cli/cmd-backfill.js";
import type { HandlerContext } from "../cli/handlers.js";

describe("runAnalyzeFeedbackPhrasesForCli session JSONL parsing", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "hybrid-backfill-analyze-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (previousHome === undefined) process.env.HOME = undefined;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) process.env.USERPROFILE = undefined;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeSessionFile(contents: string, opts?: { agentId?: string; fileName?: string }): void {
    const agentId = opts?.agentId ?? "agent-1";
    const fileName = opts?.fileName ?? "session.jsonl";
    const sessionsDir = join(tempHome, ".openclaw", "agents", agentId, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, fileName), contents, "utf-8");
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

  it("continues scanning files after malformed JSONL and reports scanned count accurately", async () => {
    writeSessionFile('{"type":"message"\n', { agentId: "agent-1", fileName: "bad.jsonl" });
    writeSessionFile(
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "all good" }] },
      })}\n`,
      { agentId: "agent-2", fileName: "good.jsonl" },
    );

    const result = await runAnalyzeFeedbackPhrasesForCli(makeContext(), { days: 30 });

    expect(result.error).toContain("Malformed session JSONL at");
    expect(result.error).toContain("bad.jsonl:1");
    expect(result.sessionsScanned).toBe(2);
  });
});
