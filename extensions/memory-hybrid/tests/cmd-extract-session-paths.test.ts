/**
 * Regression tests for getSessionFilePathsSince (Issue #1493).
 *
 * Guards the outer-catch silent-failure path: when readdirSync throws,
 * the function must return [] AND emit a console.warn so the failure is
 * diagnosable even when telemetry/capturePluginError is a no-op.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionFilePathsSince } from "../cli/cmd-extract.js";

// ---------------------------------------------------------------------------
// Controlled readdirSync failure injection
// ---------------------------------------------------------------------------

let simulateReaddirFailure = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync(...args: Parameters<typeof actual.readdirSync>) {
      if (simulateReaddirFailure) {
        throw new Error("simulated readdirSync failure");
      }
      return actual.readdirSync(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  simulateReaddirFailure = false;
  tmpDir = mkdtempSync(join(tmpdir(), "cmd-extract-session-paths-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSessionFilePathsSince", () => {
  it("returns [] and emits console.warn when readdirSync throws (outer-catch silent-failure guard)", () => {
    simulateReaddirFailure = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = getSessionFilePathsSince(tmpDir, 7);

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, dir, errMsg] = warnSpy.mock.calls[0];
    expect(msg).toContain("getSessionFilePathsSince");
    expect(dir).toBe(tmpDir);
    expect(typeof errMsg).toBe("string");
    expect(errMsg).toContain("simulated readdirSync failure");

    warnSpy.mockRestore();
  });

  it("returns [] for a non-existent session directory (existsSync guard)", () => {
    const result = getSessionFilePathsSince("/nonexistent-session-dir-abc123", 7);
    expect(result).toEqual([]);
  });

  it("returns .jsonl files and excludes non-jsonl files", () => {
    const jsonlFile = join(tmpDir, "session.jsonl");
    const nonJsonl = join(tmpDir, "readme.txt");

    writeFileSync(jsonlFile, "{}");
    writeFileSync(nonJsonl, "ignore me");

    // sinceTimestamp = 0 means cutoff is epoch start — all freshly created files pass
    const result = getSessionFilePathsSince(tmpDir, 0, 0);
    expect(result).toContain(jsonlFile);
    expect(result).not.toContain(nonJsonl);
  });

  it("excludes .jsonl files whose mtime is at or before the cutoff", () => {
    const jsonlFile = join(tmpDir, "session.jsonl");
    writeFileSync(jsonlFile, "{}");

    // Use a future cutoff so the just-created file is considered too old
    const futureCutoff = Date.now() + 60_000;
    const result = getSessionFilePathsSince(tmpDir, 0, futureCutoff);
    expect(result).not.toContain(jsonlFile);
  });

  it("excludes .deleted .jsonl files", () => {
    const deleted = join(tmpDir, ".deleted-session.jsonl");
    const normal = join(tmpDir, "normal-session.jsonl");

    writeFileSync(deleted, "{}");
    writeFileSync(normal, "{}");

    const result = getSessionFilePathsSince(tmpDir, 0, 0);
    expect(result).toContain(normal);
    expect(result).not.toContain(deleted);
  });
});
