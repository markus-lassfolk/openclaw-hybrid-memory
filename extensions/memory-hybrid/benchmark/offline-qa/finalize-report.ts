#!/usr/bin/env node
/** Re-analyze task logs and regenerate qa-report.md from qa-state.json */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTaskResult, renderTaskAnalysisMarkdown } from "./analyze.js";
import { buildQualityReport, renderQualityMarkdown } from "./analyze-quality.js";
import { QA_TASK_PLAN } from "./qa-tasks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QA_ROOT = join(__dirname, "../../.offline-qa");
const STATE_PATH = join(QA_ROOT, "qa-state.json");
const REPORT_PATH = join(QA_ROOT, "qa-report.md");

type QaState = {
  runId: string;
  startedAt: string;
  updatedAt: string;
  phase: string;
  workHome: string;
  timeoutMs: number;
  tasks: Array<{
    id: string;
    status: string;
    exitCode?: number;
    durationMs?: number;
    logPath?: string;
    classification?: string;
    analysis?: ReturnType<typeof analyzeTaskResult>;
  }>;
  todos: string[];
};

const state = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as QaState;
state.todos = [];

for (const task of state.tasks) {
  const spec = QA_TASK_PLAN.find((s) => s.id === task.id);
  if (!spec || !task.logPath) continue;
  try {
    const log = readFileSync(task.logPath, "utf-8");
    const analysis = analyzeTaskResult(spec, log, task.exitCode ?? 1, task.durationMs ?? 0);
    task.analysis = analysis;
    task.classification = analysis.classification;
    if (analysis.classification === "needs-fix" || analysis.classification === "test-bug") {
      task.status = "failed";
    } else if (analysis.classification === "skipped") {
      task.status = "skipped";
    } else {
      task.status = "passed";
    }
  } catch {
    /* keep existing */
  }
}

state.updatedAt = new Date().toISOString();
writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const passed = state.tasks.filter((t) => t.status === "passed").length;
const failed = state.tasks.filter((t) => t.status === "failed").length;
const lines = [
  `# Offline Maintenance QA Report`,
  "",
  `**Run:** ${state.runId} | **Phase:** ${state.phase} | **Updated:** ${state.updatedAt}`,
  `**Work HOME:** ${state.workHome}`,
  `**Timeout:** ${state.timeoutMs / 1000}s per task`,
  "",
  `## Summary`,
  "",
  `| Metric | Count |`,
  `|--------|-------|`,
  `| Passed | ${passed} |`,
  `| Failed | ${failed} |`,
  `| Pending | ${state.tasks.filter((t) => t.status === "pending").length} |`,
  "",
  "## Task table",
  "",
  "| Task | Status | Class | Duration | Exit |",
  "|------|--------|-------|----------|------|",
  ...state.tasks.map((t) => {
    const dur = t.durationMs ? `${(t.durationMs / 1000).toFixed(0)}s` : "-";
    return `| ${t.id} | ${t.status} | ${t.classification ?? "-"} | ${dur} | ${t.exitCode ?? "-"} |`;
  }),
  "",
];

for (const t of state.tasks) {
  const spec = QA_TASK_PLAN.find((s) => s.id === t.id);
  if (spec && t.analysis) lines.push(renderTaskAnalysisMarkdown(spec, t.analysis));
}

const needsFix = state.tasks.filter((t) => t.classification === "needs-fix" || t.status === "failed");
const dataGaps = state.tasks.filter((t) => t.classification === "data-gap");
const skipped = state.tasks.filter((t) => t.status === "skipped");
const llmTasks = state.tasks.filter((t) => QA_TASK_PLAN.find((s) => s.id === t.id)?.llmTask);
const providerLeaks = llmTasks.filter((t) => t.analysis?.providerLeak);

lines.push(
  "## Provider guard (MiniMax-only)",
  "",
  providerLeaks.length === 0
    ? "**PASS** — no non-MiniMax LLM routing detected in maintenance task logs"
    : `**FAIL** — possible leak in: ${providerLeaks.map((t) => t.id).join(", ")}`,
  "",
  "## Go / no-go",
  "",
  needsFix.length === 0
    ? "**GO** (no hard failures) — review data-gap items before live deploy"
    : `**NO-GO** — ${needsFix.length} task(s) need fixes: ${needsFix.map((t) => t.id).join(", ")}`,
  "",
);
if (dataGaps.length) lines.push(`Data gaps (expected): ${dataGaps.map((t) => t.id).join(", ")}`, "");
if (skipped.length) lines.push(`Skipped (by design): ${skipped.map((t) => t.id).join(", ")}`, "");

const taskLogs = Object.fromEntries(state.tasks.map((t) => [t.id, t.logPath]));
const qualityReport = buildQualityReport(state.workHome, taskLogs);
lines.push(renderQualityMarkdown(qualityReport));

const documentedGaps: string[] = [];
for (const t of qualityReport.tasks) {
  if (t.verdict === "good") continue;
  if (t.verdict === "failed") continue;
  documentedGaps.push(`- **${t.taskId}** (${t.verdict}): ${t.summary}`);
}
if (documentedGaps.length) {
  lines.push("## Documented quality gaps (real data, not harness bugs)", "", ...documentedGaps, "");
}

lines.push(
  "## Remaining before live Maeve deploy",
  "",
  "- [ ] Ensure `.offline-qa/secrets.env` is fresh (`npm run offline-qa:fetch-secrets`) — embeddings use Maeve APIM key",
  "- [ ] Apply `maeve-tier-snippet.json` to live config after approval (MiniMax-only + explicit-only fallback)",
  "",
);

writeFileSync(REPORT_PATH, lines.join("\n"));
console.log(`Report: ${REPORT_PATH} | passed=${passed} failed=${failed} providerLeaks=${providerLeaks.length}`);
