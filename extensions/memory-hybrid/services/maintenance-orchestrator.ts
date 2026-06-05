/**
 * Hybrid maintenance orchestrator — guard-driven step registry and tier runner.
 * Cycle tier: gateway-native tick. Nightly tier: consolidated cron + CLI.
 */

import type { HybridMemoryConfig } from "../config.js";
import { is429OrWrapped } from "./chat.js";
import {
  stepGuardEligible,
  writeStepGuardTimestampMs,
} from "./cron-guard.js";

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
}

export type MaintenanceStepRunner = () => Promise<string>;

export interface MaintenanceOrchestratorContext {
  cfg: HybridMemoryConfig;
  openclawDir?: string;
  runners: Map<string, MaintenanceStepRunner>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  oneTimeMarkerExists?: (markerPath: string) => boolean;
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
  // --- Cycle tier (12) ---
  { name: "prune", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h1, llmTier: "none" },
  { name: "compact", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "none" },
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
  { name: "analyze-maintenance-logs", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "none" },
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
  { name: "proposals-prune", tier: "cycle", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "none", featureGate: (cfg) => cfg.personaProposals?.enabled !== false },
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

  // --- Nightly tier — staggered (14) ---
  { name: "extract-daily", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20, llmTier: "nano" },
  {
    name: "distill",
    tier: "nightly",
    guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h20,
    llmTier: "default",
    featureGate: (cfg) => cfg.distill?.enabled !== false,
  },
  { name: "resolve-contradictions", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h44, llmTier: "local" },
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
  { name: "entity-mentions-cleanup", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.h68, llmTier: "none" },
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
    featureGate: (cfg) =>
      cfg.costTracking?.enabled !== false && cfg.costTracking?.pruneInNightlyCycle !== false,
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
  { name: "extract-reinforcement", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "maintenance" },
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
  { name: "implicit-feedback-collapse", tier: "nightly", guardIntervalMs: MAINTENANCE_GUARD_INTERVALS.d5, llmTier: "none" },
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

function dependenciesMet(step: MaintenanceStepDef, completedThisRun: Set<string>): boolean {
  if (!step.dependsOn?.length) return true;
  return step.dependsOn.every((dep) => completedThisRun.has(dep));
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

function computeExitCode(results: StepResult[]): 0 | 1 | 2 {
  if (results.some((r) => r.status === "failed")) return 1;
  if (results.some((r) => r.status === "deferred" || r.status === "rate_limited")) return 2;
  return 0;
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
  const startedAt = Date.now();
  const maxRuntimeMs =
    options.maxRuntimeMs ??
    (orchestratorCfg?.maxRuntimeMinutes ? orchestratorCfg.maxRuntimeMinutes * 60_000 : undefined);

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

  for (const step of steps) {
    if (maxRuntimeMs !== undefined && Date.now() - startedAt >= maxRuntimeMs) {
      results.push({
        name: step.name,
        status: "deferred",
        summary: "time budget exceeded",
        durationMs: 0,
      });
      continue;
    }

    if (step.featureGate && !step.featureGate(cfg)) {
      results.push({
        name: step.name,
        status: "skipped_gate",
        summary: "feature disabled",
        durationMs: 0,
      });
      continue;
    }

    if (step.oneTimeMarkerPath && ctx.oneTimeMarkerExists?.(step.oneTimeMarkerPath)) {
      results.push({
        name: step.name,
        status: "skipped_guard",
        summary: "one-time marker exists",
        durationMs: 0,
      });
      continue;
    }

    if (!dependenciesMet(step, completedThisRun)) {
      results.push({
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
        results.push({
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
      results.push({
        name: step.name,
        status: "skipped_missing_runner",
        summary: "no runner registered",
        durationMs: 0,
      });
      continue;
    }

    if (deferRemainingLlm && isLlmProviderStep(step.llmTier)) {
      results.push({
        name: step.name,
        status: "deferred",
        summary: "rate-limit circuit breaker",
        durationMs: 0,
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        name: step.name,
        status: "ok",
        summary: "dry-run (would execute)",
        durationMs: 0,
      });
      completedThisRun.add(step.name);
      continue;
    }

    if (lastWasLlmStep && isLlmProviderStep(step.llmTier) && llmCooldownMs > 0) {
      await sleep(llmCooldownMs);
    }

    const stepStarted = Date.now();
    try {
      const summary = await runner();
      if (!options.dryRun && guardMs >= 0) {
        writeStepGuardTimestampMs(step.name, Date.now(), openclawDir);
      }
      results.push({
        name: step.name,
        status: "ok",
        summary,
        durationMs: Date.now() - stepStarted,
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
        results.push({
          name: step.name,
          status: "rate_limited",
          summary: message,
          durationMs: Date.now() - stepStarted,
        });
      } else {
        logger?.warn?.(`maintenance-orchestrator: ${step.name} failed: ${message}`);
        results.push({
          name: step.name,
          status: "failed",
          summary: message,
          durationMs: Date.now() - stepStarted,
        });
      }
      lastWasLlmStep = isLlmProviderStep(step.llmTier);
    }
  }

  const { summaryLine, lines } = formatMaintenanceSummary(tierLabel, results);
  if (options.verbose !== false) {
    logger?.info?.(summaryLine);
    for (const line of lines) logger?.info?.(line);
  }

  return { tierLabel, steps: results, exitCode: computeExitCode(results), summaryLine };
}

export async function runMaintenanceTiers(
  ctx: MaintenanceOrchestratorContext,
  tiers: StepTier[],
  options: Omit<OrchestratorRunOptions, "tiers"> = {},
): Promise<MaintenanceOrchestratorResult> {
  return runMaintenanceOrchestrator(ctx, { ...options, tiers });
}
