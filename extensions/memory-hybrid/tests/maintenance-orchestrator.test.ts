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

  it("does not write step guard when runner reports failing semantic outcome", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      ["distill", async () => "stored=0 sessions=0 jobRunId=abc semantic=failed_semantic_empty"],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["distill"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(readStepGuardTimestampMs("distill", openclawDir)).toBeNull();
  });

  it("does not write step guard when runner reports legacy failed_partial semantic token", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      ["self-correction-run", async () => "incidents=2 analysed=1 jobRunId=abc semantic=failed_partial"],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["self-correction-run"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(readStepGuardTimestampMs("self-correction-run", openclawDir)).toBeNull();
  });

  it("does not write step guard when runner reports legacy failed_suspect_zero_parsed semantic token", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      ["self-correction-run", async () => "incidents=3 analysed=0 jobRunId=abc semantic=failed_suspect_zero_parsed"],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["self-correction-run"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(readStepGuardTimestampMs("self-correction-run", openclawDir)).toBeNull();
  });

  it("returns exit code 1 for partial semantic token in runner summary", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      ["distill", async () => "stored=1 sessions=2 jobRunId=abc semantic=partial"],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["distill"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.exitCode).toBe(1);
  });

  it("parses semantic token from thrown runner error for summary metadata", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "reembed-vectorless",
        async () => {
          throw new Error("reembed-vectorless partial failure (embedded=0/1 failures=1 semantic=partial)");
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["reembed-vectorless"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("parses semantic token from repair-vectors orphan cleanup partial failure", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "repair-vectors",
        async () => {
          throw new Error(
            "repair-vectors partial vector cleanup failure (reembedded=1/1 failures=0 orphans=2 orphan_cleanup_failed=1 semantic=partial)",
          );
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["repair-vectors"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("parses semantic token from active-tasks-maintain partial failure", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "active-tasks-maintain",
        async () => {
          throw new Error(
            "active-tasks-maintain partial failure (status=partial reconciled=2 failed=1 semantic=partial)",
          );
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], force: true, verbose: false, include: ["active-tasks-maintain"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("parses semantic token from passive-observer error summary", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "passive-observer",
        async () => {
          throw new Error("passive-observer errors=2 (stored=1 scanned=3 errors=2 semantic=partial)");
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      {
        cfg: { ...minimalCfg(), passiveObserver: { enabled: true } } as HybridMemoryConfig,
        runners,
        openclawDir,
      },
      { tiers: ["cycle"], force: true, verbose: false, include: ["passive-observer"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("fails reflect-rules when runner summary has parse_success=false without semantic token", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      ["reflect", async () => "patternsStored=1 facts=2"],
      [
        "reflect-rules",
        async () =>
          "rulesStored=0 rulesExtracted=0 parse_success=false zero_rules_reason=all_candidates_rejected status=partial",
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["reflect", "reflect-rules"] },
    );
    const reflectRules = result.steps.find((s) => s.name === "reflect-rules");
    expect(reflectRules?.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(readStepGuardTimestampMs("reflect-rules", openclawDir)).toBeNull();
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
      [
        "prune",
        async () => {
          pruneCalls++;
          return "pruned=3";
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
