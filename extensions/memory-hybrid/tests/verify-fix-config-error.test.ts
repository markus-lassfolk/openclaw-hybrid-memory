/**
 * Regression tests for broad-console-log-before-json in cmd-verify (issue #1492).
 *
 * When applying fixes fails (e.g. corrupt config), the error message and JSON config
 * snippet must be routed to the `error` sink (stderr), not the `log` sink (stdout).
 * This keeps machine-readable stdout clean.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";

describe("runVerifyForCli — fix config error routes to error sink not log sink (issue #1492)", () => {
  let homeDir: string | null = null;

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
    vi.unstubAllEnvs();
  });

  function buildCtx() {
    const cfg = hybridConfigSchema.parse({
      mode: "local",
      verbosity: "normal",
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
      },
      llm: {
        default: ["openai/gpt-4.1-mini"],
      },
    });

    return {
      cfg,
      factsDb: {
        count: () => 0,
        getRawDb: () => ({
          prepare: () => ({
            get: () => undefined,
          }),
        }),
      },
      vectorDb: {
        count: () => Promise.resolve(0),
        isLanceDbAvailable: () => true,
        ensureInitialized: () => Promise.resolve(),
        getVectorDim: () => 768,
        isMemoriesVectorSchemaValid: () => true,
      },
      embeddings: {
        dimensions: 768,
        embed: () => Promise.resolve(new Float32Array(768)),
        modelName: "nomic-embed-text",
      },
      credentialsDb: null,
      resolvedSqlitePath: ":memory:",
      resolvedLancePath: "/tmp/test-lance",
      openai: null,
    };
  }

  it("routes error message and JSON config snippet to error sink when fix config parse fails", async () => {
    // Arrange: write a corrupt openclaw.json so JSON.parse throws in the fix path
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-1492-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(join(openclawDir, "openclaw.json"), "{ this is not valid JSON }", "utf-8");
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
    vi.stubEnv("HOME", homeDir);

    const { runVerifyForCli } = await import("../cli/handlers.js");

    const logLines: string[] = [];
    const errLines: string[] = [];
    const sink = {
      log: (m: string) => logLines.push(m),
      error: (m: string) => errLines.push(m),
    };

    try {
      await runVerifyForCli(buildCtx() as never, { fix: true }, sink);
    } catch {
      // may throw due to minimal mock — we only care about sink routing
    }

    const logOut = logLines.join("\n");
    const errOut = errLines.join("\n");

    // The JSON config snippet must NOT appear on the log (stdout) sink
    expect(logOut).not.toContain('"embedding"');
    expect(logOut).not.toContain('"autoCapture"');
    expect(logOut).not.toContain("Could not apply fixes to config");

    // The error message and config snippet must appear on the error (stderr) sink
    expect(errOut).toContain("Could not apply fixes to config");
    expect(errOut).toContain('"embedding"');
    expect(errOut).toContain('"autoCapture"');
  });

  it("stdout (log sink) does not contain raw JSON when fix config parse fails", async () => {
    // Arrange: write a corrupt openclaw.json
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-1492b-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(join(openclawDir, "openclaw.json"), "NOT JSON AT ALL", "utf-8");
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
    vi.stubEnv("HOME", homeDir);

    const { runVerifyForCli } = await import("../cli/handlers.js");

    const logLines: string[] = [];
    const sink = {
      log: (m: string) => logLines.push(m),
      error: (_m: string) => {
        /* discard stderr for this test */
      },
    };

    try {
      await runVerifyForCli(buildCtx() as never, { fix: true }, sink);
    } catch {
      // expected with minimal mock
    }

    const logOut = logLines.join("\n");

    // No raw JSON object should appear on stdout
    const hasJsonFragment = /"autoCapture"|"captureMaxChars"|"fuzzyDedupe"/.test(logOut);
    expect(hasJsonFragment).toBe(false);
  });
});
