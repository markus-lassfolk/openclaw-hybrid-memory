/**
 * config-set accepts JSON for array/object values (e.g. llm.nano, llm.default).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Avoid literal sk-… strings in fixtures (secret scanners / Copilot review). */
function testEmbeddingApiKey(): string {
  return `${"sk"}-test-key-that-is-long-enough-to-pass`;
}

describe("runConfigSetForCli — JSON values for tier lists", () => {
  let home: string | null = null;

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true });
      home = null;
    }
    vi.unstubAllEnvs();
  });

  it("sets llm.default from a JSON array string", async () => {
    home = mkdtempSync(join(tmpdir(), "oc-cfjson-"));
    const openclawDir = join(home, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    const configPath = join(openclawDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            entries: {
              "openclaw-hybrid-memory": {
                config: {
                  embedding: {
                    apiKey: testEmbeddingApiKey(),
                    model: "text-embedding-3-small",
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    vi.stubEnv("HOME", home);

    const { runConfigSetForCli } = await import("../cli/handlers.js");
    const result = runConfigSetForCli(
      {} as never,
      "llm.default",
      '["azure-foundry/gpt-4.1-nano","azure-foundry/gpt-4.1-mini"]',
    );
    expect(result.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      plugins: { entries: { "openclaw-hybrid-memory": { config: { llm: { default: string[] } } } } };
    };
    expect(raw.plugins.entries["openclaw-hybrid-memory"].config.llm.default).toEqual([
      "azure-foundry/gpt-4.1-nano",
      "azure-foundry/gpt-4.1-mini",
    ]);
  });

  it("config-set goalStewardship enabled sets goalStewardship.enabled (object toggle)", async () => {
    home = mkdtempSync(join(tmpdir(), "oc-gs-"));
    const openclawDir = join(home, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    const configPath = join(openclawDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            entries: {
              "openclaw-hybrid-memory": {
                config: {
                  embedding: {
                    apiKey: testEmbeddingApiKey(),
                    model: "text-embedding-3-small",
                  },
                  goalStewardship: { enabled: false },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    vi.stubEnv("HOME", home);

    const { runConfigSetForCli } = await import("../cli/handlers.js");
    const result = runConfigSetForCli({} as never, "goalStewardship", "enabled");
    expect(result.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      plugins: { entries: { "openclaw-hybrid-memory": { config: { goalStewardship: { enabled: boolean } } } } };
    };
    expect(raw.plugins.entries["openclaw-hybrid-memory"].config.goalStewardship.enabled).toBe(true);
  });

  it("config-set/config-mode honor OPENCLAW_HOME instead of always writing to ~/.openclaw (loop iteration 11 regression)", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "oc-custom-home-"));
    const decoyHome = mkdtempSync(join(tmpdir(), "oc-decoy-home-"));
    home = customHome;
    const configPath = join(customHome, "openclaw.json");
    const baseConfig = {
      plugins: {
        entries: {
          "openclaw-hybrid-memory": {
            config: {
              embedding: { apiKey: testEmbeddingApiKey(), model: "text-embedding-3-small" },
              goalStewardship: { enabled: false },
            },
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(baseConfig, null, 2), "utf-8");
    // HOME points somewhere else entirely — the fix must not fall back to it once OPENCLAW_HOME
    // is set, matching the resolution order verify/config-view already use.
    vi.stubEnv("HOME", decoyHome);
    vi.stubEnv("OPENCLAW_HOME", customHome);

    const { runConfigSetForCli, runConfigModeForCli } = await import("../cli/handlers.js");
    const setResult = runConfigSetForCli({} as never, "goalStewardship", "enabled");
    expect(setResult.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      plugins: { entries: { "openclaw-hybrid-memory": { config: { goalStewardship: { enabled: boolean } } } } };
    };
    expect(raw.plugins.entries["openclaw-hybrid-memory"].config.goalStewardship.enabled).toBe(true);
    expect(existsSync(join(decoyHome, ".openclaw", "openclaw.json"))).toBe(false);

    const modeResult = runConfigModeForCli({} as never, "minimal");
    expect(modeResult.ok).toBe(true);
    expect(existsSync(join(decoyHome, ".openclaw", "openclaw.json"))).toBe(false);

    rmSync(decoyHome, { recursive: true, force: true });
  });
});
