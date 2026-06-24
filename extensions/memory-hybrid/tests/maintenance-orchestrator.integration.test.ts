import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStepGuardTimestampMs } from "../services/cron-guard.js";
import { runMaintenanceOrchestrator } from "../services/maintenance-orchestrator.js";
import type { HybridMemoryConfig } from "../config.js";

function minimalCfg(): HybridMemoryConfig {
  return {
    maintenance: { orchestrator: { rateLimitMaxRetries: 2, llmCooldownBetweenStepsMs: 0 } },
  } as HybridMemoryConfig;
}

describe("maintenance-orchestrator guard integration (#1934)", () => {
  let openclawDir: string;

  afterEach(() => {
    if (openclawDir) rmSync(openclawDir, { recursive: true, force: true });
  });

  it("writes guard file after successful step and skips second run inside guard window", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-int-"));
    let runnerCalls = 0;
    const runners = new Map<string, () => Promise<string>>([
      [
        "compact",
        async () => {
          runnerCalls++;
          return "compact=ok";
        },
      ],
    ]);

    const first = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], force: true, verbose: false, include: ["compact"] },
    );
    expect(first.steps[0]?.status).toBe("ok");
    expect(first.steps[0]?.summary).toContain("compact=ok");
    expect(readStepGuardTimestampMs("compact", openclawDir)).not.toBeNull();
    expect(runnerCalls).toBe(1);

    const second = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], verbose: false, include: ["compact"] },
    );
    expect(second.steps[0]?.status).toBe("skipped_guard");
    expect(runnerCalls).toBe(1);
  });
});
