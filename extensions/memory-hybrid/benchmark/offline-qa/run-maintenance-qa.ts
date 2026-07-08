#!/usr/bin/env node
/**
 * Per-task offline maintenance QA — runs each hybrid-mem command via real CLI.
 *
 * Usage:
 *   npm run offline-qa:maintenance -- --phase fast
 *   npm run offline-qa:maintenance -- --phase full --resume
 *   npm run offline-qa:maintenance -- --redo distill --phase full
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "../../utils/process-runner.js";
import { formatRunIdSlug, nowIso } from "../../utils/dates.js";
import { analyzeTaskResult, renderTaskAnalysisMarkdown, type TaskAnalysis } from "./analyze.js";
import { buildQualityReport, renderQualityMarkdown } from "./analyze-quality.js";
import { loadOfflineQaSecrets } from "./load-secrets.js";
import { QA_PHASE_TIMEOUT_MS, QA_TASK_PLAN, type QaPhase, type QaTaskClassification } from "./qa-tasks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "../..");
const QA_ROOT = join(PLUGIN_ROOT, ".offline-qa");
loadOfflineQaSecrets(QA_ROOT);
const SANDBOX_TEMPLATE = join(QA_ROOT, "sandbox");
const SANDBOX_WORK = join(QA_ROOT, "sandbox-work");
const STATE_PATH = join(QA_ROOT, "qa-state.json");
const REPORT_PATH = join(QA_ROOT, "qa-report.md");
const NODE_WRAPPER = join(PLUGIN_ROOT, "../../scripts/run-with-supported-node.mjs");

type TaskState = {
  id: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  phase: QaPhase;
  attempts: number;
  exitCode?: number;
  durationMs?: number;
  logPath?: string;
  classification?: QaTaskClassification;
  analysis?: TaskAnalysis;
};

type QaState = {
  runId: string;
  startedAt: string;
  updatedAt: string;
  phase: QaPhase;
  workHome: string;
  pluginDir: string;
  timeoutMs: number;
  tasks: TaskState[];
  todos: string[];
};

function parseArgs(argv: string[]) {
  const phaseIdx = argv.indexOf("--phase");
  const redoIdx = argv.indexOf("--redo");
  return {
    phase: (phaseIdx >= 0 ? argv[phaseIdx + 1] : "fast") as QaPhase,
    resume: argv.includes("--resume"),
    redo: redoIdx >= 0 ? argv[redoIdx + 1] : undefined,
    reuseWork: argv.includes("--reuse-work"),
    reset: !argv.includes("--reuse-work") && !argv.includes("--resume"),
  };
}

function runScript(script: string, extraEnv: Record<string, string> = {}): void {
  const r = spawnSync("bash", [script], {
    cwd: PLUGIN_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function loadState(): QaState | null {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as QaState;
}

function saveState(state: QaState): void {
  state.updatedAt = nowIso();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  writeReport(state);
}

function initState(phase: QaPhase, workHome: string): QaState {
  const runId = formatRunIdSlug();
  const startedAt = nowIso();
  return {
    runId,
    startedAt,
    updatedAt: startedAt,
    phase,
    workHome,
    pluginDir: PLUGIN_ROOT,
    timeoutMs: QA_PHASE_TIMEOUT_MS[phase],
    tasks: QA_TASK_PLAN.map((t) => ({ id: t.id, status: "pending", phase, attempts: 0 })),
    todos: [],
  };
}

function writeReport(state: QaState): void {
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
    if (spec && t.analysis) {
      lines.push(renderTaskAnalysisMarkdown(spec, t.analysis));
    }
  }

  if (state.todos.length) {
    lines.push("## Todos", "", ...state.todos.map((x) => `- [ ] ${x}`), "");
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
  );
  lines.push(
    "## Go / no-go",
    "",
    needsFix.length === 0
      ? "**GO** (no hard failures) — review data-gap items before live deploy"
      : `**NO-GO** — ${needsFix.length} task(s) need fixes: ${needsFix.map((t) => t.id).join(", ")}`,
    "",
  );
  if (dataGaps.length) {
    lines.push(`Data gaps (expected): ${dataGaps.map((t) => t.id).join(", ")}`, "");
  }
  if (skipped.length) {
    lines.push(`Skipped (by design): ${skipped.map((t) => t.id).join(", ")}`, "");
  }

  const taskLogs = Object.fromEntries(state.tasks.map((t) => [t.id, t.logPath]));
  const quality = buildQualityReport(state.workHome, taskLogs);
  lines.push(renderQualityMarkdown(quality));
  if (quality.blockers.length) {
    lines.push("Quality review flagged storage failures — fix embeddings before trusting memory output.", "");
  }

  lines.push(
    "## Remaining before live Maeve deploy",
    "",
    "- [ ] Ensure `.offline-qa/secrets.env` is fresh (`npm run offline-qa:fetch-secrets`) — embeddings use Maeve APIM key",
    "- [ ] Apply `maeve-tier-snippet.json` to live config after approval (MiniMax-only + explicit-only fallback)",
    "",
  );

  writeFileSync(REPORT_PATH, lines.join("\n"));
}

export async function runTaskSubprocess(
  taskArgs: string[],
  env: NodeJS.ProcessEnv,
  wallTimeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = [NODE_WRAPPER, "openclaw", "hybrid-mem", ...taskArgs];
    const child = spawn("node", args, {
      env,
      cwd: PLUGIN_ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, wallTimeoutMs);
    // Without an 'error' listener, a spawn failure (missing binary, EACCES, etc.) either throws
    // an uncaught exception (Node's EventEmitter special-cases unhandled 'error') or leaves this
    // promise unresolved forever if 'close' never follows -- record it as a normal task failure
    // instead, matching how this function already reports any other subprocess failure.
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n[QA] Failed to spawn subprocess: ${err.message}\n`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function taskEnv(workHome: string, timeoutMs: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: workHome,
    USERPROFILE: workHome,
    // Do not set OPENCLAW_HOME — openclaw resolves state from HOME/.openclaw; setting it breaks plugin load.
    OPENCLAW_HYBRID_MEM_MAINTENANCE_TIMEOUT_MS: String(timeoutMs),
    OPENCLAW_MEMORY_EXTENSION_DIR: PLUGIN_ROOT,
    OPENCLAW_EXTENSION_DIR: PLUGIN_ROOT,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase in QA_PHASE_TIMEOUT_MS ? args.phase : "fast";
  const timeoutMs = QA_PHASE_TIMEOUT_MS[phase];
  const wallTimeoutMs = timeoutMs + 30_000;

  if (!existsSync(join(SANDBOX_TEMPLATE, ".openclaw/memory/facts.db"))) {
    console.log("==> Building sandbox template...");
    runScript(join(__dirname, "setup-sandbox.sh"));
  }

  const workHome = SANDBOX_WORK;
  if (args.reset && !args.resume) {
    console.log("==> Resetting work copy from template...");
    runScript(join(__dirname, "clone-sandbox.sh"));
  } else if (!existsSync(join(workHome, ".openclaw/memory/facts.db"))) {
    runScript(join(__dirname, "clone-sandbox.sh"));
  }

  let state = args.resume || args.redo ? loadState() : null;
  if (!state) {
    state = initState(phase, workHome);
  } else if (state.phase !== phase) {
    // Phase upgrade: keep passed/skipped from prior phase; rerun failed/pending at new timeout.
    state.phase = phase;
    for (const t of state.tasks) {
      t.phase = phase;
      if (t.status === "failed" || t.status === "running") t.status = "pending";
    }
  }
  state.timeoutMs = timeoutMs;
  state.workHome = workHome;
  saveState(state);

  const outTasksDir = join(QA_ROOT, "out", state.runId, "tasks");
  mkdirSync(outTasksDir, { recursive: true });

  console.log(`==> Maintenance QA phase=${phase} timeout=${timeoutMs / 1000}s HOME=${workHome}`);
  console.log(`    Report: ${REPORT_PATH}`);
  console.log(`    State:  ${STATE_PATH}`);

  // Preflight: config view
  const preflight = spawnSync("node", [NODE_WRAPPER, "openclaw", "hybrid-mem", "config"], {
    env: taskEnv(workHome, timeoutMs),
    encoding: "utf-8",
    cwd: PLUGIN_ROOT,
    maxBuffer: 5 * 1024 * 1024,
  });
  writeFileSync(join(outTasksDir, "00-preflight-config.txt"), preflight.stdout + preflight.stderr);
  const embedPreflight = spawnSync("node", [NODE_WRAPPER, "openclaw", "hybrid-mem", "verify"], {
    env: taskEnv(workHome, timeoutMs),
    encoding: "utf-8",
    cwd: PLUGIN_ROOT,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(outTasksDir, "00-preflight-verify.txt"), embedPreflight.stdout + embedPreflight.stderr);
  if (/401 status code|EMBEDDING CHECK FAILED/i.test(embedPreflight.stdout + embedPreflight.stderr)) {
    state.todos.push("Preflight: embedding auth failed — run npm run offline-qa:fetch-secrets and rebuild sandbox");
    saveState(state);
  }
  if (
    /azure-foundry|openai\/gpt/i.test(preflight.stdout + preflight.stderr) &&
    /maintenance.*minimax/i.test(preflight.stdout + preflight.stderr)
  ) {
    // Help text mentions azure examples; resolved chains show minimax — ok
  } else if (/azure-foundry\/|openai\/gpt-[45]/i.test(preflight.stdout + preflight.stderr)) {
    state.todos.push("Preflight: config still references non-MiniMax providers — check sandbox openclaw.json");
  }

  for (let i = 0; i < QA_TASK_PLAN.length; i++) {
    const spec = QA_TASK_PLAN[i];
    const taskState = state.tasks[i];

    if (args.redo && spec.id !== args.redo) continue;
    if (args.resume && taskState.status === "passed" && !args.redo) continue;

    taskState.status = "running";
    taskState.attempts += 1;
    saveState(state);

    const logPath = join(outTasksDir, `${String(i + 1).padStart(2, "0")}-${spec.id}.log`);
    console.log(`\n==> [${i + 1}/${QA_TASK_PLAN.length}] ${spec.id} ${spec.args.join(" ")}`);

    const started = Date.now();
    const result = await runTaskSubprocess(spec.args, taskEnv(workHome, timeoutMs), wallTimeoutMs);
    const durationMs = Date.now() - started;
    let combined = result.stdout + result.stderr;
    if (result.timedOut) {
      combined += `\n[QA] Wall-clock timeout after ${wallTimeoutMs}ms\n`;
    }
    writeFileSync(logPath, combined);

    const analysis = analyzeTaskResult(spec, combined, result.exitCode, durationMs);
    if (result.timedOut) analysis.errors.push(`Wall timeout ${wallTimeoutMs}ms`);
    if (/unknown command|not a command|Cannot find/i.test(combined) && spec.skipIfCommandMissing) {
      analysis.classification = "skipped";
      analysis.usefulness = "Command not registered — skip on live unless wired";
      analysis.errors = analysis.errors.filter((e) => !e.startsWith("Process exit code"));
      taskState.status = "skipped";
    } else if (analysis.classification === "needs-fix" || analysis.classification === "test-bug") {
      taskState.status = "failed";
      state.todos.push(`Fix ${spec.id}: ${analysis.errors.join("; ") || analysis.usefulness}`);
    } else {
      taskState.status = "passed";
    }

    taskState.exitCode = result.exitCode;
    taskState.durationMs = durationMs;
    taskState.logPath = logPath;
    taskState.classification = analysis.classification;
    taskState.analysis = analysis;
    saveState(state);

    console.log(
      `    ${taskState.status} | ${analysis.classification} | ${(durationMs / 1000).toFixed(1)}s | exit=${result.exitCode}`,
    );
    if (analysis.errors.length) console.log(`    errors: ${analysis.errors.join("; ")}`);
  }

  writeReport(state);
  console.log(`\n==> Done. Report: ${REPORT_PATH}`);

  const failed = state.tasks.filter((t) => t.status === "failed");
  process.exit(failed.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
