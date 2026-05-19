/**
 * Maintenance pipeline + session JSONL resilience (release 2026.5.190).
 *
 * Complements cmd-backfill-jsonl / cmd-backfill-analyze-feedback unit tests with a
 * single place documenting that malformed lines must not break downstream maintenance.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractUserMessageTextsFromSessionJsonl, runAnalyzeFeedbackPhrasesForCli } from "../cli/cmd-backfill.js";
import type { HandlerContext } from "../cli/handlers.js";
import { getEnv, setEnv } from "../utils/env-manager.js";

describe("maintenance pipeline — malformed session JSONL", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "hm-maint-jsonl-"));
    previousHome = getEnv("HOME");
    previousUserProfile = getEnv("USERPROFILE");
    setEnv("HOME", tempHome);
    setEnv("USERPROFILE", tempHome);
  });

  afterEach(() => {
    setEnv("HOME", previousHome);
    setEnv("USERPROFILE", previousUserProfile);
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeSession(relativePath: string, contents: string): void {
    const full = join(tempHome, relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf-8");
  }

  function makeContext(): HandlerContext {
    return {
      cfg: {} as HandlerContext["cfg"],
      logger: {},
      openai: {} as HandlerContext["openai"],
    } as HandlerContext;
  }

  it("extract path tolerates mixed valid and invalid JSONL (backfill / distill inputs)", () => {
    const path = join(tempHome, "mixed.jsonl");
    writeFileSync(
      path,
      [
        "{ broken",
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "keep me" }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    expect(extractUserMessageTextsFromSessionJsonl(path)).toEqual(["keep me"]);
  });

  it("analyze-feedback skips phrase extraction when any session has malformed JSONL", async () => {
    writeSession(".openclaw/agents/agent-bad/sessions/bad.jsonl", '{"type":"message"\n');
    writeSession(
      ".openclaw/agents/agent-good/sessions/good.jsonl",
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      })}\n`,
    );

    const result = await runAnalyzeFeedbackPhrasesForCli(makeContext(), { days: 30 });

    expect(result.error).toContain("Malformed session JSONL at");
    expect(result.error).toContain("bad.jsonl:1");
    // All files are scanned; phrase extraction is skipped when any file had a bad line.
    expect(result.sessionsScanned).toBe(1);
    expect(result.reinforcement).toEqual([]);
    expect(result.correction).toEqual([]);
  });
});
