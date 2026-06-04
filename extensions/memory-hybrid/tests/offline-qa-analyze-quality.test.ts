import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildQualityReport } from "../benchmark/offline-qa/analyze-quality.js";

describe("offline-qa analyze-quality — self-correction-run", () => {
  it("flags status=failed in self-correction logs", () => {
    const workHome = mkdtempSync(join(tmpdir(), "offline-qa-sc-"));
    const logPath = join(workHome, "self-correction-run.log");
    writeFileSync(
      logPath,
      "Error: simulated first-batch LLM API failure status=failed\n2 incidents found, 0 analysed, 0 auto-fixed\n",
    );
    const report = buildQualityReport(workHome, {
      "self-correction-run": logPath,
    });
    const task = report.tasks.find((t) => t.taskId === "self-correction-run");
    expect(task?.findings).toContain("Self-correction analysis failed (parse, batch, or LLM error)");
    expect(task?.findings).toContain("2 incidents but zero analysed — parser or gate issue");
  });
});
