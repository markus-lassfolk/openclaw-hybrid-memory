import type { StepResult } from "../maintenance-orchestrator.js";
import { resolveSemanticGuardToken } from "./semantic-outcome.js";
import { ORCHESTRATOR_RUN_SCHEMA_VERSION, type OrchestratorRunSummary } from "./types.js";
import { resolveOrchestratorJobFromEnv, resolveOrchestratorRunIdFromEnv } from "./artifact-paths.js";
import { nowIso } from "../../utils/dates.js";

export function generateOrchestratorRunId(): string {
  const iso = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `orch-${iso}-${Math.floor(Math.random() * 1_000_000)}`;
}

export function toOrchestratorRunSummary(
  result: {
    tierLabel: string;
    steps: StepResult[];
    exitCode: 0 | 1 | 2;
    summaryLine: string;
  },
  meta: {
    runId?: string;
    job?: string;
    startedAt: string;
    finishedAt?: string;
    durationMs: number;
    validation?: unknown;
  },
): OrchestratorRunSummary {
  const counts = {
    ok: result.steps.filter((s) => s.status === "ok").length,
    skipped: result.steps.filter((s) => s.status.startsWith("skipped")).length,
    deferred: result.steps.filter((s) => s.status === "deferred").length,
    failed: result.steps.filter((s) => s.status === "failed" || s.status === "rate_limited").length,
    rateLimited: result.steps.filter((s) => s.status === "rate_limited").length,
  };
  return {
    schemaVersion: ORCHESTRATOR_RUN_SCHEMA_VERSION,
    runId: meta.runId ?? resolveOrchestratorRunIdFromEnv() ?? generateOrchestratorRunId(),
    job: meta.job ?? resolveOrchestratorJobFromEnv(),
    tierLabel: result.tierLabel,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt ?? nowIso(),
    durationMs: meta.durationMs,
    exitCode: result.exitCode,
    summaryLine: result.summaryLine,
    steps: result.steps.map((s) => ({
      name: s.name,
      status: s.status,
      summary: s.summary,
      durationMs: s.durationMs,
      jobRunId: s.jobRunId,
      semanticOutcome: resolveSemanticGuardToken(s.semanticOutcome),
    })),
    counts,
    validation: meta.validation,
  };
}
