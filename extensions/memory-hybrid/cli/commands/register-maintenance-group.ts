/**
 * Grouped `maintenance` CLI commands (extends inventory/status/cron-health).
 */

import type { ManageContext } from "../context.js";
import type { Chainable } from "../shared.js";
import {
  createCommandGroup,
  GROUPED_MAINTENANCE_COMMAND_NAMES,
  wrapChainableWithDeprecated,
  wrapChainableWithRenames,
} from "./cli-group-utils.js";
import type { ManageBindings } from "./manage/bindings.js";
import { registerRunAllCommand } from "./manage/register-agents-audit-runall.js";
import { registerAnalyzeMaintenanceLogsCommand } from "./manage/register-analyze-maintenance-logs.js";
import {
  registerBackfillMaintenanceCommands,
  registerMaintenanceCoverageCommand,
} from "./manage/register-backfill-maintenance.js";
import { registerGraphLinkEnrichmentCommand } from "./manage/register-graph-link-enrichment.js";
import { registerMaintenanceHealthCommands } from "./manage/register-maintenance-health.js";
import { registerMaintenanceOrchestratorCommands } from "./manage/register-maintenance-orchestrator.js";
import { registerMaintenanceRunCommands } from "./manage/register-maintenance-run.js";
import { registerReconcileCronLedgers } from "./manage/register-reconcile-cron-ledgers.js";
import { registerSensorSweepCommand } from "./manage/register-sensor-sweep.js";
import { registerValidateCronExit } from "./manage/register-validate-cron-exit.js";

const BACKFILL_RENAMES: Record<string, string> = {
  "backfill-recall-events": GROUPED_MAINTENANCE_COMMAND_NAMES.backfillRecallEvents,
  "backfill-reflection-watermark": GROUPED_MAINTENANCE_COMMAND_NAMES.backfillReflectionWatermark,
  "backfill-daily-logs": GROUPED_MAINTENANCE_COMMAND_NAMES.backfillDailyLogs,
  "backfill-session-languages": GROUPED_MAINTENANCE_COMMAND_NAMES.backfillSessionLanguages,
  "backfill-workflow-traces": GROUPED_MAINTENANCE_COMMAND_NAMES.backfillWorkflowTraces,
};

const BACKFILL_FLAT_PATHS: Record<string, string> = {
  "backfill-recall-events": "maintenance backfill recall-events",
  "backfill-reflection-watermark": "maintenance backfill reflection-watermark",
  "backfill-daily-logs": "maintenance backfill daily-logs",
  "backfill-session-languages": "maintenance backfill session-languages",
  "backfill-workflow-traces": "maintenance backfill workflow-traces",
};

const MAINTENANCE_CMD_RENAMES: Record<string, string> = {
  "maintenance-coverage": GROUPED_MAINTENANCE_COMMAND_NAMES.coverage,
  "validate-cron-exit": GROUPED_MAINTENANCE_COMMAND_NAMES.validateExit,
  "reconcile-cron-ledgers": GROUPED_MAINTENANCE_COMMAND_NAMES.reconcileLedgers,
  "analyze-maintenance-logs": GROUPED_MAINTENANCE_COMMAND_NAMES.analyzeLogs,
};

const MAINTENANCE_FLAT_PATHS: Record<string, string> = {
  "run-all": "maintenance run-all",
  "maintenance-coverage": "maintenance coverage",
  "validate-cron-exit": "maintenance validate-exit",
  "reconcile-cron-ledgers": "maintenance reconcile-ledgers",
  "analyze-maintenance-logs": "maintenance analyze-logs",
};

export function registerMaintenanceGroup(mem: Chainable, b: ManageBindings, ctx: ManageContext): void {
  const maintenance = createCommandGroup(mem, "maintenance", "Cron, backfill, and operational health (Issue #281)");

  registerMaintenanceHealthCommands(maintenance, b.cfg, b.factsDb);
  registerMaintenanceOrchestratorCommands(maintenance, b);
  registerMaintenanceRunCommands(maintenance);
  registerSensorSweepCommand(mem, b);
  registerRunAllCommand(maintenance, b, GROUPED_MAINTENANCE_COMMAND_NAMES.runAll);

  const groupedCmds = wrapChainableWithRenames(maintenance, MAINTENANCE_CMD_RENAMES);
  registerMaintenanceCoverageCommand(groupedCmds, b);
  registerAnalyzeMaintenanceLogsCommand(groupedCmds, b);
  registerValidateCronExit(groupedCmds, {
    cfg: ctx.cfg,
    versionInfo: ctx.versionInfo,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    journalDb: b.factsDb.getRawDb(),
  });
  registerReconcileCronLedgers(groupedCmds);
  registerGraphLinkEnrichmentCommand(groupedCmds, b);

  const backfill = maintenance.command("backfill").description("Backfill maintenance data gaps");
  registerBackfillMaintenanceCommands(wrapChainableWithRenames(backfill, BACKFILL_RENAMES), b, {
    onlyBackfill: true,
    groupedBackfillParent: true,
  });

  registerRunAllCommand(
    wrapChainableWithDeprecated(mem, { "run-all": MAINTENANCE_FLAT_PATHS["run-all"]! }),
    b,
    "run-all",
  );
  registerBackfillMaintenanceCommands(wrapChainableWithDeprecated(mem, BACKFILL_FLAT_PATHS), b, {
    onlyBackfill: true,
  });
  registerMaintenanceCoverageCommand(
    wrapChainableWithDeprecated(mem, { "maintenance-coverage": MAINTENANCE_FLAT_PATHS["maintenance-coverage"]! }),
    b,
  );
  registerAnalyzeMaintenanceLogsCommand(
    wrapChainableWithDeprecated(mem, {
      "analyze-maintenance-logs": MAINTENANCE_FLAT_PATHS["analyze-maintenance-logs"]!,
    }),
    b,
  );
  registerValidateCronExit(
    wrapChainableWithDeprecated(mem, { "validate-cron-exit": MAINTENANCE_FLAT_PATHS["validate-cron-exit"]! }),
    {
      cfg: ctx.cfg,
      versionInfo: ctx.versionInfo,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      journalDb: b.factsDb.getRawDb(),
    },
  );
  registerReconcileCronLedgers(
    wrapChainableWithDeprecated(mem, { "reconcile-cron-ledgers": MAINTENANCE_FLAT_PATHS["reconcile-cron-ledgers"]! }),
  );
}
