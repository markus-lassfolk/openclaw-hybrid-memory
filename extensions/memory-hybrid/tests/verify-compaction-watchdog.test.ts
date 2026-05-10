import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";

describe("runVerifyForCli - compaction model watchdog", () => {
  let homeDir: string | null = null;

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
    vi.unstubAllEnvs();
  });

  function writeOpenclawFiles(compactionModel?: string): void {
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-compaction-"));
    const openclawDir = join(homeDir, ".openclaw");
    const cronDir = join(openclawDir, "cron");
    mkdirSync(cronDir, { recursive: true });

    const defaults: Record<string, unknown> = { model: { primary: "azure-foundry/gpt-5.5" } };
    if (compactionModel) defaults.compaction = { model: compactionModel };
    const root: Record<string, unknown> = { agents: { defaults } };
    writeFileSync(join(openclawDir, "openclaw.json"), JSON.stringify(root, null, 2), "utf-8");
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
    vi.stubEnv("HOME", homeDir);
  }

  function writeOpenclawConfigAt(configPath: string, root: Record<string, unknown>): void {
    const configDir = dirname(configPath);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(configDir, "cron"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(root, null, 2), "utf-8");
    writeFileSync(join(configDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
  }

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

  it("flags inherited GPT-5.5 compaction routing as stronger-than-mini", async () => {
    writeOpenclawFiles();
    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("compaction model watchdog alert (verify)");
    expect(out).toContain("provider=azure-foundry, model=azure-foundry/gpt-5.5");
    expect(out).toContain("reason=GPT-5 class model");
    expect(out).toContain("source=inherited from agents.defaults.model.primary");
  });

  it("does not flag explicit MiniMax M2.7 compaction model", async () => {
    writeOpenclawFiles("minimax/MiniMax-M2.7");
    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("provider=minimax, model=minimax/MiniMax-M2.7");
    expect(out).not.toContain("compaction routing uses a stronger-than-mini model");
  });

  it("honors OPENCLAW_CONFIG_PATH for compaction watchdog resolution", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-compaction-cfg-path-"));
    const externalRoot = join(homeDir, "custom-openclaw-root");
    const configPath = join(externalRoot, "openclaw.json");
    writeOpenclawConfigAt(configPath, {
      agents: { defaults: { model: { primary: "openai/gpt-4.1" } } },
    });

    vi.stubEnv("HOME", join(homeDir, "ignored-home"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain(`Config source: ${configPath}`);
    expect(out).toMatch(/compaction model watchdog alert \(verify\)|compaction routing uses a stronger-than-mini model/);
    expect(out).toContain("provider=openai, model=openai/gpt-4.1");
  });

  it("surfaces unknown compaction watchdog state when config is invalid JSON", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-compaction-invalid-"));
    const externalRoot = join(homeDir, "custom-openclaw-root");
    const configPath = join(externalRoot, "openclaw.json");
    mkdirSync(externalRoot, { recursive: true });
    mkdirSync(join(externalRoot, "cron"), { recursive: true });
    writeFileSync(configPath, "{ invalid json ", "utf-8");
    writeFileSync(join(externalRoot, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");

    vi.stubEnv("HOME", join(homeDir, "ignored-home"));
    vi.stubEnv("OPENCLAW_CONFIG", configPath);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("could not be read/parsed");
    expect(out).toContain("verify watchdog: compaction routing check is unknown");
    expect(out).toContain("status=unknown");
    expect(out).not.toContain("compaction routing uses a stronger-than-mini model");
  });
});
