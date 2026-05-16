import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import {
  effectiveDemoteThresholdsForRisk,
  rebuildGeneratedSkillTelemetryRollupsForProcedure,
} from "../backends/facts-db/generated-skills.js";
import { registerSkillsCommands } from "../cli/skills.js";

let tmpDir: string;
let db: FactsDB;

beforeEach(() => {
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
  it("rollup counters stay consistent with a full rebuild (#1415 / #1400)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const { id, skillName } = createGeneratedSkill();
    for (let i = 0; i < 4; i++) {
      db.recordGeneratedSkillTelemetry({
        skillName,
        decision: "selected",
        requestSummary: `req-${i}`,
        taskOutcome: "success",
      });
    }
    const m1 = db.buildGeneratedSkillTelemetryReport({ skillName }).rows[0]?.metrics;
    rebuildGeneratedSkillTelemetryRollupsForProcedure(db.getRawDb(), id);
    const m2 = db.buildGeneratedSkillTelemetryReport({ skillName }).rows[0]?.metrics;
    expect(m1?.activationCountTotal).toBe(4);
    expect(m2).toEqual(m1);
  });

  it("keeps positive-only saved rollups consistent after rebuild", () => {
    const { id, skillName } = createGeneratedSkill();

    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "positive savings",
      taskOutcome: "success",
      savedToolCalls: 3,
      savedTimeMs: 1000,
    });
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      requestSummary: "negative savings ignored",
      taskOutcome: "success",
      savedToolCalls: -7,
      savedTimeMs: -2000,
    });

    const before = db.buildGeneratedSkillTelemetryReport({ skillName }).rows[0]?.metrics;
    rebuildGeneratedSkillTelemetryRollupsForProcedure(db.getRawDb(), id);
    const after = db.buildGeneratedSkillTelemetryReport({ skillName }).rows[0]?.metrics;

    expect(before?.savedToolCalls).toBe(3);
    expect(before?.savedTimeMs).toBe(1000);
    expect(after?.savedToolCalls).toBe(3);
    expect(after?.savedTimeMs).toBe(1000);
    expect(after).toEqual(before);
  });

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
    expect(report.rows[0]?.riskLevel).toBe("low");
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
    expect(report.rows[0]?.metrics.repeatedCorrectionCount).toBe(2);
    expect(report.rows[0]?.flags.overTriggering).toBe(true);
    expect(report.rows[0]?.recommendation).toBe("demote");
    expect(report.rows[0]?.riskLevel).toBe("low");
  });

  it("clamps risk-adjusted demote false-positive thresholds into the valid rate range", () => {
    expect(
      effectiveDemoteThresholdsForRisk("low", {
        promoteAfterSuccessfulUses: 3,
        demoteFalsePositiveRate: 0.98,
        demoteMinSamples: 3,
        archiveAfterUnusedDays: 30,
        revisionNearMissThreshold: 3,
      }).falsePositiveRate,
    ).toBe(1);
    expect(
      effectiveDemoteThresholdsForRisk("high", {
        promoteAfterSuccessfulUses: 3,
        demoteFalsePositiveRate: 0.05,
        demoteMinSamples: 3,
        archiveAfterUnusedDays: 30,
        revisionNearMissThreshold: 3,
      }).falsePositiveRate,
    ).toBe(0.1);
  });

  it("demotes high-risk generated skills earlier than low-risk under the same false-positive pressure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const safeRecipe = JSON.stringify([
      { tool: "read", args: { path: "status.json" }, summary: "Read status" },
      { tool: "exec", args: { command: "npm test" }, summary: "Run validation" },
    ]);
    const destructiveRecipe = JSON.stringify([
      { tool: "exec", args: { command: "rm -rf /tmp/x" }, summary: "delete" },
      { tool: "exec", args: { command: "echo verify" }, summary: "verify" },
    ]);

    const highProc = db.upsertProcedure({
      taskPattern: "Validate high risk telemetry demote workflow",
      recipeJson: destructiveRecipe,
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "hr-1",
    });
    const highSkill = "high-risk-fp-test";
    db.markProcedurePromoted(highProc.id, `skills/auto/${highSkill}`);

    const lowProc = db.upsertProcedure({
      taskPattern: "Validate low risk telemetry demote comparison workflow",
      recipeJson: safeRecipe,
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "lr-1",
    });
    const lowSkill = "low-risk-fp-test";
    db.markProcedurePromoted(lowProc.id, `skills/auto/${lowSkill}`);

    for (const skillName of [highSkill, lowSkill]) {
      db.recordGeneratedSkillTelemetry({
        skillName,
        decision: "selected",
        requestSummary: "first unrelated activation",
        taskOutcome: "success",
        userCorrection: true,
      });
      db.recordGeneratedSkillTelemetry({
        skillName,
        decision: "selected",
        requestSummary: "second unrelated activation",
        taskOutcome: "success",
        causedRework: true,
      });
    }

    const report = db.buildGeneratedSkillTelemetryReport();
    const highRow = report.rows.find((r) => r.skillName === highSkill);
    const lowRow = report.rows.find((r) => r.skillName === lowSkill);
    expect(highRow?.riskLevel).toBe("high");
    expect(lowRow?.riskLevel).toBe("low");
    expect(db.getGeneratedSkillByName(highSkill)?.skillState).toBe("demoted");
    expect(db.getGeneratedSkillByName(lowSkill)?.skillState).not.toBe("demoted");
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
});
