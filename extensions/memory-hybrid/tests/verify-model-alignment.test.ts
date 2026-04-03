import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";

describe("runVerifyForCli - model alignment warnings (issue #965)", () => {
  let homeDir: string | null = null;

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
    vi.unstubAllEnvs();
  });

  function writeOpenclawFiles(params: {
    agentPrimary: string;
    cronModel: string;
    includePluginLlmDefault?: string;
  }): void {
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-965-"));
    const openclawDir = join(homeDir, ".openclaw");
    const cronDir = join(openclawDir, "cron");
    mkdirSync(cronDir, { recursive: true });

    const root: Record<string, unknown> = {
      agents: { defaults: { model: { primary: params.agentPrimary } } },
    };
    if (params.includePluginLlmDefault) {
      root.plugins = {
        entries: {
          "openclaw-hybrid-memory": {
            config: {
              llm: {
                default: [params.includePluginLlmDefault],
              },
            },
          },
        },
      };
    }

    writeFileSync(join(openclawDir, "openclaw.json"), JSON.stringify(root, null, 2), "utf-8");
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify(
        {
          jobs: [
            {
              id: "hybrid-mem:nightly-distill",
              pluginJobId: "hybrid-mem:nightly-distill",
              name: "Nightly Memory Sweep",
              enabled: true,
              payload: { model: params.cronModel },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    vi.stubEnv("HOME", homeDir);
  }

  function buildCtx(llmDefaultFirst: string) {
    const cfg = hybridConfigSchema.parse({
      mode: "local",
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
      },
      llm: {
        default: [llmDefaultFirst],
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

  it("warns when hybrid-mem cron model provider differs from agents.defaults.model.primary", async () => {
    writeOpenclawFiles({
      agentPrimary: "azure-foundry/gpt-5.4",
      cronModel: "google/gemini-2.5-flash",
      includePluginLlmDefault: "minimax/MiniMax-M2.5",
    });
    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx("minimax/MiniMax-M2.5") as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("Cron vs agent model (issues #963, #965)");
    expect(out).toContain("LiveSessionModelSwitchError");
    expect(out).toContain('Plugin llm.default[0] ("minimax/MiniMax-M2.5") differs');
  });

  it("does not warn when cron model and llm.default align with agents primary provider family", async () => {
    writeOpenclawFiles({
      agentPrimary: "azure-foundry/gpt-5.4",
      cronModel: "azure-foundry/gpt-5.4",
      includePluginLlmDefault: "azure-foundry/gpt-5.4",
    });
    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx("azure-foundry/gpt-5.4") as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).not.toContain("Cron vs agent model (issues #963, #965)");
    expect(out).not.toContain("Plugin llm.default[0]");
  });
});
