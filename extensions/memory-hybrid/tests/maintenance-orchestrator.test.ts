import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridMemoryConfig } from "../config.js";
import {
  acquireStepLock,
  hasStepRetryOncePending,
  markStepRetryOnce,
  readStepGuardTimestampMs,
  releaseStepLock,
  writeStepGuardTimestampMs,
} from "../services/cron-guard.js";
import {
  MAINTENANCE_STEPS,
  runMaintenanceOrchestrator,
  toOrchestratorRunSummary,
} from "../services/maintenance-orchestrator.js";

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

  it("registers 59 maintenance steps (includes dream-outcome-probe + dream-run)", () => {
    expect(MAINTENANCE_STEPS.length).toBe(59);
    expect(MAINTENANCE_STEPS.some((s) => s.name === "dream-run")).toBe(true);
    expect(MAINTENANCE_STEPS.some((s) => s.name === "dream-outcome-probe")).toBe(true);
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

  it("bypasses an unexpired guard exactly once when a retry-once marker is pending, then consumes it (#2094)", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    writeStepGuardTimestampMs("prune", Date.now(), openclawDir);
    markStepRetryOnce("prune", openclawDir);
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "ok"]]);

    const first = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], verbose: false, include: ["prune"] },
    );
    const prune = first.steps.find((s) => s.name === "prune");
    expect(prune?.status).toBe("ok");
    expect(hasStepRetryOncePending("prune", openclawDir)).toBe(false);

    // The marker is consumed — a second run inside the same guard window is skipped normally.
    const second = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], verbose: false, include: ["prune"] },
    );
    expect(second.steps.find((s) => s.name === "prune")?.status).toBe("skipped_guard");
  });

  it("consumes a retry-once marker even when the step was already guard-eligible, so it cannot linger stale", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    // No guard timestamp written — the step is naturally eligible without needing the marker.
    markStepRetryOnce("prune", openclawDir);
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "ok"]]);

    await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], verbose: false, include: ["prune"] },
    );

    expect(hasStepRetryOncePending("prune", openclawDir)).toBe(false);
  });

  it("surfaces lock owner metadata (pid/host/held) in the skipped_guard summary when a step is locked (#2031)", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    expect(acquireStepLock("prune", openclawDir)).toBe(true);
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "ok"]]);

    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], verbose: false, include: ["prune"], force: true },
    );

    const prune = result.steps.find((s) => s.name === "prune");
    expect(prune?.status).toBe("skipped_guard");
    expect(prune?.summary).toContain("locked by a concurrent maintenance run");
    expect(prune?.summary).toMatch(/pid=\d+/);
    expect(prune?.summary).toContain(`host=${hostname()}`);
    expect(prune?.summary).toMatch(/held=\d+s/);
  });

  it("re-checks the step guard after the inter-LLM-step cooldown sleep, skipping a step a concurrent run just completed", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    let distillCalls = 0;
    const runners = new Map<string, () => Promise<string>>([
      ["extract-daily", async () => "ok"],
      [
        "distill",
        async () => {
          distillCalls++;
          return "ok";
        },
      ],
    ]);
    const cfg = {
      maintenance: { orchestrator: { rateLimitMaxRetries: 2, llmCooldownBetweenStepsMs: 150 } },
    } as HybridMemoryConfig;

    // Simulate a concurrent maintenance run (a manual CLI invocation, or a double-fired cron
    // trigger) completing "distill" partway through this run's cooldown sleep before "distill".
    const concurrentWrite = setTimeout(() => writeStepGuardTimestampMs("distill", Date.now(), openclawDir), 40);
    try {
      const result = await runMaintenanceOrchestrator(
        { cfg, runners, openclawDir },
        { tiers: ["nightly"], verbose: false, include: ["extract-daily", "distill"] },
      );
      expect(distillCalls).toBe(0);
      expect(result.steps.find((s) => s.name === "distill")?.status).toBe("skipped_guard");
    } finally {
      clearTimeout(concurrentWrite);
    }
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

  it("resets the rate-limit counter after a semantic-outcome-driven failure, not just a thrown one (QA follow-up)", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const rateLimitErr = Object.assign(new Error("429"), { status: 429 });
    let reflectCalls = 0;
    const runners = new Map<string, () => Promise<string>>([
      [
        "distill",
        async () => {
          throw rateLimitErr;
        },
      ],
      // Returns (does not throw) a summary whose semantic token blocks guard advancement —
      // exercises the non-throwing "failed" path that previously never reset the counter.
      ["resolve-contradictions", async () => "matched=1 semantic=partial"],
      [
        "self-correction-run",
        async () => {
          throw rateLimitErr;
        },
      ],
      [
        "reflect",
        async () => {
          reflectCalls++;
          return "ok";
        },
      ],
    ]);
    // rateLimitMaxRetries=2: if the counter incorrectly stays elevated across the semantic-failure
    // step in between, the second rate-limit hit reaches 2 and trips the circuit breaker, deferring
    // "reflect". If the counter correctly resets, two isolated single rate-limit hits never trip it.
    const cfg = {
      maintenance: { orchestrator: { rateLimitMaxRetries: 2, llmCooldownBetweenStepsMs: 0 } },
    } as HybridMemoryConfig;
    const result = await runMaintenanceOrchestrator(
      { cfg, runners, openclawDir },
      {
        tiers: ["nightly"],
        force: true,
        verbose: false,
        include: ["distill", "resolve-contradictions", "self-correction-run", "reflect"],
      },
    );

    expect(result.steps.find((s) => s.name === "resolve-contradictions")?.status).toBe("failed");
    expect(reflectCalls).toBe(1);
    expect(result.steps.find((s) => s.name === "reflect")?.status).toBe("ok");
  });

  it("aborts a hung step past the watchdog timeout instead of hanging the run forever, and releases its lock (#2141)", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    let pruneStarted = false;
    let laterStepRan = false;
    const runners = new Map<string, () => Promise<string>>([
      [
        "prune",
        () => {
          pruneStarted = true;
          // Never settles — simulates a step stuck on a hung network/LLM call with no internal
          // timeout of its own (the reported enrich-entities stall).
          return new Promise<string>(() => {});
        },
      ],
      [
        "self-correction-run",
        async () => {
          laterStepRan = true;
          return "ok";
        },
      ],
    ]);
    // stepTimeoutMinutes is read directly off the (test-constructed) config object, bypassing the
    // integer-minutes parser, so a sub-second value keeps this test fast and non-flaky.
    const cfg = {
      maintenance: { orchestrator: { stepTimeoutMinutes: 0.001, llmCooldownBetweenStepsMs: 0 } },
    } as HybridMemoryConfig;

    const result = await runMaintenanceOrchestrator(
      { cfg, runners, openclawDir },
      { tiers: ["cycle", "nightly"], force: true, verbose: false, include: ["prune", "self-correction-run"] },
    );

    expect(pruneStarted).toBe(true);
    const prune = result.steps.find((s) => s.name === "prune");
    expect(prune?.status).toBe("failed");
    expect(prune?.summary).toMatch(/exceeded max runtime/);
    expect(prune?.summary).toMatch(/watchdog/);
    // The orchestrator must move on to the next step rather than hanging on the abandoned call.
    expect(laterStepRan).toBe(true);
    expect(result.steps.find((s) => s.name === "self-correction-run")?.status).toBe("ok");
    expect(result.exitCode).toBe(1);
    // The step lock must be released on timeout so a subsequent run can retry the step.
    expect(acquireStepLock("prune", openclawDir)).toBe(true);
    releaseStepLock("prune", openclawDir);
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

  it("emits per-step start/complete heartbeat lines when verbose (#2026)", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const infoLines: string[] = [];
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "pruned=1"]]);
    await runMaintenanceOrchestrator(
      {
        cfg: minimalCfg(),
        runners,
        openclawDir,
        logger: { info: (m: string) => infoLines.push(m), warn: () => {} },
      },
      { tiers: ["cycle"], force: true, verbose: true, include: ["prune"] },
    );
    expect(infoLines).toContain("maintenance-orchestrator: prune — start");
    expect(infoLines.some((l) => /^maintenance-orchestrator: prune — complete in \d+s$/.test(l))).toBe(true);
  });

  it("does not emit per-step heartbeat lines when verbose is false (#2026)", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const infoLines: string[] = [];
    const runners = new Map<string, () => Promise<string>>([["prune", async () => "pruned=1"]]);
    await runMaintenanceOrchestrator(
      {
        cfg: minimalCfg(),
        runners,
        openclawDir,
        logger: { info: (m: string) => infoLines.push(m), warn: () => {} },
      },
      { tiers: ["cycle"], force: true, verbose: false, include: ["prune"] },
    );
    expect(infoLines.some((l) => l.includes("prune — start"))).toBe(false);
  });

  it("runs exactly one included step across both tiers and no unrelated steps (#2028 `maintenance run <step>`)", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const called: string[] = [];
    const runners = new Map<string, () => Promise<string>>([
      ["prune", async () => (called.push("prune"), "pruned=1")],
      ["compact", async () => (called.push("compact"), "ok")],
      ["distill", async () => (called.push("distill"), "ok")],
    ]);
    // This mirrors what the `maintenance run prune` CLI delegates to: both tiers, include=[step], force.
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle", "nightly"], force: true, verbose: false, include: ["prune"] },
    );
    expect(called).toEqual(["prune"]);
    expect(result.steps.map((s) => s.name)).toEqual(["prune"]);
    expect(result.steps[0].status).toBe("ok");
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

  it("parses semantic token from analyze-maintenance-logs strict failure", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "analyze-maintenance-logs",
        async () => {
          throw new Error("analyze-maintenance-logs strict findings (steps=3 findings=2 strict=fail semantic=partial)");
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["cycle"], force: true, verbose: false, include: ["analyze-maintenance-logs"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("parses semantic token from lifecycle-sync sync_errors failure", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "lifecycle-sync",
        async () => {
          throw new Error("lifecycle-sync partial failure (matched=1 expiredNow=0 sync_errors=2 semantic=partial)");
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      {
        cfg: {
          ...minimalCfg(),
          lifecycle: { adapters: { github: { enabled: true } } },
        } as HybridMemoryConfig,
        runners,
        openclawDir,
      },
      { tiers: ["cycle"], force: true, verbose: false, include: ["lifecycle-sync"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("parses semantic token from auto-classify batch failure", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "auto-classify",
        async () => {
          throw new Error("auto-classify partial batch failures (reclassified=0/20 batchFailures=2 semantic=partial)");
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      {
        cfg: { ...minimalCfg(), autoClassify: { enabled: true, batchSize: 20 } } as HybridMemoryConfig,
        runners,
        openclawDir,
      },
      { tiers: ["cycle"], force: true, verbose: false, include: ["auto-classify"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("resolve-contradictions degraded backlog is a monitoring signal and does not abort nightly", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const degradedSummary =
      "resolve-contradictions summary mode=auto auto_resolved=0 ambiguous=250 no_progress=1 degraded=1 consecutive=3 consecutive_threshold=3 semantic=monitoring";
    const runners = new Map<string, () => Promise<string>>([
      ["resolve-contradictions", async () => degradedSummary],
      ["entity-mentions-cleanup", async () => "changedFacts=0 rowsScanned=0 removedRows=0 semantic=success"],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      {
        tiers: ["nightly"],
        force: true,
        verbose: false,
        include: ["resolve-contradictions", "entity-mentions-cleanup"],
      },
    );
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.status).toBe("ok");
    expect(result.steps[0]?.semanticOutcome).toBe("monitoring");
    expect(result.steps[1]?.status).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("parses semantic token from scope-promote partial failure", async () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const runners = new Map<string, () => Promise<string>>([
      [
        "scope-promote",
        async () => {
          throw new Error("scope-promote partial failure (promoted=1/3 failed=2 semantic=partial)");
        },
      ],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      { tiers: ["nightly"], force: true, verbose: false, include: ["scope-promote"] },
    );
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.semanticOutcome).toBe("partial");
    expect(result.exitCode).toBe(1);
  });

  it("fails reflect-rules on invalid_response_format instead of tolerating it as a flake (#2043)", async () => {
    // invalid_response_format means the model responded but its output couldn't be parsed — a real
    // pipeline break, not a benign "nothing to extract" case. This used to be waved through as
    // semantic=success (masking the failure); it must now surface as a failed step.
    openclawDir = mkdtempSync(join(tmpdir(), "hm-orch-"));
    const flakeSummary =
      "rulesStored=0 rulesExtracted=0 parse_success=false zero_rules_reason=invalid_response_format status=degraded model_response_chars=128 semantic=success";
    const runners = new Map<string, () => Promise<string>>([
      ["reflect", async () => "patternsStored=1 facts=2 semantic=success"],
      ["reflect-rules", async () => flakeSummary],
      ["reflect-meta", async () => "metaStored=0 status=ok semantic=success"],
    ]);
    const result = await runMaintenanceOrchestrator(
      { cfg: minimalCfg(), runners, openclawDir },
      {
        tiers: ["nightly"],
        force: true,
        verbose: false,
        include: ["reflect", "reflect-rules", "reflect-meta"],
      },
    );
    expect(result.steps).toHaveLength(3);
    const reflectRules = result.steps.find((s) => s.name === "reflect-rules");
    expect(reflectRules?.status).toBe("failed");
    expect(result.steps.find((s) => s.name === "reflect-meta")?.status).toBe("ok");
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
