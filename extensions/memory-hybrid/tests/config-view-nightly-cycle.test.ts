import { describe, expect, it, vi, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";

import type { HandlerContext } from "../cli/handlers.js";
import { runConfigViewForCli } from "../cli/cmd-config.js";

function makeCtx(enabled: boolean): HandlerContext {
  const cfg = {
    mode: "complete",
    verbosity: "normal",
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: true }, retrievalDirectives: { enabled: true } },
    credentials: { enabled: true },
    procedures: { enabled: true },
    memoryTiering: { enabled: true },
    graph: { enabled: true },
    autoClassify: { enabled: true },
    nightlyCycle: { enabled },
    passiveObserver: { enabled: false },
    reflection: { enabled: true },
    personaProposals: { enabled: false },
    selfCorrection: { enabled: true },
    selfExtension: { enabled: true },
    crystallization: { enabled: true },
    extraction: { extractionPasses: true },
    activeTask: { enabled: true },
    frustrationDetection: { enabled: false },
    crossAgentLearning: { enabled: true },
    toolEffectiveness: { enabled: true },
    documents: { enabled: true },
    provenance: { enabled: true },
    errorReporting: { enabled: false },
    costTracking: { enabled: true },
    queryExpansion: { enabled: true },
  } as unknown as HandlerContext["cfg"];

  return {
    cfg,
    dataDir: ".",
    noEmoji: false,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as HandlerContext["logger"],
  };
}

describe("runConfigViewForCli nightlyCycle output", () => {
  it("shows on when nightlyCycle.enabled is true", () => {
    const logs: string[] = [];
    runConfigViewForCli(makeCtx(true), { log: (line) => logs.push(line) });

    expect(logs.some((l) => l.includes("Nightly dream cycle: on"))).toBe(true);
  });

  it("shows off when nightlyCycle.enabled is false", () => {
    const logs: string[] = [];
    runConfigViewForCli(makeCtx(false), { log: (line) => logs.push(line) });

    expect(logs.some((l) => l.includes("Nightly dream cycle: off"))).toBe(true);
  });
});

const testConfigPath = join(tmpdir(), "test-openclaw-nightly-cycle.json");

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(testConfigPath, { force: true });
  } catch {}
});

it("shows on when raw config has nightlyCycle.enabled = true even if cfg is false", () => {
  const logs: string[] = [];
  // Mock getPluginConfigFromFile by setting env var
  vi.stubEnv("OPENCLAW_CONFIG", testConfigPath);
  writeFileSync(
    testConfigPath,
    JSON.stringify({
      plugins: {
        entries: {
          "openclaw-hybrid-memory": {
            config: {
              nightlyCycle: { enabled: true },
            },
          },
        },
      },
    }),
  );
  runConfigViewForCli(makeCtx(false), { log: (line) => logs.push(line) });
  expect(logs.some((l) => l.includes("Nightly dream cycle: on"))).toBe(true);
});
