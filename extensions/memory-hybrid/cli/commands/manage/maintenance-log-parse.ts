/**
 * Parse cron / exit-log lines for `analyze-maintenance-logs` (no DB deps — testable without node:sqlite).
 */

export interface AnalyzedRun {
  jobName: string;
  step?: string;
  exitCode?: number;
  logPath?: string;
  status: "success" | "failure" | "skipped";
  finishedAt: number;
  durationMs: number;
  error?: string;
}

/**
 * Parse job/step from a timestamped cron line. Prefer the stable `job/step` prefix produced by
 * collectExitLogs (`jobName/step status exit=N …`) so grouping keys are not polluted by volatile excerpts.
 */
export function parseJobStepFromCronRest(rest: string): { jobName: string; step?: string } {
  const trimmed = rest.trim();
  const exitLogStyle = trimmed.match(/^([^/\s]+)\/(\S+)\s+(completed|failed)\s+exit=(\d+)\b(?:\s+(.*))?$/);
  if (exitLogStyle) {
    return { jobName: exitLogStyle[1], step: exitLogStyle[2] };
  }
  const slashIdx = trimmed.indexOf("/");
  const spaceIdx = trimmed.indexOf(" ");
  if (slashIdx > 0 && (spaceIdx < 0 || slashIdx < spaceIdx)) {
    const jobName = trimmed.slice(0, slashIdx);
    const afterSlash = trimmed.slice(slashIdx + 1);
    const stepMatch = afterSlash.match(/^(\S+)/);
    return { jobName, step: stepMatch ? stepMatch[1] : undefined };
  }
  const firstTok = trimmed.match(/^(\S+)/);
  return { jobName: firstTok ? firstTok[1] : trimmed };
}

export function parseCronRunLog(content: string): AnalyzedRun[] {
  const runs: AnalyzedRun[] = [];
  const lines = content.split("\n");

  let currentRun: Partial<AnalyzedRun> | null = null;
  for (const line of lines) {
    const startMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s+(.+)/);
    if (startMatch && !line.includes("RUNNING") && !line.includes("running")) {
      if (currentRun?.jobName && currentRun?.finishedAt) {
        runs.push(currentRun as AnalyzedRun);
      }
      const rest = startMatch[2].trim();
      const { jobName, step } = parseJobStepFromCronRest(rest);
      currentRun = {
        jobName,
        step,
        finishedAt: new Date(startMatch[1]).getTime() / 1000,
        status: /exit=(?!0\b)\d+|failed/i.test(line) ? "failure" : "success",
        exitCode: Number(line.match(/exit=(\d+)/)?.[1] ?? 0),
        durationMs: 0,
      };
    }
    if (currentRun) {
      if (/\[ERROR\]|\[FATAL\]|\[FAILURE\]|✗|failed|error/i.test(line)) {
        currentRun.status = "failure";
        currentRun.error = (currentRun.error ? currentRun.error + "; " : "") + line.trim().slice(0, 200);
      }
      if (/success|✓|completed|done/i.test(line) && !currentRun.error) {
        currentRun.status = "success";
      }
      if (/skipped|skipp/i.test(line)) {
        currentRun.status = "skipped";
      }
    }
  }
  if (currentRun?.jobName) {
    runs.push(currentRun as AnalyzedRun);
  }
  return runs;
}
