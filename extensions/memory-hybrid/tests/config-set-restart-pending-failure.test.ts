/**
 * A failure writing the best-effort restart-pending marker must not be reported as "could not
 * write config" — the actual config file write already succeeded by that point, so telling the
 * caller the change was lost would be misleading.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function testEmbeddingApiKey(): string {
  return `${"sk"}-test-key-that-is-long-enough-to-pass`;
}

describe("runConfigSetForCli restart-pending marker failure isolation", () => {
  let home: string | null = null;

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true });
      home = null;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("still reports ok:true and persists the config change when the restart-pending write fails", async () => {
    home = mkdtempSync(join(tmpdir(), "oc-cfg-restart-fail-"));
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
                config: { embedding: { apiKey: testEmbeddingApiKey(), model: "text-embedding-3-small" } },
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

    // Make the restart-pending marker path a directory so writeFileSync throws EISDIR for it,
    // without touching openclaw.json's own write.
    mkdirSync(join(openclawDir, ".restart-pending.openclaw-hybrid-memory"), { recursive: true });

    const { runConfigSetForCli } = await import("../cli/handlers.js");
    const result = runConfigSetForCli({} as never, "verbosity", "quiet");

    expect(result.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      plugins: { entries: { "openclaw-hybrid-memory": { config: { verbosity?: string } } } };
    };
    expect(raw.plugins.entries["openclaw-hybrid-memory"].config.verbosity).toBe("quiet");
  });
});
