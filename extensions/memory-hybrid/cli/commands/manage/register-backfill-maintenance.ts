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
import {
  extractToolCallSequence,
  parseSessionMessagesFromLines,
} from "../../../services/session-signal-context.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { redactMaintenancePrivateText } from "../../../utils/maintenance-privacy.js";
import { type Chainable, withExit } from "../../shared.js";
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

function inferSessionOutcome(messages: Array<{ role: string; text: string }>): "success" | "failure" | "unknown" {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].text.toLowerCase();
    if (/\b(error|failed|failure)\b/.test(t)) return "failure";
    if (/\b(done|success|completed|fixed)\b/.test(t)) return "success";
  }
  return "unknown";
}

function backfillWorkflowTracesFromFile(
  factsDb: FactsDB,
  workflowStore: WorkflowStore,
  filePath: string,
): { traces: number; proceduresUpdated: number } {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const messages = parseSessionMessagesFromLines(lines, "backfill-workflow-traces");
  const tools: string[] = [];
  for (const msg of messages) {
    tools.push(...extractToolCallSequence(msg.content));
  }
  if (tools.length < 2) return { traces: 0, proceduresUpdated: 0 };

  const sessionId = basename(filePath);
  const goal =
    messages.find((m) => m.role === "user" && m.text.trim())?.text.trim().slice(0, 200) ?? "session workflow";
  const outcome = inferSessionOutcome(messages);
  workflowStore.record({
    goal: redactMaintenancePrivateText(goal),
    toolSequence: tools,
    outcome,
    sessionId,
  });

  let proceduresUpdated = 0;
  const taskPattern = tools.join(" -> ");
  const normalizedPattern = redactMaintenancePrivateText(taskPattern);
  const matches = factsDb.searchProcedures(normalizedPattern, 3);
  for (const proc of matches) {
    const updated = factsDb.procedureFeedback({
      procedureId: proc.id,
      success: outcome === "success",
      sessionId,
      context: `backfill-workflow-traces:${sessionId}`,
    });
    if (updated) proceduresUpdated++;
  }
  return { traces: 1, proceduresUpdated };
}

export function registerBackfillMaintenanceCommands(mem: Chainable, b: ManageBindings): void {
  const { factsDb, cfg } = b;

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
        else console.log(`backfill-daily-logs: wrote/updated ${written} daily log section(s) from ${paths.length} session(s)`);
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
    .description("Extract tool sequences from session JSONL into workflow-traces.db and update procedure outcomes")
    .option("--days <n>", "Scan sessions modified in the last N days", "60")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { days?: string; json?: boolean }) => {
        const days = Number.parseInt(opts?.days ?? "60", 10);
        const workflowStore = new WorkflowStore(defaultWorkflowDbPath());
        let traces = 0;
        let proceduresUpdated = 0;
        const paths = resolveExtractSessionFilePaths(cfg, days);
        for (const filePath of paths) {
          const result = backfillWorkflowTracesFromFile(factsDb, workflowStore, filePath);
          traces += result.traces;
          proceduresUpdated += result.proceduresUpdated;
        }
        const report = { files: paths.length, workflowTraces: traces, proceduresUpdated, days };
        if (opts?.json) console.log(JSON.stringify(report, null, 2));
        else
          console.log(
            `backfill-workflow-traces: recorded ${traces} trace(s), updated ${proceduresUpdated} procedure(s) from ${paths.length} session(s)`,
          );
      }),
    );

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
