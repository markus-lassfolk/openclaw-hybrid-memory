#!/usr/bin/env node
/**
 * Run maintenance backfills against sandbox HOME (offline QA validation).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { FactsDB } from "../../backends/facts-db.js";
import { WorkflowStore } from "../../backends/workflow-store.js";
import { hybridConfigSchema } from "../../config.js";
import { resolveExtractSessionFilePaths } from "../../services/extract-session-paths.js";
import { backfillRecallEventsFromSessionFile } from "../../services/recall-events.js";
import { synthesizeDailyLogFromSessionFile } from "../../services/daily-log-synthesizer.js";
import { scanSessionFileForMetadata } from "../../services/session-metadata.js";
import {
  buildMaintenanceCoverageReport,
  formatMaintenanceCoverageReport,
} from "../../services/maintenance-coverage.js";
import {
  extractToolSequenceFromMessages,
  extractToolSequenceFromTrajectoryLines,
  normalizeWorkflowToolSequence,
  readTrajectoryLines,
} from "../../services/session-v3-parser.js";
import { parseSessionMessagesFromLines } from "../../services/session-signal-context.js";
import { redactMaintenancePrivateText } from "../../utils/maintenance-privacy.js";
import { extractUserWorkflowGoal, isSystemWorkflowGoal } from "../../services/workflow-goal-classifier.js";
import { inferWorkflowOutcomeFromMessages } from "../../services/workflow-message-utils.js";

const home = process.env.HOME ?? homedir();
const cfgPath = join(home, ".openclaw/openclaw.json");
const root = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
  plugins: { entries: Record<string, { config: unknown }> };
};
const cfg = hybridConfigSchema.parse(root.plugins.entries["openclaw-hybrid-memory"].config);
const sqlitePath = join(home, ".openclaw/memory/facts.db");
const factsDb = new FactsDB(sqlitePath);
const days = Number.parseInt(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "60", 10);
const paths = resolveExtractSessionFilePaths(cfg, days);

let recall = 0;
let daily = 0;
let langs = 0;
let traces = 0;
let skippedDupes = 0;
const wf = new WorkflowStore(join(home, ".openclaw/memory/workflow-traces.db"));

for (const p of paths) {
  recall += backfillRecallEventsFromSessionFile(factsDb.getRawDb(), p);
  if (synthesizeDailyLogFromSessionFile(p)) daily++;
  if (scanSessionFileForMetadata(factsDb.getRawDb(), p)) langs++;
  const rawLines = readFileSync(p, "utf-8").split("\n");
  const messages = parseSessionMessagesFromLines(rawLines, "sandbox-backfill");
  let tools = extractToolSequenceFromMessages(messages);
  const trajLines = readTrajectoryLines(p);
  if (trajLines) tools.push(...extractToolSequenceFromTrajectoryLines(trajLines, "sandbox-backfill"));
  tools = normalizeWorkflowToolSequence(tools);
  if (tools.length >= 2) {
    const goal = redactMaintenancePrivateText(
      extractUserWorkflowGoal(messages, cfg.crystallization?.excludeGoalPatterns),
    );
    if (isSystemWorkflowGoal(goal, cfg.crystallization?.excludeGoalPatterns)) continue;
    const inserted = wf.recordBackfillIfAbsent({
      goal,
      toolSequence: tools,
      outcome: inferWorkflowOutcomeFromMessages(messages),
      sessionId: basename(p),
    });
    if (inserted) traces++;
    else skippedDupes++;
  }
}

const row = factsDb
  .getRawDb()
  .prepare(
    `SELECT MAX(created_at) AS max_created FROM facts WHERE category IN ('pattern', 'rule') AND superseded_at IS NULL`,
  )
  .get() as { max_created: number | null };
factsDb.setMaintenanceState(
  "reflection_last_fact_created_at",
  String(row?.max_created ?? Math.floor(Date.now() / 1000)),
);

const cov = buildMaintenanceCoverageReport({
  factsDbPath: sqlitePath,
  workflowDbPath: join(home, ".openclaw/memory/workflow-traces.db"),
  proposalsDbPath: join(home, ".openclaw/memory/proposals.db"),
  days: 7,
});

console.log(
  JSON.stringify({ recall, daily, langs, traces, skippedDupes, sessions: paths.length }, null, 2),
);
console.log(formatMaintenanceCoverageReport(cov));
