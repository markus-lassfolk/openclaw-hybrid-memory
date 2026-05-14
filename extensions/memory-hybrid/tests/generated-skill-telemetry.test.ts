import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerSkillsCommands } from "../cli/skills.js";

let tmpDir: string;
let db: FactsDB;

beforeEach(() => {
  process.exitCode = undefined;
  tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-telemetry-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function createGeneratedSkill(taskPattern = "Validate release health report"): { id: string; skillName: string } {
  const proc = db.upsertProcedure({
    taskPattern,
    recipeJson: JSON.stringify([
      { tool: "read", args: { path: "status.json" }, summary: "Read status" },
      { tool: "exec", args: { command: "npm test" }, summary: "Run validation" },
    ]),
    procedureType: "positive",
    successCount: 3,
    confidence: 0.9,
    sourceSessionId: "session-1",
  });
  const skillName = "validate-release-health-report";
  db.markProcedurePromoted(proc.id, `skills/auto/${skillName}`);
  return { id: proc.id, skillName };
}

describe("generated skill telemetry", () => {
  it("promotes experimental skills after repeated successful activations without correction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const { skillName } = createGeneratedSkill();

    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "validate release health report",
      taskOutcome: "success",
      savedToolCalls: 2,
    });
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "run validated release health workflow",
      taskOutcome: "success",
      savedToolCalls: 1,
    });
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "validate release health report again",
      taskOutcome: "success",
      savedTimeMs: 4000,
    });

    const skill = db.getGeneratedSkillByName(skillName);
    const report = db.buildGeneratedSkillTelemetryReport({ skillName });

    expect(skill?.skillState).toBe("trusted");
    expect(report.rows[0]?.metrics.activationCountPerWeek).toBe(3);
    expect(report.rows[0]?.metrics.successRate).toBe(1);
    expect(report.rows[0]?.flags.promotionCandidate).toBe(false);
    expect(report.rows[0]?.recommendation).toBe("observe");
    expect(report.rows[0]?.metrics.savedToolCalls).toBe(3);
    expect(report.rows[0]?.metrics.savedTimeMs).toBe(4000);
    expect(report.rows[0]?.metrics.lastUsedAt).not.toBeNull();
  });

  it("marks a specific activation as false-positive and demotes over-triggering skills", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const { skillName } = createGeneratedSkill();

    const activation = db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "validate release health report",
      taskOutcome: "success",
    });

    const corrected = db.markGeneratedSkillTelemetryFalsePositive(activation.id, "user said this was unrelated");
    expect(corrected?.userCorrection).toBe(true);

    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "another unrelated request",
      taskOutcome: "failure",
      userCorrection: true,
    });
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "one more unrelated request",
      taskOutcome: "partial",
      causedRework: true,
    });

    const skill = db.getGeneratedSkillByName(skillName);
    const report = db.buildGeneratedSkillTelemetryReport({ skillName });

    expect(skill?.skillState).toBe("demoted");
    expect(report.rows[0]?.metrics.falsePositiveSignals).toBe(3);
    expect(report.rows[0]?.metrics.correctionCount).toBe(2);
    expect(report.rows[0]?.metrics.repeatedCorrectionCount).toBe(0);
    expect(report.rows[0]?.flags.overTriggering).toBe(true);
    expect(report.rows[0]?.recommendation).toBe("demote");
  });

  it("archives generated skills that are never used after the configured period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const { id, skillName } = createGeneratedSkill();
    db.getRawDb()
      .prepare("UPDATE procedures SET skill_generated_at = ?, updated_at = ? WHERE id = ?")
      .run(
        Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000),
        Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000),
        id,
      );

    const report = db.buildGeneratedSkillTelemetryReport({ skillName });
    const skill = db.getGeneratedSkillByName(skillName);

    expect(skill?.skillState).toBe("archived");
    expect(report.rows[0]?.flags.neverUsed).toBe(true);
    expect(report.rows[0]?.flags.archiveCandidate).toBe(true);
    expect(report.rows[0]?.recommendation).toBe("archive");
  });

  it("accepts procedureId when it matches the promoted skill for the same skill name", () => {
    const { id, skillName } = createGeneratedSkill();
    db.recordGeneratedSkillTelemetry({
      skillName,
      procedureId: id,
      decision: "selected",
      requestSummary: "validate release health report",
      taskOutcome: "success",
    });
    const skill = db.getGeneratedSkillByName(skillName);
    expect(skill?.id).toBe(id);
  });

  it("rejects procedureId that is not a promoted generated skill", () => {
    const { skillName } = createGeneratedSkill();
    const other = db.upsertProcedure({
      taskPattern: "Unrelated workflow pattern",
      recipeJson: JSON.stringify([{ tool: "read", args: {}, summary: "Read" }]),
      procedureType: "positive",
      successCount: 1,
      confidence: 0.5,
      sourceSessionId: "session-other",
    });
    expect(() =>
      db.recordGeneratedSkillTelemetry({
        skillName,
        procedureId: other.id,
        decision: "selected",
        requestSummary: "validate release health report",
        taskOutcome: "success",
      }),
    ).toThrow(/not a promoted generated skill/);
  });

  it("rejects procedureId when skill_path does not match skillName", () => {
    const procA = db.upsertProcedure({
      taskPattern: "Alpha workflow for telemetry mismatch",
      recipeJson: JSON.stringify([{ tool: "read", args: {}, summary: "Read" }]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "session-a",
    });
    db.markProcedurePromoted(procA.id, "skills/auto/skill-alpha-telemetry");
    const procB = db.upsertProcedure({
      taskPattern: "Beta workflow for telemetry mismatch",
      recipeJson: JSON.stringify([{ tool: "read", args: {}, summary: "Read" }]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "session-b",
    });
    db.markProcedurePromoted(procB.id, "skills/auto/skill-beta-telemetry");

    expect(() =>
      db.recordGeneratedSkillTelemetry({
        skillName: "skill-alpha-telemetry",
        procedureId: procB.id,
        decision: "selected",
        requestSummary: "validate release health report",
        taskOutcome: "success",
      }),
    ).toThrow(/skill_path does not match/);
  });

  it("exposes telemetry and demotion commands through the CLI", async () => {
    const { skillName } = createGeneratedSkill();
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "validate release health report",
      taskOutcome: "success",
    });

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, { factsDb: db, crystallizationStore: null, cfg: {} as never });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "telemetry", skillName, "--json"], { from: "user" });
    const telemetry = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { rows?: Array<{ skillName: string }> };
    expect(telemetry.rows?.[0]?.skillName).toBe(skillName);

    logSpy.mockClear();
    await program.parseAsync(["skills", "demote", skillName, "--reason", "over-triggering", "--json"], {
      from: "user",
    });
    const demoted = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      skillState?: string;
      skillStateReason?: string;
    };
    expect(demoted.skillState).toBe("demoted");
    expect(demoted.skillStateReason).toContain("over-triggering");
  });

  it("counts considered/skipped user corrections toward false-positive rate (#1416)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const { skillName } = createGeneratedSkill();
    for (let i = 0; i < 3; i++) {
      db.recordGeneratedSkillTelemetry({
        skillName,
        decision: "considered",
        requestSummary: `near-miss-${i}`,
        userCorrection: true,
        correctionReason: "should not have been offered",
      });
    }
    const report = db.buildGeneratedSkillTelemetryReport({ skillName });
    expect(report.rows[0]?.metrics.activationCountTotal).toBe(0);
    expect(report.rows[0]?.metrics.nearMissCount).toBe(3);
    expect(report.rows[0]?.metrics.falsePositiveSignals).toBe(3);
    expect(report.rows[0]?.metrics.correctionCount).toBe(3);
    expect(report.rows[0]?.metrics.falsePositiveRate).toBe(1);
    expect(report.rows[0]?.flags.overTriggering).toBe(true);
  });

  it("tracks repeated user corrections on the same request hash within 30 days (#1416)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const { skillName } = createGeneratedSkill();
    const summary = "same request context for repeat";
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: summary,
      taskOutcome: "success",
      userCorrection: true,
      correctionReason: "first",
    });
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: summary,
      taskOutcome: "failure",
      userCorrection: true,
      correctionReason: "second",
    });
    const report = db.buildGeneratedSkillTelemetryReport({ skillName });
    expect(report.rows[0]?.metrics.correctionCount).toBe(2);
    expect(report.rows[0]?.metrics.repeatedCorrectionCount).toBe(1);
  });

  it("CLI record rejects --user-correction without --reason (#1416)", async () => {
    const { skillName } = createGeneratedSkill();
    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, { factsDb: db, crystallizationStore: null, cfg: {} as never });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["skills", "record", skillName, "--decision", "selected", "--user-correction", "--json"], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
    expect(String(errSpy.mock.calls[0]?.[0] ?? "")).toMatch(/user-correction requires/i);
  });

  it("rejects telemetry record with user correction but no correctionReason", () => {
    const { skillName } = createGeneratedSkill();
    expect(() =>
      db.recordGeneratedSkillTelemetry({
        skillName,
        decision: "selected",
        requestSummary: "x",
        userCorrection: true,
      }),
    ).toThrow(/correctionReason/i);
  });

  it("CLI record maps --false-positive to caused rework without user correction (#1416)", async () => {
    const { skillName } = createGeneratedSkill();
    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, { factsDb: db, crystallizationStore: null, cfg: {} as never });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(
      ["skills", "record", skillName, "--decision", "considered", "--false-positive", "--json"],
      { from: "user" },
    );
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      activation?: { userCorrection?: boolean; causedRework?: boolean; correctionReason?: string | null };
    };
    expect(payload.activation?.userCorrection).toBe(false);
    expect(payload.activation?.causedRework).toBe(true);
    expect(payload.activation?.correctionReason).toBeFalsy();
  });
});
