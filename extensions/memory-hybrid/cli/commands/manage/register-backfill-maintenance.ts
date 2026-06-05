/**
 * Backfill maintenance data gaps from session JSONL + coverage CLI.
 */
import { WorkflowStore } from "../../../backends/workflow-store.js";
import type { FactsDB } from "../../../backends/facts-db.js";
import { resolveExtractSessionFilePaths } from "../../../services/extract-session-paths.js";
import { backfillRecallEventsFromSessionFile } from "../../../services/recall-events.js";
import { synthesizeDailyLogFromSessionFile } from "../../../services/daily-log-synthesizer.js";
import { scanSessionFileForMetadata } from "../../../services/session-metadata.js";
import {
  buildMaintenanceCoverageReport,
  defaultFactsDbPath,
  defaultProposalsDbPath,
  defaultWorkflowDbPath,
  formatMaintenanceCoverageReport,
} from "../../../services/maintenance-coverage.js";
import { parseSessionMessagesFromLines } from "../../../services/session-signal-context.js";
import {
  extractToolSequenceFromMessages,
  extractToolSequenceFromTrajectoryLines,
  normalizeWorkflowToolSequence,
  readTrajectoryLines,
} from "../../../services/session-v3-parser.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { redactMaintenancePrivateText } from "../../../utils/maintenance-privacy.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { extractUserWorkflowGoal, isSystemWorkflowGoal } from "../../../services/workflow-goal-classifier.js";
import { inferWorkflowOutcomeFromMessages } from "../../../services/workflow-message-utils.js";
import { type Chainable, withExit } from "../../shared.js";
import type { HybridMemoryConfig } from "../../../config.js";
import type { ManageBindings } from "./bindings.js";

function backfillReflectionWatermark(factsDb: FactsDB): number {
  const row = factsDb
    .getRawDb()
    .prepare(
      `SELECT MAX(created_at) AS max_created FROM facts
       WHERE category IN ('pattern', 'rule') AND superseded_at IS NULL`,
    )
    .get() as { max_created: number | null } | undefined;
  const maxCreated = row?.max_created ?? Math.floor(Date.now() / 1000);
  factsDb.setMaintenanceState("reflection_last_fact_created_at", String(maxCreated));
  return maxCreated;
}

function collectWorkflowToolsFromSessionFile(filePath: string): string[] {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const messages = parseSessionMessagesFromLines(lines, "backfill-workflow-traces");
  const tools = extractToolSequenceFromMessages(messages);
  const trajLines = readTrajectoryLines(filePath);
  if (trajLines) {
    tools.push(...extractToolSequenceFromTrajectoryLines(trajLines, "backfill-workflow-traces"));
  }
  return normalizeWorkflowToolSequence(tools);
}

function backfillWorkflowTracesFromFile(
  _factsDb: FactsDB,
  workflowStore: WorkflowStore,
  filePath: string,
  cfg: HybridMemoryConfig,
): number {
  const tools = collectWorkflowToolsFromSessionFile(filePath);
  if (tools.length < 2) return 0;

  const lines = readFileSync(filePath, "utf-8").split("\n");
  const messages = parseSessionMessagesFromLines(lines, "backfill-workflow-traces");

  const sessionId = basename(filePath);
  const goal = redactMaintenancePrivateText(
    extractUserWorkflowGoal(messages, cfg.crystallization?.excludeGoalPatterns),
  );
  if (isSystemWorkflowGoal(goal, cfg.crystallization?.excludeGoalPatterns)) return 0;
  const outcome = inferWorkflowOutcomeFromMessages(messages);
  try {
    const inserted = workflowStore.recordBackfillIfAbsent({
      goal,
      toolSequence: tools,
      outcome,
      sessionId,
    });
    return inserted ? 1 : 0;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "backfill-workflow-traces:record",
      severity: "warn",
      subsystem: "maintenance",
      context: sessionId,
    });
    return 0;
  }
}

export type BackfillRegistrationOptions = {
  /** When true, register only session/workflow backfill subcommands (not workflow QA / coverage). */
  onlyBackfill?: boolean;
  /** When true, register only workflow-trace QA commands (flat operator tools). */
  onlyWorkflowQa?: boolean;
  /** When true, parent accepts `--all` to run standard offline QA backfills. */
  groupedBackfillParent?: boolean;
};

function registerWorkflowTraceQaCommands(mem: Chainable, b: ManageBindings): void {
  const { cfg } = b;
  mem
    .command("workflow-trace-quality")
    .description("Summarize user-facing vs system/cron workflow traces in workflow-traces.db")
    .option("--days <n>", "Window in days", "30")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { days?: string; json?: boolean }) => {
        const days = Number.parseInt(opts?.days ?? "30", 10);
        const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;
        const workflowStore = new WorkflowStore(defaultWorkflowDbPath());
        try {
          const summary = workflowStore.summarizeGoalKinds({
            sinceSec,
            excludeGoalPatterns: cfg.crystallization?.excludeGoalPatterns,
          });
          const report = { days, ...summary };
          if (opts?.json) console.log(JSON.stringify(report, null, 2));
          else {
            console.log(
              `workflow-trace-quality (last ${days}d): total=${summary.total}, user-facing=${summary.userFacing}, system=${summary.systemGoals}`,
            );
            if (summary.systemGoals > 0 && summary.userFacing === 0) {
              console.log(
                "All traces are system/cron goals — run purge-workflow-system-traces and collect fresh user-facing workflows.",
              );
            }
          }
        } finally {
          workflowStore.close();
        }
      }),
    );

  mem
    .command("purge-workflow-system-traces")
    .description("Remove workflow_traces rows whose goal is a cron/system injection")
    .option("--dry-run", "Report rows that would be deleted without mutating the DB")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { dryRun?: boolean; json?: boolean }) => {
        const workflowStore = new WorkflowStore(defaultWorkflowDbPath());
        try {
          const result = workflowStore.purgeSystemGoalTraces({
            dryRun: !!opts?.dryRun,
            excludeGoalPatterns: cfg.crystallization?.excludeGoalPatterns,
          });
          const report = { ...result, dryRun: !!opts?.dryRun };
          if (opts?.json) console.log(JSON.stringify(report, null, 2));
          else if (opts?.dryRun) {
            console.log(
              `purge-workflow-system-traces (dry-run): scanned ${result.scanned}, would remove ${result.removed} system-goal trace(s)`,
            );
          } else {
            console.log(
              `purge-workflow-system-traces: scanned ${result.scanned}, removed ${result.removed} system-goal trace(s)`,
            );
          }
        } finally {
          workflowStore.close();
        }
      }),
    );

  mem
    .command("dedupe-workflow-traces")
    .description("Remove duplicate workflow_traces rows with the same session_id and args_hash")
    .option("--dry-run", "Report duplicates without deleting")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { dryRun?: boolean; json?: boolean }) => {
        const workflowStore = new WorkflowStore(defaultWorkflowDbPath());
        try {
          const result = workflowStore.dedupeBySessionAndArgsHash({ dryRun: !!opts?.dryRun });
          const report = { ...result, dryRun: !!opts?.dryRun };
          if (opts?.json) console.log(JSON.stringify(report, null, 2));
          else if (opts?.dryRun) {
            console.log(
              `dedupe-workflow-traces (dry-run): ${result.duplicateGroups} duplicate group(s), would remove ${result.removed} row(s)`,
            );
          } else {
            console.log(
              `dedupe-workflow-traces: removed ${result.removed} duplicate row(s), kept ${result.kept} canonical row(s)`,
            );
          }
        } finally {
          workflowStore.close();
        }
      }),
    );
}

export function registerBackfillMaintenanceCommands(
  mem: Chainable,
  b: ManageBindings,
  opts?: BackfillRegistrationOptions,
): void {
  if (opts?.onlyWorkflowQa) {
    registerWorkflowTraceQaCommands(mem, b);
    return;
  }

  const { factsDb, cfg } = b;
  const onlyBackfill = opts?.onlyBackfill ?? false;

  if (opts?.groupedBackfillParent) {
    mem
      .option("--all", "Run daily-logs, session-languages, and recall-events backfills")
      .option("--days <n>", "Scan sessions modified in the last N days (--all only)", "60")
      .action(
        withExit(async (opts?: { all?: boolean; days?: string }) => {
          if (!opts?.all) return;
          const days = Number.parseInt(opts.days ?? "60", 10);
          let dailyLogs = 0;
          let sessionLanguages = 0;
          let recallEvents = 0;
          const paths = resolveExtractSessionFilePaths(cfg, days);
          for (const filePath of paths) {
            if (synthesizeDailyLogFromSessionFile(filePath)) dailyLogs++;
            if (scanSessionFileForMetadata(factsDb.getRawDb(), filePath)) sessionLanguages++;
            recallEvents += backfillRecallEventsFromSessionFile(factsDb.getRawDb(), filePath);
          }
          console.log(
            `maintenance backfill --all: scanned ${paths.length} session(s); daily-logs=${dailyLogs}, session-languages=${sessionLanguages}, recall-events=${recallEvents}`,
          );
        }),
      );
  }

  mem
    .command("backfill-recall-events")
    .description("Backfill recall_events from session JSONL memory_recall tool_use blocks")
    .option("--days <n>", "Scan sessions modified in the last N days", "60")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { days?: string; json?: boolean }) => {
        const days = Number.parseInt(opts?.days ?? "60", 10);
        let inserted = 0;
        const paths = resolveExtractSessionFilePaths(cfg, days);
        for (const filePath of paths) {
          inserted += backfillRecallEventsFromSessionFile(factsDb.getRawDb(), filePath);
        }
        const report = { files: paths.length, recallEventsInserted: inserted, days };
        if (opts?.json) console.log(JSON.stringify(report, null, 2));
        else console.log(`backfill-recall-events: scanned ${report.files} file(s), inserted ${inserted} event(s)`);
      }),
    );

  mem
    .command("backfill-reflection-watermark")
    .description("Set reflection_last_fact_created_at from existing pattern/rule facts")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const watermark = backfillReflectionWatermark(factsDb);
        const report = { reflection_last_fact_created_at: watermark };
        if (opts?.json) console.log(JSON.stringify(report, null, 2));
        else console.log(`backfill-reflection-watermark: set watermark to ${watermark}`);
      }),
    );

  mem
    .command("backfill-daily-logs")
    .description("Synthesize daily memory logs from session JSONL (idempotent per session hash marker)")
    .option("--days <n>", "Scan sessions modified in the last N days", "60")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { days?: string; json?: boolean }) => {
        const days = Number.parseInt(opts?.days ?? "60", 10);
        let written = 0;
        const paths = resolveExtractSessionFilePaths(cfg, days);
        for (const filePath of paths) {
          if (synthesizeDailyLogFromSessionFile(filePath)) written++;
        }
        const report = { files: paths.length, dailyLogsWritten: written, days };
        if (opts?.json) console.log(JSON.stringify(report, null, 2));
        else
          console.log(
            `backfill-daily-logs: wrote/updated ${written} daily log section(s) from ${paths.length} session(s)`,
          );
      }),
    );

  mem
    .command("backfill-session-languages")
    .description("Detect per-session languages from JSONL user messages into session_metadata")
    .option("--days <n>", "Scan sessions modified in the last N days", "60")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { days?: string; json?: boolean }) => {
        const days = Number.parseInt(opts?.days ?? "60", 10);
        let rows = 0;
        const paths = resolveExtractSessionFilePaths(cfg, days);
        for (const filePath of paths) {
          if (scanSessionFileForMetadata(factsDb.getRawDb(), filePath)) rows++;
        }
        const report = { files: paths.length, sessionMetadataRows: rows, days };
        if (opts?.json) console.log(JSON.stringify(report, null, 2));
        else console.log(`backfill-session-languages: upserted ${rows} session_metadata row(s)`);
      }),
    );

  mem
    .command("backfill-workflow-traces")
    .description("Extract tool sequences from session JSONL into workflow-traces.db")
    .option("--days <n>", "Scan sessions modified in the last N days", "60")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { days?: string; json?: boolean }) => {
        const days = Number.parseInt(opts?.days ?? "60", 10);
        const workflowStore = new WorkflowStore(defaultWorkflowDbPath());
        try {
          let traces = 0;
          const paths = resolveExtractSessionFilePaths(cfg, days);
          for (const filePath of paths) {
            traces += backfillWorkflowTracesFromFile(factsDb, workflowStore, filePath, cfg);
          }
          const report = { files: paths.length, workflowTraces: traces, days };
          if (opts?.json) console.log(JSON.stringify(report, null, 2));
          else console.log(`backfill-workflow-traces: recorded ${traces} trace(s) from ${paths.length} session(s)`);
        } finally {
          workflowStore.close();
        }
      }),
    );

  if (!onlyBackfill) {
    registerWorkflowTraceQaCommands(mem, b);
    registerMaintenanceCoverageCommand(mem, b);
  }
}

export function registerMaintenanceCoverageCommand(mem: Chainable, b: ManageBindings): void {
  const { factsDb } = b;
  mem
    .command("maintenance-coverage")
    .description("Print maintenance data coverage counts for offline QA diagnostics")
    .option("--days <n>", "Window in days", "7")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { days?: string; json?: boolean }) => {
        const days = Number.parseInt(opts?.days ?? "7", 10);
        const report = buildMaintenanceCoverageReport({
          factsDbPath: factsDb.sqlitePath || defaultFactsDbPath(),
          workflowDbPath: defaultWorkflowDbPath(),
          proposalsDbPath: defaultProposalsDbPath(),
          days,
        });
        if (opts?.json) console.log(JSON.stringify(report, null, 2));
        else console.log(formatMaintenanceCoverageReport(report));
      }),
    );
}
