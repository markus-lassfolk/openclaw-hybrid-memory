import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("offline-qa analyze-quality — sqlQuery missing sqlite3 binary (#2067-followup)", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
  });

  it("fails loudly instead of silently reporting 'good' when the sqlite3 CLI can't be launched", async () => {
    const workHome = mkdtempSync(join(tmpdir(), "offline-qa-sqlite-missing-"));
    mkdirSync(join(workHome, ".openclaw/memory"), { recursive: true });
    // sqlQuery's existsSync(dbPath) guard must see a real file before it even tries to spawn.
    writeFileSync(join(workHome, ".openclaw/memory/facts.db"), "");

    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawnSync: vi.fn(() => ({
          error: new Error("spawn sqlite3 ENOENT"),
          status: null,
          stdout: "",
          stderr: "",
        })),
      };
    });
    vi.resetModules();
    const { buildQualityReport: buildQualityReportWithMock } = await import(
      "../benchmark/offline-qa/analyze-quality.js"
    );

    expect(() => buildQualityReportWithMock(workHome, {})).toThrow(/sqlite3 CLI unavailable/);
  });
});
