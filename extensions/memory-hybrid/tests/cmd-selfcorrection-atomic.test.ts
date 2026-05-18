/**
 * Focused regression tests for atomic file writes in cmd-selfcorrection (Issue #1499).
 *
 * Verifies that:
 *  - runSelfCorrectionExtractForCli writes incidents atomically to outputPath
 *  - On rename failure the target file is not created (no partial state)
 *  - The temp file is cleaned up on failure
 *  - Happy-path content is correct
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSelfCorrectionExtractForCli } from "../cli/cmd-selfcorrection.js";
import type { HandlerContext } from "../cli/handlers.js";
import type { CorrectionIncident } from "../services/self-correction-extract.js";

// ---------------------------------------------------------------------------
// Controlled failure injection via vi.mock (mirrors atomic-write.test.ts)
// ---------------------------------------------------------------------------

let simulateRenameFailure = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      if (simulateRenameFailure) {
        throw new Error("simulated rename failure");
      }
      return actual.renameSync(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

/**
 * Build a minimal HandlerContext that satisfies runSelfCorrectionExtractForCli.
 * runSelfCorrectionExtractForCli only uses ctx.logger, so we only need to set
 * that field correctly; the rest are stubs.
 */
function makeCtx(): HandlerContext {
  return {
    factsDb: {},
    vectorDb: {},
    embeddings: {},
    openai: {},
    proposalsDb: null,
    cfg: {},
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    identityReflectionStore: null,
    personaStateStore: null,
    resolvedSqlitePath: "",
    resolvedLancePath: "",
    pluginId: "test",
    logger: { info: vi.fn(), warn: vi.fn() },
    detectCategory: () => "technical",
  } as unknown as HandlerContext;
}

/**
 * Create a minimal session JSONL containing one correction-like exchange
 * so that runSelfCorrectionExtract returns at least one incident.
 */
function createSessionFile(dir: string): string {
  const sessionPath = join(dir, "2026-01-01-session.jsonl");
  const lines = [
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I renamed the variable to be more descriptive." }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "No, that's wrong. Please revert that and use the original name. This is incorrect.",
          },
        ],
      },
    }),
  ];
  writeFileSync(sessionPath, lines.join("\n"), "utf-8");
  return sessionPath;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cmd-sc-atomic-test-"));
  simulateRenameFailure = false;
});

afterEach(() => {
  simulateRenameFailure = false;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path: incident file written correctly
// ---------------------------------------------------------------------------

describe("runSelfCorrectionExtractForCli — atomic outputPath write", () => {
  it("writes incidents JSON to outputPath when incidents are found", () => {
    const sessionPath = createSessionFile(tmpDir);
    const outputPath = join(tmpDir, "out", "incidents.json");

    const ctx = makeCtx();
    const result = runSelfCorrectionExtractForCli(ctx, {
      outputPath,
      filePaths: [sessionPath],
    });

    // At least one incident must be extracted for the write to trigger
    expect(result.incidents.length).toBeGreaterThan(0);
    expect(existsSync(outputPath)).toBe(true);

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as CorrectionIncident[];
    expect(written).toHaveLength(result.incidents.length);
    expect(written[0]).toMatchObject({ sessionFile: sessionPath });
  });

  it("creates intermediate directories for outputPath", () => {
    const sessionPath = createSessionFile(tmpDir);
    const outputPath = join(tmpDir, "deeply", "nested", "dir", "incidents.json");

    runSelfCorrectionExtractForCli(makeCtx(), {
      outputPath,
      filePaths: [sessionPath],
    });

    expect(existsSync(outputPath)).toBe(true);
  });

  it("leaves no temp file behind on success", () => {
    const sessionPath = createSessionFile(tmpDir);
    const outputPath = join(tmpDir, "out", "incidents.json");

    runSelfCorrectionExtractForCli(makeCtx(), {
      outputPath,
      filePaths: [sessionPath],
    });

    // No .tmp- files should exist alongside the output
    const outDir = join(tmpDir, "out");
    if (existsSync(outDir)) {
      const entries = readdirSync(outDir);
      expect(entries.every((e) => !e.includes(".tmp-"))).toBe(true);
    }
  });

  it("skips the write when no incidents are found", () => {
    // Empty session file yields no incidents
    const sessionPath = join(tmpDir, "empty-session.jsonl");
    writeFileSync(sessionPath, "", "utf-8");
    const outputPath = join(tmpDir, "out", "incidents.json");

    runSelfCorrectionExtractForCli(makeCtx(), {
      outputPath,
      filePaths: [sessionPath],
    });

    expect(existsSync(outputPath)).toBe(false);
  });

  it("does not write when outputPath is not provided", () => {
    const sessionPath = createSessionFile(tmpDir);

    const result = runSelfCorrectionExtractForCli(makeCtx(), {
      filePaths: [sessionPath],
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    // No file should appear in tmpDir other than the session itself
    const files = readdirSync(tmpDir);
    expect(files.every((f) => f.endsWith("-session.jsonl"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: on rename failure the target is never partially written
// ---------------------------------------------------------------------------

describe("runSelfCorrectionExtractForCli — atomicity on rename failure", () => {
  it("does not create the output file when rename fails", () => {
    simulateRenameFailure = true;
    const sessionPath = createSessionFile(tmpDir);
    const outputPath = join(tmpDir, "out", "incidents.json");

    // The function should swallow the error (captured via capturePluginError)
    expect(() =>
      runSelfCorrectionExtractForCli(makeCtx(), {
        outputPath,
        filePaths: [sessionPath],
      }),
    ).not.toThrow();

    // The target file must NOT exist — no partial state.
    expect(existsSync(outputPath)).toBe(false);
  });

  it("cleans up the temp file when rename fails", () => {
    simulateRenameFailure = true;
    const sessionPath = createSessionFile(tmpDir);
    const outDir = join(tmpDir, "out");
    const outputPath = join(outDir, "incidents.json");

    runSelfCorrectionExtractForCli(makeCtx(), {
      outputPath,
      filePaths: [sessionPath],
    });

    // The output directory may or may not exist; if it does, no temp files remain.
    if (existsSync(outDir)) {
      const entries = readdirSync(outDir);
      expect(entries.every((e) => !e.includes(".tmp-"))).toBe(true);
    }
  });
});
