/**
 * Registry test: guard-blocking semantic steps stay in sync with validator exports.
 */

import { describe, expect, it } from "vitest";
import { MAINTENANCE_STEPS } from "../services/maintenance-orchestrator.js";
import {
  CROSS_CUTTING_GUARD_FAILURE_CLASSES,
  GUARD_BLOCKING_SEMANTIC_STEP_NAMES,
  isGuardBlockingSemanticIssue,
  MONITORING_ONLY_FAILURE_CLASSES,
  resolveValidateCronExitCode,
  shouldUpdateMaintenanceGuard,
  type ExitValidationResult,
  type MaintenanceTelemetryIssue,
} from "../services/cron-exit-validator.js";

const ORCHESTRATOR_SEMANTIC_GUARD_STEPS = [
  "prune",
  "auto-classify",
  "sensor-sweep",
  "record-storage-sample",
  "analyze-maintenance-logs",
  "lifecycle-sync",
  "passive-observer",
  "active-tasks-maintain",
  "extract-daily",
  "distill",
  "resolve-contradictions",
  "enrich-entities",
  "enrich-entities-deep",
  "extract-implicit",
  "dream-cycle-core",
  "continuous-verification",
  "closed-loop-analysis",
  "cross-agent-learning",
  "tool-effectiveness",
  "crystallization-proposals",
  "self-correction-run",
  "reflect",
  "reflect-rules",
  "reflect-meta",
  "reflect-identity",
  "extract-procedures",
  "extract-directives",
  "extract-reinforcement",
  "generate-auto-skills",
  "repair-vectors",
  "scope-promote",
  "implicit-feedback-collapse",
  "audit-health",
  "crystallization-rescan",
  "generate-proposals",
  "digest-autopilot",
  "consolidate",
  "reembed-vectorless",
  "build-languages",
] as const;

function semanticIssue(stepName: string): MaintenanceTelemetryIssue {
  return {
    jobName: "test-job",
    stepName,
    failureCategory: "semantic_failure",
    failureClass: "test_semantic_failure",
    message: "test",
    semanticStatus: "degraded",
    fingerprint: [`test:${stepName}`],
    guardStateAfter: "not_updated",
  };
}

describe("maintenance validator coverage registry", () => {
  it("lists every orchestrator semantic-guard step in GUARD_BLOCKING_SEMANTIC_STEP_NAMES", () => {
    const registered = new Set<string>(GUARD_BLOCKING_SEMANTIC_STEP_NAMES);
    for (const step of ORCHESTRATOR_SEMANTIC_GUARD_STEPS) {
      if (step === "dream-cycle-core") continue;
      expect(registered.has(step), `missing guard registry entry for ${step}`).toBe(true);
    }
  });

  it("registers only known maintenance step names (plus cross-cutting aliases)", () => {
    const orchestratorNames = new Set(MAINTENANCE_STEPS.map((step) => step.name));
    const aliases = new Set(["maintenance", "cursor", "persona-proposals"]);
    for (const stepName of GUARD_BLOCKING_SEMANTIC_STEP_NAMES) {
      expect(orchestratorNames.has(stepName) || aliases.has(stepName), `unexpected guard step name ${stepName}`).toBe(
        true,
      );
    }
  });

  it("blocks guard for every registered semantic step", () => {
    for (const stepName of GUARD_BLOCKING_SEMANTIC_STEP_NAMES) {
      expect(isGuardBlockingSemanticIssue(semanticIssue(stepName)), stepName).toBe(true);
    }
  });

  it("blocks guard for cross-cutting failure classes", () => {
    for (const failureClass of CROSS_CUTTING_GUARD_FAILURE_CLASSES) {
      expect(
        isGuardBlockingSemanticIssue({
          ...semanticIssue("maintenance"),
          failureClass,
        }),
      ).toBe(true);
    }
  });

  it("does not block guard for non-semantic failure categories", () => {
    expect(
      isGuardBlockingSemanticIssue({
        ...semanticIssue("distill"),
        failureCategory: "mechanical_failure",
      }),
    ).toBe(false);
  });

  it("does not block guard for monitoring-only failure classes", () => {
    for (const failureClass of MONITORING_ONLY_FAILURE_CLASSES) {
      expect(
        isGuardBlockingSemanticIssue({
          ...semanticIssue("resolve-contradictions"),
          failureClass,
        }),
      ).toBe(false);
    }
  });

  it("shouldUpdateMaintenanceGuard allows guard update when only monitoring issues remain", () => {
    expect(
      shouldUpdateMaintenanceGuard("success", [
        {
          ...semanticIssue("resolve-contradictions"),
          failureClass: "resolve_contradictions_degraded_backlog",
        },
      ]),
    ).toBe(true);
  });

  it("resolveValidateCronExitCode distinguishes semantic-only failures from mechanical ones", () => {
    const semanticOnly: ExitValidationResult = {
      maintenanceStatus: "failed",
      semanticStatus: "semantic_fail",
      steps: [{ timestamp: "2026-01-01T00:00:00Z", step: "reflect-rules", exitCode: 0, line: "2026-01-01T00:00:00Z reflect-rules exit=0" }],
      missingSteps: [],
      failedSteps: [],
      guardUpdated: false,
      exitPath: "/tmp/test.exit.txt",
      reportableIssues: [semanticIssue("reflect-rules")],
    };
    const mechanical: ExitValidationResult = {
      ...semanticOnly,
      failedSteps: [{ timestamp: "2026-01-01T00:00:00Z", step: "distill", exitCode: 1, line: "2026-01-01T00:00:00Z distill exit=1" }],
      reportableIssues: [],
    };
    const partial: ExitValidationResult = {
      ...semanticOnly,
      maintenanceStatus: "partial",
      missingSteps: ["distill"],
      reportableIssues: [],
    };

    expect(resolveValidateCronExitCode(semanticOnly)).toBe(2);
    expect(resolveValidateCronExitCode(mechanical)).toBe(1);
    expect(resolveValidateCronExitCode(partial)).toBe(1);
  });
});
