import { homedir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginRuntime } from "../api/plugin-runtime.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { integrationVerbose } from "../utils/integration-trace.js";
import { isRegistrationSuperseded } from "../utils/registration-superseded.js";
import { getHybridMemoryRegistrationState } from "./hybrid-memory-generation-state.js";

export type WorkboardIntegrationContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  cfg: HybridMemoryConfig;
  api: ClawdbotPluginApi;
  timers: PluginRuntime["timers"];
  /** When true, skip arming (plugin service shutdown). */
  shouldAbort?: () => boolean;
  /** Log label for connect/sync (e.g. startup, re-register). */
  connectLabel?: string;
};

export const WORKBOARD_STARTUP_DEFER_MS = 60_000;
export const WORKBOARD_STARTUP_PROBE_MAX_ATTEMPTS = 3;
export const WORKBOARD_STARTUP_PROBE_BACKOFF_MS = 15_000;

/** First plugin-service cold start in this process — used to compute remaining defer on re-register. */
let workboardGatewayColdStartAtMs: number | null = null;

export function markWorkboardGatewayColdStart(): void {
  if (workboardGatewayColdStartAtMs == null) {
    workboardGatewayColdStartAtMs = Date.now();
  }
}

/** @internal test helper */
export function resetWorkboardGatewayColdStartForTests(): void {
  workboardGatewayColdStartAtMs = null;
}

export function resolveWorkboardDeferMs(nowMs: number = Date.now()): number {
  if (workboardGatewayColdStartAtMs == null) return 0;
  const elapsed = nowMs - workboardGatewayColdStartAtMs;
  return Math.max(0, WORKBOARD_STARTUP_DEFER_MS - elapsed);
}

function usesColdStartProbeStrategy(connectLabel: string): boolean {
  return connectLabel === "startup" || connectLabel === "re-register";
}

function clearWorkboardSyncTimer(timers: PluginRuntime["timers"]): void {
  if (timers.workboardSync?.value) {
    clearInterval(timers.workboardSync.value);
    timers.workboardSync.value = null;
  }
}

function clearWorkboardStartupTimer(timers: PluginRuntime["timers"]): void {
  if (timers.workboardStartupTimeout?.value) {
    clearTimeout(timers.workboardStartupTimeout.value);
    timers.workboardStartupTimeout.value = null;
  }
}

async function sleepMs(ms: number, shouldAbort?: () => boolean): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
  if (shouldAbort?.()) {
    throw new Error("aborted");
  }
}

async function probeWorkboardAdapterAvailable(
  adapter: { isAvailable(): Promise<boolean> },
  opts: {
    maxAttempts: number;
    backoffMs: number;
    shouldAbort?: () => boolean;
    logger: { debug?: (msg: string) => void };
    connectLabel: string;
  },
): Promise<boolean> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (opts.shouldAbort?.()) return false;
    const available = await adapter.isAvailable();
    if (available) return true;
    if (attempt < opts.maxAttempts) {
      opts.logger.debug?.(
        `memory-hybrid: Workboard probe attempt ${attempt}/${opts.maxAttempts} failed (${opts.connectLabel}) — retrying in ${opts.backoffMs}ms`,
      );
      try {
        await sleepMs(opts.backoffMs, opts.shouldAbort);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Connect Workboard adapter, run an initial sync, and arm the recurring sync interval.
 * Safe to call after hot-reload when plugin-service.start() is not re-invoked.
 */
export async function armWorkboardIntegration(ctx: WorkboardIntegrationContext): Promise<void> {
  const { factsDb, vectorDb, embeddings, cfg, api, timers, shouldAbort, connectLabel = "startup" } = ctx;

  if (!cfg.workboard?.enabled) return;
  if (shouldAbort?.()) return;

  const checkSuperseded = () => shouldAbort?.() ?? false;

  const uiIntegrationVerbose = integrationVerbose(cfg.verbosity);

  try {
    const { createWorkboardAdapter } = await import("../services/workboard-adapter.js");
    const { loadTaskLedgerFromFacts } = await import("../services/task-ledger-facts.js");
    const { listGoals } = await import("../services/goal-registry.js");
    const { applyWorkboardTaskStatusUpdate, applyWorkboardGoalStatusUpdate } = await import(
      "../services/workboard-facts-sync.js"
    );

    const workspaceRoot = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
    const goalsDir = cfg.goalStewardship?.enabled
      ? resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir)
      : undefined;

    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? undefined;

    const adapter = createWorkboardAdapter({
      cfg: {
        ...cfg.workboard,
        syncGoals: cfg.workboard.syncGoals && !!goalsDir,
      },
      shouldAbort: checkSuperseded,
      loadTasks: () => loadTaskLedgerFromFacts(factsDb),
      // Deliberately does NOT catch listGoals() failures: workboard-adapter.ts's sync() has an
      // outer try/catch that aborts the whole sync (before the stale-card deletion pass) on any
      // thrown error, matching how loadTasks() (also unwrapped) is handled. Swallowing the error
      // here and returning [] previously made a transient goals-directory read failure look
      // identical to "there are genuinely zero goals" — sync() would then treat every existing
      // Workboard goal card as stale and delete it, even though the goal data was intact.
      loadGoals: async () => {
        if (!goalsDir) return [];
        return listGoals(goalsDir);
      },
      updateTaskStatus: (label, newStatus) =>
        applyWorkboardTaskStatusUpdate(
          factsDb,
          vectorDb,
          embeddings,
          label,
          newStatus as import("../services/active-task.js").ActiveTaskStatus,
          api.logger,
        ),
      updateGoalStatus: goalsDir
        ? (goalId, newStatus) =>
            applyWorkboardGoalStatusUpdate(
              goalsDir,
              goalId,
              newStatus as import("../services/goal-stewardship-types.js").GoalStatus,
            )
        : undefined,
      gatewayToken,
      verbose: uiIntegrationVerbose,
    });

    const probeAttempts = usesColdStartProbeStrategy(connectLabel)
      ? WORKBOARD_STARTUP_PROBE_MAX_ATTEMPTS
      : 1;
    const probeBackoff = usesColdStartProbeStrategy(connectLabel) ? WORKBOARD_STARTUP_PROBE_BACKOFF_MS : 0;
    const available = await probeWorkboardAdapterAvailable(adapter, {
      maxAttempts: probeAttempts,
      backoffMs: probeBackoff,
      shouldAbort: checkSuperseded,
      logger: api.logger,
      connectLabel,
    });
    if (!available) {
      api.logger.info?.(`memory-hybrid: Workboard plugin not reachable (${connectLabel}) — sync not armed`);
      return;
    }

    if (checkSuperseded()) {
      api.logger.debug?.(`memory-hybrid: Workboard arm superseded after isAvailable (${connectLabel})`);
      return;
    }

    clearWorkboardSyncTimer(timers);

    api.logger.info(`memory-hybrid: Workboard adapter connected (${connectLabel}) — starting sync`);
    const result = await adapter.sync();
    if (checkSuperseded()) {
      api.logger.debug?.(`memory-hybrid: Workboard arm superseded after sync (${connectLabel})`);
      return;
    }
    if (result.errors.length > 0) {
      api.logger.warn(
        `memory-hybrid: Workboard sync errors (${connectLabel}): ${result.errors.slice(0, 5).join("; ")}`,
      );
    }

    const intervalMs = cfg.workboard.syncIntervalMinutes * 60 * 1000;
    timers.workboardSync = {
      value: setInterval(() => {
        if (shouldAbort?.()) return;
        api.logger.info?.("memory-hybrid: workboard sync tick");
        adapter
          .sync()
          .then((syncResult) => {
            if (syncResult.errors.length > 0) {
              api.logger.warn?.(
                `memory-hybrid: Workboard sync tick errors: ${syncResult.errors.slice(0, 5).join("; ")}`,
              );
            }
          })
          .catch((err) => {
            api.logger.warn?.(`memory-hybrid: Workboard sync tick failed: ${err}`);
          });
      }, intervalMs),
    };
    api.logger.info?.(`memory-hybrid: Workboard sync loop started (every ${cfg.workboard.syncIntervalMinutes} min)`);
  } catch (err) {
    api.logger.warn?.(
      `memory-hybrid: Workboard adapter startup failed (${connectLabel}, non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "plugin-service",
      operation: "workboard-adapter-start",
    });
  }
}

/** Defer Workboard probe until other gateway plugins finish loading (#1940). */
function scheduleWorkboardDeferredIntegration(ctx: WorkboardIntegrationContext, connectLabel: string): void {
  const { cfg, api, timers, shouldAbort } = ctx;
  if (!cfg.workboard?.enabled) return;
  if (shouldAbort?.()) return;

  const deferMs = resolveWorkboardDeferMs();
  clearWorkboardStartupTimer(timers);

  if (deferMs <= 0) {
    void armWorkboardIntegration({ ...ctx, connectLabel });
    return;
  }

  api.logger.debug?.(
    `memory-hybrid: Workboard ${connectLabel} probe deferred ${deferMs}ms (cold gateway start)`,
  );
  timers.workboardStartupTimeout = {
    value: setTimeout(() => {
      timers.workboardStartupTimeout!.value = null;
      if (shouldAbort?.()) return;
      void armWorkboardIntegration({ ...ctx, connectLabel });
    }, deferMs),
  };
}

/** Defer cold-start Workboard probe until other gateway plugins finish loading (#1940). */
export function scheduleWorkboardStartupIntegration(ctx: WorkboardIntegrationContext): void {
  markWorkboardGatewayColdStart();
  scheduleWorkboardDeferredIntegration(ctx, "startup");
}

/** Fire-and-forget re-arm after hot reload cleared timers without re-running plugin-service.start(). */
export function scheduleWorkboardIntegrationAfterReregister(ctx: WorkboardIntegrationContext): void {
  if (ctx.shouldAbort?.()) return;
  scheduleWorkboardDeferredIntegration(ctx, "re-register");
}

/** Build shouldAbort for plugin-service cold start (shutdown + registration generation). */
export function createWorkboardStartupShouldAbort(
  bootRegistrationGeneration: number,
  shuttingDownRef: { value: boolean },
): () => boolean {
  return () =>
    shuttingDownRef.value ||
    isRegistrationSuperseded(bootRegistrationGeneration);
}

/** Capture the registration generation when plugin-service.start() schedules Workboard. */
export function captureWorkboardBootRegistrationGeneration(): number {
  return getHybridMemoryRegistrationState().registrationGenerationRef.value;
}
