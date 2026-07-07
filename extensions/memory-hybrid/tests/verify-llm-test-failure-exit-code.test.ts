/**
 * Regression test (loop iteration 73): `verify --test-llm` ran live tests against every
 * configured LLM model and displayed per-row Success/Failed results in the table, but a failure
 * never affected `state.allOk`, `state.issues`, or the process exit code — unlike the parallel
 * embeddings `--test-llm` check, which does gate `allOk`/`process.exitCode` on `anyEmbOk`. A CI
 * or automation script gating on `openclaw hybrid-mem verify --test-llm`'s exit code would
 * silently pass even when every configured model actually failed to respond.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";

describe("runVerifyForCli --test-llm exit code (loop iteration 73 regression)", () => {
  let homeDir: string | null = null;

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  function setupHome(): void {
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-test-llm-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(
      join(openclawDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-4.1-mini" } } } }, null, 2),
    );
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
    vi.stubEnv("HOME", homeDir);
  }

  function buildCtx() {
    const cfg = hybridConfigSchema.parse({
      mode: "local",
      verbosity: "normal",
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
      // Configured model has a valid-looking API key (so it's actually tested) but an unreachable
      // baseURL, so the live chat completion call fails fast and deterministically (connection
      // refused) instead of depending on real network access.
      llm: {
        default: ["openai/gpt-4.1-mini"],
        providers: { openai: { apiKey: "sk-test-key-not-real-1234567890", baseURL: "http://127.0.0.1:1" } },
      },
    });
    return {
      cfg,
      factsDb: {
        count: () => 0,
        getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }),
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

  it("sets process.exitCode and pushes an issue when every configured model fails --test-llm", async () => {
    setupHome();
    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false, testLlm: true }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("All configured LLM models failed --test-llm");
    expect(out).not.toContain("All checks passed.");
    expect(process.exitCode).toBe(1);
  }, 20000);

  it("does not fail the run over unreachable LLM credentials when --test-llm is not passed", async () => {
    setupHome();
    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false, testLlm: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).not.toContain("All configured LLM models failed --test-llm");
    expect(out).toContain("All checks passed.");
    expect(process.exitCode).toBeUndefined();
  });
});
