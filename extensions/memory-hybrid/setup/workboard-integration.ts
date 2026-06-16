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

function clearWorkboardSyncTimer(timers: PluginRuntime["timers"]): void {
  if (timers.workboardSync?.value) {
    clearInterval(timers.workboardSync.value);
    timers.workboardSync.value = null;
  }
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
      loadTasks: () => loadTaskLedgerFromFacts(factsDb),
      loadGoals: async () => {
        if (!goalsDir) return [];
        try {
          return await listGoals(goalsDir);
        } catch {
          return [];
        }
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

    const available = await adapter.isAvailable();
    if (!available) {
      api.logger.info?.(
        `memory-hybrid: Workboard plugin not reachable (${connectLabel}) — sync not armed`,
      );
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
    api.logger.info?.(
      `memory-hybrid: Workboard sync loop started (every ${cfg.workboard.syncIntervalMinutes} min)`,
    );
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

/** Fire-and-forget re-arm after hot reload cleared timers without re-running plugin-service.start(). */
export function scheduleWorkboardIntegrationAfterReregister(ctx: WorkboardIntegrationContext): void {
  if (ctx.shouldAbort?.()) return;
  void armWorkboardIntegration({ ...ctx, connectLabel: "re-register" });
}
