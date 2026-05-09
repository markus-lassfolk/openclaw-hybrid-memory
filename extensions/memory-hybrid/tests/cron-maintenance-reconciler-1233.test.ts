import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileHybridMemCronMaintenanceOutcomes } from "../services/cron-maintenance-reconciler.js";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readJsonl(path: string) {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("cron maintenance outcome reconciler (#1233)", () => {
  it("rewrites false-ok hybrid-mem run records with failed maintenanceStatus to error and increments job consecutiveErrors", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-reconcile-"));
    const cronDir = join(openclawDir, "cron");
    const runsDir = join(cronDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    const runAtMs = 1778296560189;
    const exitPath = join(openclawDir, "logs", "cron-hybrid-mem", "nightly-dream-cycle.exit.txt");
    const logPath = join(openclawDir, "logs", "cron-hybrid-mem", "nightly-dream-cycle.log");
    mkdirSync(join(openclawDir, "logs", "cron-hybrid-mem"), { recursive: true });
    writeFileSync(exitPath, "", "utf-8");
    writeFileSync(logPath, "reflection — loading 10687 existing pattern row(s) for dedupe\n", "utf-8");

    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify(
        {
          jobs: [
            {
              id: "hybrid-mem:nightly-dream-cycle",
              pluginJobId: "hybrid-mem:nightly-dream-cycle",
              name: "nightly-dream-cycle",
              state: { lastRunAtMs: runAtMs, lastStatus: "ok", lastRunStatus: "ok", consecutiveErrors: 0 },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const summary = `1. **FAILED**\n\nManual validation output:\n\n\`\`\`json\n${JSON.stringify(
      {
        maintenanceStatus: "failed",
        missingSteps: ["dream-cycle"],
        failedSteps: [],
        guardUpdated: false,
        logPath,
        exitPath,
        error: "Missing steps: dream-cycle",
      },
      null,
      2,
    )}\n\`\`\``;
    writeFileSync(
      join(runsDir, "hybrid-mem:nightly-dream-cycle.jsonl"),
      `${JSON.stringify({ ts: runAtMs + 100, jobId: "hybrid-mem:nightly-dream-cycle", action: "finished", status: "ok", summary, runAtMs })}\n`,
      "utf-8",
    );

    const result = reconcileHybridMemCronMaintenanceOutcomes({}, { openclawDir, nowMs: runAtMs + 60_000 });
    expect(result.runsCorrected).toBe(1);
    expect(result.jobsCorrected).toBe(1);

    const [run] = readJsonl(join(runsDir, "hybrid-mem:nightly-dream-cycle.jsonl"));
    expect(run.status).toBe("error");
    expect(run.error).toBe("Missing steps: dream-cycle");
    expect(run.diagnostics.maintenanceStatus).toBe("failed");

    const store = readJson(join(cronDir, "jobs.json"));
    const jobState = store.jobs[0].state;
    expect(jobState.lastStatus).toBe("error");
    expect(jobState.lastRunStatus).toBe("error");
    expect(jobState.consecutiveErrors).toBe(1);
    expect(jobState.lastError).toBe("Missing steps: dream-cycle");
  });

  it("validates HM_EXIT/HM_LOG paths from summary when structured JSON is absent", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-reconcile-"));
    const cronDir = join(openclawDir, "cron");
    const runsDir = join(cronDir, "runs");
    const logDir = join(openclawDir, "logs", "cron-hybrid-mem");
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    const runAtMs = Date.now();
    const exitPath = join(logDir, "nightly-memory-sweep.exit.txt");
    const logPath = join(logDir, "nightly-memory-sweep.log");
    writeFileSync(exitPath, `${new Date(runAtMs).toISOString().replace(/\.\d{3}Z$/, "Z")} prune exit=0\n`, "utf-8");
    writeFileSync(logPath, "ok so far\n", "utf-8");
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify({
        jobs: [{ id: "hybrid-mem:nightly-distill", state: { lastRunAtMs: runAtMs, consecutiveErrors: 2 } }],
      }),
      "utf-8",
    );
    writeFileSync(
      join(runsDir, "hybrid-mem:nightly-distill.jsonl"),
      `${JSON.stringify({ ts: runAtMs, jobId: "hybrid-mem:nightly-distill", status: "ok", summary: `HM_EXIT path:\n${exitPath}\nHM_LOG path:\n${logPath}`, runAtMs })}\n`,
      "utf-8",
    );

    const result = reconcileHybridMemCronMaintenanceOutcomes({}, { openclawDir, nowMs: runAtMs + 1000 });
    expect(result.runsCorrected).toBe(1);
    expect(readJsonl(join(runsDir, "hybrid-mem:nightly-distill.jsonl"))[0].status).toBe("error");
    expect(readJson(join(cronDir, "jobs.json")).jobs[0].state.consecutiveErrors).toBe(3);
  });

  it("patches duplicate-timestamp run records by tail position, not by timestamp key", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-reconcile-"));
    const cronDir = join(openclawDir, "cron");
    const runsDir = join(cronDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const runAtMs = Date.now();
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify({
        jobs: [{ id: "hybrid-mem:nightly-dream-cycle", state: { lastRunAtMs: runAtMs, consecutiveErrors: 0 } }],
      }),
      "utf-8",
    );
    const goodSummary = "SUCCESS";
    const badSummary = `1. **FAILED**

\`\`\`json
${JSON.stringify({ maintenanceStatus: "failed", error: "Missing steps: dream-cycle", missingSteps: ["dream-cycle"] })}
\`\`\``;
    const runPath = join(runsDir, "hybrid-mem:nightly-dream-cycle.jsonl");
    writeFileSync(
      runPath,
      [
        JSON.stringify({
          ts: runAtMs,
          jobId: "hybrid-mem:nightly-dream-cycle",
          status: "ok",
          summary: goodSummary,
          runAtMs,
        }),
        JSON.stringify({
          ts: runAtMs,
          jobId: "hybrid-mem:nightly-dream-cycle",
          status: "ok",
          summary: badSummary,
          runAtMs,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = reconcileHybridMemCronMaintenanceOutcomes({}, { openclawDir, nowMs: runAtMs + 1000 });
    const [first, second] = readJsonl(runPath);
    expect(result.runsCorrected).toBe(1);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("error");
  });

  it("leaves successful ok runs unchanged", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-reconcile-"));
    const cronDir = join(openclawDir, "cron");
    const runsDir = join(cronDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const runAtMs = Date.now();
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify({
        jobs: [{ id: "hybrid-mem:weekly-deep-maintenance", state: { lastRunAtMs: runAtMs, consecutiveErrors: 0 } }],
      }),
      "utf-8",
    );
    writeFileSync(
      join(runsDir, "hybrid-mem:weekly-deep-maintenance.jsonl"),
      `${JSON.stringify({ ts: runAtMs, jobId: "hybrid-mem:weekly-deep-maintenance", status: "ok", summary: "SUCCESS", runAtMs })}\n`,
      "utf-8",
    );

    const result = reconcileHybridMemCronMaintenanceOutcomes({}, { openclawDir, nowMs: runAtMs + 1000 });
    expect(result.runsCorrected).toBe(0);
    expect(readJsonl(join(runsDir, "hybrid-mem:weekly-deep-maintenance.jsonl"))[0].status).toBe("ok");
  });
});
