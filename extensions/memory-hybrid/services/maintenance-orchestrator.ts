/**
 * Hybrid maintenance orchestrator — guard-driven step registry and tier runner.
 * Cycle tier: gateway-native tick. Nightly tier: consolidated cron + CLI.
 */

import type { DatabaseSync } from "node:sqlite";
import type { HybridMemoryConfig } from "../config.js";
import { nowIso } from "../utils/dates.js";
import {
  clearMaintenanceRunDeadline,
  maintenanceRunDeadlineReached,
  remainingMaintenanceRunMs,
  setMaintenanceRunDeadlineMs,
} from "../utils/maintenance-run-deadline.js";
import { is429OrWrapped } from "./chat.js";
import {
  acquireStepLock,
  formatStepLockDetail,
  readStepGuardTimestampMs,
  readStepLockInfo,
  releaseStepLock,
  stepGuardEligible,
  writeStepGuardTimestampMs,
} from "./cron-guard.js";
import { recordMaintenanceStepRun } from "./maintenance-audit-journal.js";
import { generateOrchestratorRunId } from "./maintenance-job-run/orchestrator-summary.js";
import {
  parseSemanticTokenFromSummary,
  reflectRulesStepSummaryIndicatesFailure,
  semanticOutcomeBlocksOrchestratorGuard,
} from "./maintenance-job-run/semantic-outcome.js";
import type { JobRunSemanticOutcome } from "./maintenance-job-run/types.js";

export type StepTier = "cycle" | "nightly";
export type StepLlmTier = "none" | "nano" | "maintenance" | "default" | "heavy" | "embed" | "local";

export type StepStatus =
  | "ok"
  | "skipped_guard"
  | "skipped_gate"
  | "skipped_dep"
  | "skipped_missing_runner"
  | "deferred"
  | "failed"
  | "rate_limited";

export interface StepResult {
  name: string;
  status: StepStatus;
  summary: string;
  durationMs: number;
  jobRunId?: string;
  semanticOutcome?: string;
}

export interface MaintenanceStepDef {
  name: string;
  tier: StepTier;
  guardIntervalMs: number;
  llmTier: StepLlmTier;
  /** When false, step is skipped unless feature gate passes. */
  featureGate?: (cfg: HybridMemoryConfig) => boolean;
  /** Step names that must have run at least once (guard file exists). */
  dependsOn?: string[];
  /** One-time marker path check — skip if marker exists. */
  oneTimeMarkerPath?: string;
}

export interface OrchestratorRunOptions {
  tiers: StepTier[];
  force?: boolean;
  dryRun?: boolean;
  include?: string[];
  exclude?: string[];
  maxRuntimeMs?: number;
  verbose?: boolean;
  openclawDir?: string;
}

export interface MaintenanceOrchestratorResult {
  tierLabel: string;
  steps: StepResult[];
  exitCode: 0 | 1 | 2;
  summaryLine: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export type MaintenanceStepRunner = () => Promise<string>;

export interface MaintenanceOrchestratorContext {
  cfg: HybridMemoryConfig;
  openclawDir?: string;
  runners: Map<string, MaintenanceStepRunner>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  oneTimeMarkerExists?: (markerPath: string) => boolean;
  /** When set, each step attempt is recorded in maintenance_runs (#1913). */
  journalDb?: DatabaseSync;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Default staggered guard intervals. */
export const MAINTENANCE_GUARD_INTERVALS = {
  h1: HOUR_MS,
  h3: 3 * HOUR_MS,
  h20: 20 * HOUR_MS,
  h44: 44 * HOUR_MS,
  h68: 68 * HOUR_MS,
  d5: 5 * DAY_MS,
  d25: 25 * DAY_MS,
  oneTime: 0,
} as const;

export const MAINTENANCE_STEPS: MaintenanceStepDef[] = [
  // --- Cycle tier (10) ---
  { name: "prune", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h1, llmTier: "none" },
  { name: "compact", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "none" },
  {
    // Use-it-or-lose-it for Hebbian RELATED_TO links: the counterpart to graph.strengthenOnRecall,
    // so co-recall bonding shapes the graph without saturating every edge at 1.0.
    name: "link-decay",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "none",
    featureGate: (cfg) => cfg.graph?.enabled !== false && cfg.graph?.linkDecay?.enabled !== false,
  },
  {
    name: "auto-classify",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "nano",
    featureGate: (cfg) => cfg.autoClassify?.enabled === true,
  },
  {
    name: "sensor-sweep",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h3,
    llmTier: "none",
    featureGate: (cfg) => cfg.sensorSweep?.enabled === true,
  },
  { name: "record-storage-sample", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "none" },
  {
    name: "analyze-maintenance-logs",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "none",
  },
  {
    name: "lifecycle-sync",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "none",
    featureGate: (cfg) => cfg.lifecycle?.adapters?.github?.enabled === true,
  },
  {
    name: "passive-observer",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "none",
    featureGate: (cfg) => cfg.passiveObserver?.enabled === true,
  },
  {
    name: "proposals-prune",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "none",
    featureGate: (cfg) => cfg.personaProposals?.enabled !== false,
  },
  {
    name: "build-languages",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "nano",
    featureGate: (cfg) => cfg.languageKeywords?.autoBuild === true,
  },
  {
    name: "credentials-prune",
    tier: "cycle",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "none",
    featureGate: (cfg) => cfg.credentials?.enabled === true,
  },
  { name: "active-tasks-maintain", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "none" },
  { name: "evolution-pass", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "none" },
  { name: "per-folder-context", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "none" },

  // --- Nightly tier — staggered (14) ---
  { name: "extract-daily", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "nano" },
  {
    name: "distill",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "default",
    featureGate: (cfg) => (cfg.distill as { enabled?: boolean } | undefined)?.enabled !== false,
  },
  {
    name: "resolve-contradictions",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h44,
    llmTier: "local",
  },
  {
    name: "enrich-entities",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h44,
    llmTier: "nano",
    featureGate: (cfg) => cfg.graph?.enabled !== false,
  },
  {
    name: "extract-implicit",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h44,
    llmTier: "local",
    featureGate: (cfg) => cfg.implicitFeedback?.enabled !== false,
  },
  {
    name: "entity-mentions-cleanup",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68,
    llmTier: "none",
  },
  {
    name: "dream-cycle-core",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68,
    llmTier: "default",
    featureGate: (cfg) => cfg.nightlyCycle?.enabled === true,
  },
  {
    name: "continuous-verification",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h44,
    llmTier: "local",
    featureGate: (cfg) => cfg.verification?.enabled === true && cfg.verification?.continuousVerification === true,
  },
  {
    name: "closed-loop-analysis",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68,
    llmTier: "local",
    featureGate: (cfg) => cfg.closedLoop?.enabled !== false && cfg.closedLoop?.runInNightlyCycle !== false,
  },
  {
    name: "cross-agent-learning",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68,
    llmTier: "local",
    featureGate: (cfg) =>
      cfg.crossAgentLearning?.enabled === true && cfg.crossAgentLearning?.runInNightlyCycle !== false,
  },
  {
    name: "tool-effectiveness",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68,
    llmTier: "local",
    featureGate: (cfg) =>
      cfg.toolEffectiveness?.enabled !== false && cfg.toolEffectiveness?.runInNightlyCycle !== false,
  },
  {
    name: "crystallization-proposals",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68,
    llmTier: "local",
    featureGate: (cfg) => cfg.crystallization?.enabled === true,
  },
  {
    name: "cost-log-prune",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68,
    llmTier: "none",
    featureGate: (cfg) => cfg.costTracking?.enabled !== false && cfg.costTracking?.pruneInNightlyCycle !== false,
  },
  { name: "self-correction-run", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h44, llmTier: "heavy" },

  // --- Nightly tier — weekly cadence (5d guards) (18) ---
  { name: "reflect", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "maintenance" },
  {
    name: "reflect-rules",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "maintenance",
    dependsOn: ["reflect"],
  },
  {
    name: "reflect-meta",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "maintenance",
    dependsOn: ["reflect"],
  },
  {
    name: "reflect-identity",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "default",
    dependsOn: ["reflect-rules", "reflect-meta"],
    featureGate: (cfg) => cfg.identityReflection?.enabled !== false,
  },
  { name: "extract-procedures", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "local" },
  { name: "extract-directives", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "embed" },
  {
    name: "extract-reinforcement",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "maintenance",
  },
  {
    name: "generate-auto-skills",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "local",
    dependsOn: ["extract-procedures"],
  },
  { name: "repair-vectors", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "embed" },
  { name: "vectordb-optimize", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "none" },
  { name: "scope-promote", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "none" },
  { name: "decay-reclassify", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d25, llmTier: "none" },
  {
    name: "implicit-feedback-collapse",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "none",
  },
  { name: "audit-health", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "none" },
  {
    name: "crystallization-rescan",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "none",
    featureGate: (cfg) => cfg.crystallization?.enabled === true,
  },
  {
    name: "generate-proposals",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "heavy",
    dependsOn: ["reflect"],
    featureGate: (cfg) => cfg.personaProposals?.enabled !== false,
  },
  { name: "pending-digest", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "none" },
  {
    name: "digest-autopilot",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5,
    llmTier: "none",
    dependsOn: ["pending-digest"],
    featureGate: (cfg) => cfg.digest?.autopilot?.enabled === true,
  },

  // --- Nightly tier — monthly cadence (25d guards) (4) ---
  { name: "consolidate", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d25, llmTier: "default" },
  {
    name: "backfill-decay",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.oneTime,
    llmTier: "none",
    oneTimeMarkerPath: ".backfill-decay-done",
  },
  { name: "reembed-vectorless", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d25, llmTier: "embed" },
  {
    name: "enrich-entities-deep",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d25,
    llmTier: "nano",
    featureGate: (cfg) => cfg.graph?.enabled !== false,
  },
];

export function getMaintenanceStep(name: string): MaintenanceStepDef | undefined {
  return MAINTENANCE_STEPS.find((s) => s.name === name);
}

export function listMaintenanceSteps(filter?: { tier?: StepTier }): MaintenanceStepDef[] {
  if (!filter?.tier) return [...MAINTENANCE_STEPS];
  return MAINTENANCE_STEPS.filter((s) => s.tier === filter.tier);
}

export function resolveStepGuardIntervalMs(step: MaintenanceStepDef, cfg: HybridMemoryConfig): number {
  const override = cfg.maintenance?.orchestrator?.stepGuards?.[step.name];
  if (typeof override === "number" && override > 0) return override;
  if (step.name === "passive-observer") {
    const intervalMin = cfg.passiveObserver?.intervalMinutes;
    if (typeof intervalMin === "number" && intervalMin > 0) {
      return Math.max(5 * 60 * 1000, intervalMin * 60 * 1000);
    }
  }
  return step.guardIntervalMs;
}

export function effectiveCadenceLabel(guardMs: number): string {
  if (guardMs <= 0) return "one-time";
  if (guardMs <= MAINTENANCE_GUARD_INTERVALS.h20) return "every night";
  if (guardMs <= MAINTENANCE_GUARD_INTERVALS.h44) return "~every other night";
  if (guardMs <= MAINTENANCE_GUARD_INTERVALS.h68) return "~every 3rd night";
  if (guardMs <= MAINTENANCE_GUARD_INTERVALS.d5) return "weekly";
  if (guardMs <= MAINTENANCE_GUARD_INTERVALS.d25) return "monthly";
  return `${Math.round(guardMs / HOUR_MS)}h`;
}

function isLlmProviderStep(tier: StepLlmTier): boolean {
  return tier === "nano" || tier === "maintenance" || tier === "default" || tier === "heavy" || tier === "embed";
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return is429OrWrapped(err);
}

function dependenciesMet(step: MaintenanceStepDef, completedThisRun: Set<string>, openclawDir?: string): boolean {
  if (!step.dependsOn?.length) return true;
  // dependsOn documents "must have run at least once (guard file exists)" — not "must also run
  // in this same orchestrator invocation." completedThisRun alone wrongly marks dependent steps
  // skipped_dep forever whenever they're targeted without their dependency in the same run (e.g.
  // `--include reflect-rules` alone, or the dependency being excluded/gated/deferred this cycle),
  // even though the dependency ran successfully yesterday and its output still exists.
  return step.dependsOn.every(
    (dep) => completedThisRun.has(dep) || readStepGuardTimestampMs(dep, openclawDir) !== null,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDurationSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatMaintenanceSummary(
  tierLabel: string,
  results: StepResult[],
): { summaryLine: string; lines: string[] } {
  const counts = {
    ok: results.filter((r) => r.status === "ok").length,
    skipped: results.filter((r) => r.status.startsWith("skipped")).length,
    deferred: results.filter((r) => r.status === "deferred").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "rate_limited").length,
  };
  const summaryLine = `Maintenance ${tierLabel} — ${results.length} steps (${counts.ok} ok, ${counts.skipped} skipped, ${counts.deferred} deferred, ${counts.failed} failed)`;
  const lines = results.map((r) => {
    const name = r.name.padEnd(28);
    const status = r.status.padEnd(14);
    return `  ${name} ${status} ${formatDurationSec(r.durationMs).padStart(7)}   ${r.summary}`;
  });
  return { summaryLine, lines };
}

function parseStepRunnerMetadata(summary: string): Pick<StepResult, "jobRunId" | "semanticOutcome"> {
  const jobRunId = summary.match(/jobRunId=([\w-]+)/)?.[1];
  const semantic = parseSemanticTokenFromSummary(summary);
  return {
    jobRunId: jobRunId && jobRunId !== "-" ? jobRunId : undefined,
    semanticOutcome: semantic,
  };
}

function resolveStepSemanticOutcome(step: StepResult): string | undefined {
  return step.semanticOutcome ?? parseSemanticTokenFromSummary(step.summary);
}

function computeExitCode(results: StepResult[]): 0 | 1 | 2 {
  if (results.some((r) => r.status === "failed")) return 1;
  // Check unified + legacy semantic tokens even when a runner returned ok without throwing.
  if (results.some((r) => semanticOutcomeBlocksOrchestratorGuard(resolveStepSemanticOutcome(r)))) return 1;
  if (results.some((r) => r.name === "reflect-rules" && reflectRulesStepSummaryIndicatesFailure(r.summary))) {
    return 1;
  }
  if (results.some((r) => r.status === "deferred" || r.status === "rate_limited")) return 2;
  return 0;
}

function stepSemanticBlocksGuard(semantic?: string): boolean {
  return semanticOutcomeBlocksOrchestratorGuard(semantic);
}

/** Heartbeat cadence for per-step progress lines during long CPU/LLM-bound steps (#2026). */
const ORCHESTRATOR_STEP_HEARTBEAT_MS = 60_000;

/**
 * Run a maintenance step while emitting per-step start/heartbeat/finish lines (#2026).
 *
 * Long CPU- or LLM-bound steps (e.g. distill, dream-cycle, self-correction) previously ran
 * log-silent for minutes, making a live run indistinguishable from a hung one to operators and
 * the stale-run detector. This wrapper emits:
 *   - `maintenance-orchestrator: <step> — start`
 *   - `maintenance-orchestrator: <step> — still running after <N>s` every ORCHESTRATOR_STEP_HEARTBEAT_MS
 *   - `maintenance-orchestrator: <step> — complete in <N>s`
 *
 * The lines advance the wrapper-log mtime (resetting the analyzer's staleness signal) and match the
 * analyzer's progress/still-running regexes, so a live step is classified as running rather than stale.
 */
async function runStepWithHeartbeat<T>(
  stepName: string,
  emit: boolean,
  logger: MaintenanceOrchestratorContext["logger"],
  fn: () => Promise<T>,
): Promise<T> {
  if (!emit || !logger?.info) return fn();
  const started = Date.now();
  logger.info(`maintenance-orchestrator: ${stepName} — start`);
  const heartbeat = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - started) / 1000);
    logger.info?.(`maintenance-orchestrator: ${stepName} — still running after ${elapsedSec}s`);
  }, ORCHESTRATOR_STEP_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const result = await fn();
    const elapsedSec = Math.floor((Date.now() - started) / 1000);
    logger.info?.(`maintenance-orchestrator: ${stepName} — complete in ${elapsedSec}s`);
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runMaintenanceOrchestrator(
  ctx: MaintenanceOrchestratorContext,
  options: OrchestratorRunOptions,
): Promise<MaintenanceOrchestratorResult> {
  const { cfg, runners, logger } = ctx;
  const openclawDir = options.openclawDir ?? ctx.openclawDir;
  const orchestratorCfg = cfg.maintenance?.orchestrator;
  const llmCooldownMs = orchestratorCfg?.llmCooldownBetweenStepsMs ?? 30_000;
  const rateLimitMaxRetries = orchestratorCfg?.rateLimitMaxRetries ?? 2;
  const startedAtMs = Date.now();
  const startedAtIso = nowIso();
  const runId =
    process.env.HM_RUN_ID?.trim() || process.env.HM_ORCHESTRATOR_RUN_ID?.trim() || generateOrchestratorRunId();
  if (!process.env.HM_ORCHESTRATOR_RUN_ID) {
    process.env.HM_ORCHESTRATOR_RUN_ID = runId;
  }
  const maxRuntimeMs =
    options.maxRuntimeMs ??
    (orchestratorCfg?.maxRuntimeMinutes ? orchestratorCfg.maxRuntimeMinutes * 60_000 : undefined);
  const runDeadlineMs = maxRuntimeMs != null ? startedAtMs + maxRuntimeMs : undefined;

  let steps = MAINTENANCE_STEPS.filter((s) => options.tiers.includes(s.tier));
  if (options.include?.length) {
    const includeSet = new Set(options.include);
    steps = steps.filter((s) => includeSet.has(s.name));
  }
  if (options.exclude?.length) {
    const excludeSet = new Set(options.exclude);
    steps = steps.filter((s) => !excludeSet.has(s.name));
  }

  const tierLabel = options.tiers.length === 1 ? options.tiers[0]! : "full";
  const results: StepResult[] = [];
  const completedThisRun = new Set<string>();
  let consecutiveRateLimitErrors = 0;
  let deferRemainingLlm = false;
  let lastWasLlmStep = false;

  const pushStepResult = (result: StepResult): void => {
    results.push(result);
    if (ctx.journalDb) {
      try {
        recordMaintenanceStepRun(ctx.journalDb, result);
      } catch (err) {
        logger?.warn?.(
          `maintenance-orchestrator: journal write failed for ${result.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  setMaintenanceRunDeadlineMs(runDeadlineMs);
  try {
    for (const step of steps) {
      if (maxRuntimeMs !== undefined && Date.now() - startedAtMs >= maxRuntimeMs) {
        pushStepResult({
          name: step.name,
          status: "deferred",
          summary: "time budget exceeded",
          durationMs: 0,
        });
        continue;
      }

      if (step.featureGate && !step.featureGate(cfg)) {
        pushStepResult({
          name: step.name,
          status: "skipped_gate",
          summary: "feature disabled",
          durationMs: 0,
        });
        continue;
      }

      if (step.oneTimeMarkerPath && ctx.oneTimeMarkerExists?.(step.oneTimeMarkerPath)) {
        pushStepResult({
          name: step.name,
          status: "skipped_guard",
          summary: "one-time marker exists",
          durationMs: 0,
        });
        continue;
      }

      if (!dependenciesMet(step, completedThisRun, openclawDir)) {
        pushStepResult({
          name: step.name,
          status: "skipped_dep",
          summary: `waiting for ${step.dependsOn?.join(", ")} in this run`,
          durationMs: 0,
        });
        continue;
      }

      const guardMs = resolveStepGuardIntervalMs(step, cfg);
      if (!options.force && guardMs > 0) {
        const guard = stepGuardEligible(step.name, guardMs, openclawDir);
        if (!guard.eligible) {
          const agoH = guard.lastRunMs ? Math.round((Date.now() - guard.lastRunMs) / HOUR_MS) : 0;
          pushStepResult({
            name: step.name,
            status: "skipped_guard",
            summary: `guard (ran ${agoH}h ago)`,
            durationMs: 0,
          });
          continue;
        }
      }

      const runner = runners.get(step.name);
      if (!runner) {
        pushStepResult({
          name: step.name,
          status: "skipped_missing_runner",
          summary: "no runner registered",
          durationMs: 0,
        });
        continue;
      }

      if (deferRemainingLlm && isLlmProviderStep(step.llmTier)) {
        pushStepResult({
          name: step.name,
          status: "deferred",
          summary: "rate-limit circuit breaker",
          durationMs: 0,
        });
        continue;
      }

      if (options.dryRun) {
        pushStepResult({
          name: step.name,
          status: "ok",
          summary: "dry-run (would execute)",
          durationMs: 0,
        });
        completedThisRun.add(step.name);
        continue;
      }

      if (lastWasLlmStep && isLlmProviderStep(step.llmTier) && llmCooldownMs > 0 && !maintenanceRunDeadlineReached()) {
        const remaining = remainingMaintenanceRunMs();
        const cooldownMs = Number.isFinite(remaining)
          ? Math.min(llmCooldownMs, Math.max(0, Math.floor(remaining)))
          : llmCooldownMs;
        if (cooldownMs > 0) {
          await sleep(cooldownMs);
        }
        // Re-check eligibility after the cooldown sleep: another process (a manual CLI run, or a
        // double-fired cron trigger) could have run and completed this step entirely inside the
        // sleep window. acquireStepLock below only prevents *concurrent* execution — it does
        // nothing to stop this process from re-running a step that already finished sequentially
        // just before it woke up, since the lock is free again by the time it wakes.
        if (!options.force && guardMs > 0) {
          const recheck = stepGuardEligible(step.name, guardMs, openclawDir);
          if (!recheck.eligible) {
            const agoH = recheck.lastRunMs ? Math.round((Date.now() - recheck.lastRunMs) / HOUR_MS) : 0;
            pushStepResult({
              name: step.name,
              status: "skipped_guard",
              summary: `guard (ran ${agoH}h ago)`,
              durationMs: 0,
            });
            continue;
          }
        }
      }

      // Real cross-process mutex on top of stepGuardEligible's cadence-only check above — prevents
      // two orchestrator invocations that start near-simultaneously (a manual CLI run overlapping
      // the gateway's own tick, or a double-fired cron trigger) from executing the same step
      // concurrently (duplicate LLM calls, duplicate decay/prune passes).
      if (!acquireStepLock(step.name, openclawDir)) {
        // Surface enough lock metadata (owner pid/host, hold duration, lock path) for an operator to
        // verify whether this is a real concurrent run or an abandoned lock (#2031).
        const lockDetail = formatStepLockDetail(readStepLockInfo(step.name, openclawDir));
        pushStepResult({
          name: step.name,
          status: "skipped_guard",
          summary: `locked by a concurrent maintenance run (${lockDetail})`,
          durationMs: 0,
        });
        continue;
      }

      const stepStarted = Date.now();
      try {
        const summary = await runStepWithHeartbeat(step.name, options.verbose !== false, logger, () => runner());
        const meta = parseStepRunnerMetadata(summary);
        if (step.name === "reflect-rules" && reflectRulesStepSummaryIndicatesFailure(summary)) {
          logger?.warn?.(`maintenance-orchestrator: ${step.name} semantic failure (summary diagnostics): ${summary}`);
          pushStepResult({
            name: step.name,
            status: "failed",
            summary,
            durationMs: Date.now() - stepStarted,
            ...meta,
            semanticOutcome: meta.semanticOutcome ?? "failed",
          });
          lastWasLlmStep = isLlmProviderStep(step.llmTier);
          continue;
        }
        if (stepSemanticBlocksGuard(meta.semanticOutcome)) {
          logger?.warn?.(
            `maintenance-orchestrator: ${step.name} semantic failure (${meta.semanticOutcome}): ${summary}`,
          );
          pushStepResult({
            name: step.name,
            status: "failed",
            summary,
            durationMs: Date.now() - stepStarted,
            ...meta,
          });
          lastWasLlmStep = isLlmProviderStep(step.llmTier);
          continue;
        }
        if (!options.dryRun && guardMs >= 0) {
          writeStepGuardTimestampMs(step.name, Date.now(), openclawDir);
        }
        pushStepResult({
          name: step.name,
          status: "ok",
          summary,
          durationMs: Date.now() - stepStarted,
          ...meta,
        });
        completedThisRun.add(step.name);
        consecutiveRateLimitErrors = 0;
        lastWasLlmStep = isLlmProviderStep(step.llmTier);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isRateLimitError(err)) {
          consecutiveRateLimitErrors++;
          if (consecutiveRateLimitErrors >= rateLimitMaxRetries) {
            deferRemainingLlm = true;
          }
          logger?.warn?.(`maintenance-orchestrator: ${step.name} rate-limited: ${message}`);
          pushStepResult({
            name: step.name,
            status: "rate_limited",
            summary: message,
            durationMs: Date.now() - stepStarted,
          });
        } else {
          logger?.warn?.(`maintenance-orchestrator: ${step.name} failed: ${message}`);
          const meta = parseStepRunnerMetadata(message);
          pushStepResult({
            name: step.name,
            status: "failed",
            summary: message,
            durationMs: Date.now() - stepStarted,
            ...meta,
          });
        }
        lastWasLlmStep = isLlmProviderStep(step.llmTier);
      } finally {
        releaseStepLock(step.name, openclawDir);
      }
    }

    const { summaryLine, lines } = formatMaintenanceSummary(tierLabel, results);
    if (options.verbose !== false) {
      logger?.info?.(summaryLine);
      for (const line of lines) logger?.info?.(line);
    }

    const finishedAt = nowIso();
    return {
      tierLabel,
      steps: results,
      exitCode: computeExitCode(results),
      summaryLine,
      runId,
      startedAt: startedAtIso,
      finishedAt,
      durationMs: Date.now() - startedAtMs,
    };
  } finally {
    clearMaintenanceRunDeadline();
  }
}

export { generateOrchestratorRunId, toOrchestratorRunSummary } from "./maintenance-job-run/orchestrator-summary.js";

export async function runMaintenanceTiers(
  ctx: MaintenanceOrchestratorContext,
  tiers: StepTier[],
  options: Omit<OrchestratorRunOptions, "tiers"> = {},
): Promise<MaintenanceOrchestratorResult> {
  return runMaintenanceOrchestrator(ctx, { ...options, tiers });
}
