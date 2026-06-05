/**
 * Operator CLI for maintenance JobRun inspection (#1877).
 */

import { spawnSync } from "../../../utils/process-runner.js";
import {
  explainJobRun,
  findMaintenanceRunById,
  listMaintenanceRuns,
  loadJobRunSummary,
  loadOrchestratorSummary,
  resolveRunArtifacts,
} from "../../../services/maintenance-job-run/run-catalog.js";
import { MaintenanceJobRun } from "../../../services/maintenance-job-run/job-run.js";
import { type Chainable, withExit } from "../../shared.js";

export function registerMaintenanceRunCommands(maintenance: Chainable): void {
  const runCmd = maintenance.command("run").description("Inspect and resume maintenance job runs");

  runCmd
    .command("list")
    .description("List orchestrator and JobRun summaries")
    .option("--since <duration>", "Lookback window (e.g. 7d, 24h)", "7d")
    .option("--json", "Output JSON")
    .action(
      withExit(async (opts?: { since?: string; json?: boolean }) => {
        const runs = listMaintenanceRuns({ since: opts?.since });
        if (opts?.json) {
          console.log(JSON.stringify(runs, null, 2));
          return;
        }
        if (runs.length === 0) {
          console.log("No maintenance runs found.");
          return;
        }
        for (const run of runs) {
          const extra =
            run.kind === "job"
              ? ` command=${run.command} semantic=${run.semanticOutcome ?? "-"}`
              : ` exit=${run.exitCode ?? "-"}`;
          console.log(`${run.kind.padEnd(14)} ${run.id}${extra}  started=${run.startedAt ?? "-"}`);
        }
      }),
    );

  runCmd
    .command("status")
    .description("Show run status by id")
    .argument("<id>", "Run id or unique prefix")
    .option("--json", "Output JSON")
    .action(
      withExit(async (id: string, opts?: { json?: boolean }) => {
        const listed = findMaintenanceRunById(id);
        if (!listed) {
          console.error(`No maintenance run found for id: ${id}`);
          process.exitCode = 1;
          return;
        }
        if (listed.kind === "orchestrator") {
          const summary = loadOrchestratorSummary(listed.path);
          if (opts?.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
          }
          console.log(`Orchestrator run ${summary?.runId ?? id}`);
          console.log(`  tier=${summary?.tierLabel} exit=${summary?.exitCode} durationMs=${summary?.durationMs}`);
          console.log(`  ${summary?.summaryLine ?? ""}`);
          return;
        }
        const record = loadJobRunSummary(listed.path);
        if (opts?.json) {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(`JobRun ${record?.jobRunId ?? id} command=${record?.command}`);
        console.log(
          `  semantic=${record?.semanticOutcome} started=${record?.startedAt} finished=${record?.finishedAt ?? "-"}`,
        );
        if (record?.progress) {
          console.log(
            `  progress=${record.progress.completedUnits}/${record.progress.totalUnits} ${record.progress.unitLabel}`,
          );
        }
      }),
    );

  runCmd
    .command("artifacts")
    .description("List artifact paths for a run")
    .argument("<id>", "Run id or unique prefix")
    .option("--json", "Output JSON")
    .action(
      withExit(async (id: string, opts?: { json?: boolean }) => {
        const listed = findMaintenanceRunById(id);
        if (!listed) {
          console.error(`No maintenance run found for id: ${id}`);
          process.exitCode = 1;
          return;
        }
        const artifacts = resolveRunArtifacts(listed);
        if (opts?.json) {
          console.log(JSON.stringify(artifacts, null, 2));
          return;
        }
        for (const [key, path] of Object.entries(artifacts)) {
          if (path) console.log(`${key}: ${path}`);
        }
      }),
    );

  runCmd
    .command("explain")
    .description("Concise diagnosis for a run")
    .argument("<id>", "Run id or unique prefix")
    .option("--json", "Output JSON")
    .action(
      withExit(async (id: string, opts?: { json?: boolean }) => {
        const listed = findMaintenanceRunById(id);
        if (!listed) {
          console.error(`No maintenance run found for id: ${id}`);
          process.exitCode = 1;
          return;
        }
        if (listed.kind === "orchestrator") {
          const summary = loadOrchestratorSummary(listed.path);
          const failed = summary?.steps.filter((s) => s.status === "failed" || s.status === "rate_limited") ?? [];
          const diagnosis = {
            diagnosis: summary
              ? `Orchestrator ${summary.tierLabel} exit=${summary.exitCode}. ${summary.summaryLine}`
              : "Orchestrator summary unavailable.",
            failedSteps: failed.map((s) => s.name),
          };
          if (opts?.json) {
            console.log(JSON.stringify(diagnosis, null, 2));
            return;
          }
          console.log(diagnosis.diagnosis);
          if (failed.length) console.log(`Failed steps: ${failed.map((s) => s.name).join(", ")}`);
          return;
        }
        const record = loadJobRunSummary(listed.path);
        if (!record) {
          process.exitCode = 1;
          return;
        }
        const explained = explainJobRun(record, record.artifactPaths.events);
        if (opts?.json) {
          console.log(JSON.stringify(explained, null, 2));
          return;
        }
        console.log(explained.diagnosis);
        if (explained.lastEvent) console.log(`Last event: ${explained.lastEvent}`);
        if (explained.resumeHint) console.log(explained.resumeHint);
      }),
    );

  runCmd
    .command("resume")
    .description("Resume a partial JobRun")
    .argument("<id>", "JobRun id or unique prefix")
    .action(
      withExit(async (id: string) => {
        const listed = findMaintenanceRunById(id);
        if (!listed || listed.kind !== "job") {
          console.error(`No JobRun found for id: ${id}`);
          process.exitCode = 1;
          return;
        }
        const record = loadJobRunSummary(listed.path) ?? MaintenanceJobRun.load(listed.path)?.record;
        if (!record) {
          console.error("JobRun summary not readable.");
          process.exitCode = 1;
          return;
        }
        if (record.semanticOutcome !== "partial" && record.semanticOutcome !== "failed") {
          console.error(`JobRun is not resumable (semanticOutcome=${record.semanticOutcome}).`);
          process.exitCode = 1;
          return;
        }
        const argv = parseMaintenanceResumeArgv(record.resumeCommand, record.command);
        console.log(`Resuming: ${argv.join(" ")}`);
        const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status != null && result.status !== 0) {
          process.exitCode = result.status;
        }
      }),
    );
}

const MAINTENANCE_RESUME_TOKEN = /^(?:[a-z][a-z0-9-]*|--[a-z][a-z0-9-]+(?:=\S+)?)$/;

/** Parse resume argv without shell interpolation; rejects untrusted summary.json strings. */
export function parseMaintenanceResumeArgv(resumeCommand: string | undefined, command: string): string[] {
  const cmd = (resumeCommand ?? `openclaw hybrid-mem ${command}`).trim();
  const argv = cmd.split(/\s+/);
  if (argv.length < 3 || argv[0] !== "openclaw" || argv[1] !== "hybrid-mem") {
    throw new Error(`Unsafe or unsupported resume command: ${cmd}`);
  }
  for (const token of argv.slice(2)) {
    if (!MAINTENANCE_RESUME_TOKEN.test(token)) {
      throw new Error(`Unsafe or unsupported resume command: ${cmd}`);
    }
  }
  return argv;
}
