import { describe, expect, it } from "vitest";
import { parseCronRunLog, parseJobStepFromCronRest } from "../cli/commands/manage/maintenance-log-parse.js";

describe("parseJobStepFromCronRest", () => {
  it("parses collectExitLogs line shape (job/step, stable job name)", () => {
    const rest = "my-cron-job/run-step failed exit=1 volatile excerpt about DNS failure and stack traces here";
    expect(parseJobStepFromCronRest(rest)).toEqual({
      jobName: "my-cron-job",
      step: "run-step",
    });
  });

  it("falls back to first path segment for other slash forms", () => {
    expect(parseJobStepFromCronRest("seed/memory extra")).toEqual({
      jobName: "seed",
      step: "memory",
    });
  });
});

describe("parseCronRunLog", () => {
  it("uses stable job name for grouping, not the full tail", () => {
    const log = `2025-01-01T12:00:00Z job-a/step1 failed exit=1 first error snippet
2025-01-02T12:00:00Z job-a/step1 failed exit=1 completely different volatile message`;
    const runs = parseCronRunLog(log);
    const failed = runs.filter((r) => r.status === "failure");
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.jobName === "job-a")).toBe(true);
    expect(failed.every((r) => r.step === "step1")).toBe(true);
  });

  it("keeps success when exit=0 even if the excerpt mentions failed/error", () => {
    const log =
      "2025-01-01T12:00:00Z job-a/step1 completed exit=0 recovered after earlier failed attempt; no error now";
    const runs = parseCronRunLog(log);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].exitCode).toBe(0);
  });

  it("does not promote follow-up lines to failure when run had exit=0", () => {
    const log = `2025-01-01T12:00:00Z job-a/step1 completed exit=0 ok
2025-01-01T12:00:01Z unrelated context: prior run failed with error`;
    const runs = parseCronRunLog(log);
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("success");
  });
});
