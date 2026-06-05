import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAINTENANCE_STEPS,
  getMaintenanceStep,
  resolveStepGuardIntervalMs,
  runMaintenanceOrchestrator,
  toOrchestratorRunSummary,
} from "../services/maintenance-orchestrator.js";
import { readStepGuardTimestampMs, writeStepGuardTimestampMs } from "../services/cron-guard.js";
import type { HybridMemoryConfig } from "../config.js";

function minimalCfg(): HybridMemoryConfig {
  return {
    maintenance: { orchestrator: { rateLimitMaxRetries: 2, llmCooldownBetweenStepsMs: 0 } },
  } as HybridMemoryConfig;
}

describe("maintenance-orchestrator", () => {
  let openclawDir: string;

  afterEach(() => {
    if (openclawDir) rmSync(openclawDir, { recursive: true, force: true });
  });

  it("registers 48 maintenance steps", () => {
    expect(MAINTENANCE_STEPS.length).toBe(48);
  });

  it("skips steps when guard has not expired", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    writeStepGuardTimestampMs("prune", Date.now(), openclawDir);
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "ok"]]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], verbose: false, include: ["prune"] },
    );
    const prune = result.steps.find((s) => s.name === "prune");
    expect(prune?.status).toBe("skipped_guard");
    expect(result.exitCode).toBe(0);
  });

  it("defers remaining LLM steps after consecutive rate limits", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    let distillCalls = 0;
    const rateLimitErr = Object.assign(new Error("429"), { status: 429 });
    const runners = new Map<string, () => Promise<string>>([
      [
        "distill",
        async () => {
          distillCalls++;
          throw rateLimitErr;
        },
      ],
      [
        "self-correction-run",
        async () => {
          throw new Error("should not run");
        },
      ],
    ]);
    const cfg = {
      maintenance: { orchestrator: { rateLimitMaxRetries: 1, llmCooldownBetweenStepsMs: 0 } },
    } as HybridMemoryConfig;
    const result = await runMaintenanceOrchestrator(
      { cfg, runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["distill", "self-correction-run"] },
    );
    expect(distillCalls).toBe(1);
    expect(result.steps.find((s) => s.name === "self-correction-run")?.status).toBe("deferred");
    expect(result.exitCode).toBe(2);
  });

  it("respects dependency gates", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([["reflect-rules", async () => "ok"]]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["reflect-rules"] },
    );
    expect(result.steps[0]?.status).toBe("skipped_dep");
  });

  it("runs dependent steps after prerequisite completes in the same run", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const order: string[] = [];
    const runners = new Map<string, () => Promise<string>>([
      [
        "reflect",
        async () => {
          order.push("reflect");
          return "reflected=1";
        },
      ],
      [
        "reflect-rules",
        async () => {
          order.push("reflect-rules");
          return "rules=2";
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["reflect", "reflect-rules"] },
    );
    expect(order).toEqual(["reflect", "reflect-rules"]);
    expect(result.steps.find((s) => s.name === "reflect-rules")?.status).toBe("ok");
  });

  it("builds orchestrator run summary with run metadata", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "pruned=1"]]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], force: true, verbose: false, include: ["prune"] },
    );
    expect(result.runId).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const summary = toOrchestratorRunSummary(result, {
      runId: result.runId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
    });
    expect(summary.schemaVersion).toBe(1);
    expect(summary.steps).toHaveLength(1);
    expect(summary.counts.ok).toBe(1);
  });

  it("writes step guard on success", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "done"]]);
    await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], force: true, verbose: false, include: ["prune"] },
    );
    expect(readStepGuardTimestampMs("prune", openclawDir)).not.toBeNull();
  });

  it("skips backfill-decay when one-time marker exists", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    let calls = 0;
    const runners = new Map<string, () => Promise<string>>([
      [
        "backfill-decay",
        async () => {
          calls++;
          return "backfilled=1";
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      {
        cfg: minimalCfg(),
        runners,
        openclawDir,
        oneTimeMarkerExists: () => true,
      },
      { tiers: ["nightly"], force: true, verbose: false, include: ["backfill-decay"] },
    );
    expect(calls).toBe(0);
    expect(result.steps[0]?.status).toBe("skipped_guard");
  });

  it("runs prune when backfill marker exists", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    let pruneCalls = 0;
    const runners = new Map<string, () => Promise<string>>([
      ["prune", async () => {
        pruneCalls++;
        return "pruned=3";
      }],
    ]);
    const result = await runMaintenanceOrchestrator(
      {
        cfg: minimalCfg(),
        runners,
        openclawDir,
        oneTimeMarkerExists: () => true,
      },
      { tiers: ["cycle"], force: true, verbose: false, include: ["prune"] },
    );
    expect(pruneCalls).toBe(1);
    expect(result.steps[0]?.summary).toContain("pruned=3");
  });
});

describe("cron-guard step helpers", () => {
  let openclawDir: string;
  afterEach(() => {
    if (openclawDir) rmSync(openclawDir, { recursive: true, force: true });
  });

  it("read/write step guard roundtrip", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const ts = Date.now();
    writeStepGuardTimestampMs("distill", ts, openclawDir);
    expect(readStepGuardTimestampMs("distill", openclawDir)).toBe(ts);
  });

  it("uses passiveObserver.intervalMinutes for passive-observer guard", () => {
    const step = getMaintenanceStep("passive-observer");
    expect(step).toBeTruthy();
    const cfg = {
      passiveObserver: { enabled: true, intervalMinutes: 15 },
    } as HybridMemoryConfig;
    expect(resolveStepGuardIntervalMs(step!, cfg)).toBe(15 * 60 * 1000);
  });
});
