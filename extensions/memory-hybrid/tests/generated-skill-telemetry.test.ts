import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { rebuildGeneratedSkillTelemetryRollupsForProcedure } from "../backends/facts-db/generated-skills.js";
import { registerSkillsCommands } from "../cli/skills.js";

let tmpDir: string;
let db: FactsDB;
let originalArgv: string[];
let originalExitCode: string | number | null | undefined;

beforeEach(() => {
  originalArgv = [...process.argv];
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-telemetry-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function createGeneratedSkill(taskPattern = "Validate release health report"): {
  id: string;
  skillName: string;
} {
  const proc = db.upsertProcedure({
    taskPattern,
    recipeJson: JSON.stringify([
      { tool: "read", args: { path: "status.json" }, summary: "Read status" },
      {
        tool: "exec",
        args: { command: "npm test" },
        summary: "Run validation",
      },
    ]),
    procedureType: "positive",
    successCount: 3,
    confidence: 0.9,
    sourceSessionId: "session-1",
  });
  const skillName = taskPattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
      correctionReason: "unrelated to task",
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
    expect(report.rows[0]?.recommendation).toBe("observe");
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
    expect(report.rows[0]?.recommendation).toBe("observe");
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
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "telemetry", skillName, "--json"], {
      from: "user",
    });
    const telemetry = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      rows?: Array<{ skillName: string }>;
    };
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

  it("round-trip: experimental → demoted → experimental → trusted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const { skillName } = createGeneratedSkill();

    // Step 1: trigger demotion via false positives (advance time so each step is distinct)
    vi.advanceTimersByTime(60_000);
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      taskOutcome: "failure",
      userCorrection: true,
      correctionReason: "first correction",
    });
    vi.advanceTimersByTime(60_000);
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      taskOutcome: "failure",
      userCorrection: true,
      correctionReason: "second correction",
    });
    vi.advanceTimersByTime(60_000);
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      taskOutcome: "partial",
      causedRework: true,
    });
    expect(db.getGeneratedSkillByName(skillName)?.skillState).toBe("demoted");

    // Step 2: operator manually resets to experimental (advances time for clean window start)
    vi.advanceTimersByTime(300_000);
    const reset = db.setGeneratedSkillLifecycleState(skillName, "experimental", "manually reset for second chance");
    expect(reset?.skillState).toBe("experimental");

    // Step 3: accumulate 3 clean successful activations after the reset window
    vi.advanceTimersByTime(60_000);
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      taskOutcome: "success",
    });
    vi.advanceTimersByTime(60_000);
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      taskOutcome: "success",
    });
    vi.advanceTimersByTime(60_000);
    db.recordGeneratedSkillTelemetry({
      skillName,
      decision: "selected",
      taskOutcome: "success",
    });
    expect(db.getGeneratedSkillByName(skillName)?.skillState).toBe("trusted");
  });

  it("skills reset CLI command moves demoted skill back to experimental", async () => {
    const { skillName } = createGeneratedSkill();
    db.setGeneratedSkillLifecycleState(skillName, "demoted", "too many false positives");

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "reset", skillName, "--reason", "agent behaviour changed", "--json"], {
      from: "user",
    });
    const result = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      skillState?: string;
      skillStateReason?: string;
    };
    expect(result.skillState).toBe("experimental");
    expect(result.skillStateReason).toContain("agent behaviour changed");
  });

  it("skills reset CLI refuses to reset a skill that is not demoted or archived", async () => {
    const { skillName } = createGeneratedSkill();
    // skill is in default experimental state

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["skills", "reset", skillName, "--reason", "test"], { from: "user" });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("experimental"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("skills reset CLI allows an uninstalled skill to be re-evaluated", async () => {
    const { skillName } = createGeneratedSkill("Uninstalled reset skill");
    db.setGeneratedSkillLifecycleState(skillName, "uninstalled", "missing on disk");

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "reset", skillName, "--reason", "reinstalled on disk", "--json"], {
      from: "user",
    });
    const result = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      skillState?: string;
    };
    expect(result.skillState).toBe("experimental");
  });

  it("skills reject CLI permanently rejects a skill", async () => {
    const { skillName } = createGeneratedSkill();

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "reject", skillName, "--reason", "bad skill", "--json"], { from: "user" });
    const result = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      skillState?: string;
    };
    expect(result.skillState).toBe("rejected");
  });

  it("skills reject CLI refuses terminal states", async () => {
    const { skillName } = createGeneratedSkill("Already uninstalled reject skill");
    db.setGeneratedSkillLifecycleState(skillName, "uninstalled", "missing on disk");

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["skills", "reject", skillName, "--reason", "bad skill"], { from: "user" });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("terminal state 'uninstalled'"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("does not archive a newly demoted old skill before the unused window elapses again", () => {
    vi.useFakeTimers();
    const generatedAt = Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000);
    const demotedAt = Math.floor(new Date("2026-05-14T10:00:00Z").getTime() / 1000);
    vi.setSystemTime(new Date(demotedAt * 1000));

    const { id, skillName } = createGeneratedSkill();
    db.getRawDb()
      .prepare("UPDATE procedures SET skill_generated_at = ?, updated_at = ? WHERE id = ?")
      .run(generatedAt, generatedAt, id);

    db.setGeneratedSkillLifecycleState(skillName, "demoted", "operator demoted for over-triggering", demotedAt);

    const report = db.buildGeneratedSkillTelemetryReport({
      skillName,
      now: demotedAt + 60,
    });
    const skill = db.getGeneratedSkillByName(skillName);

    expect(skill?.skillState).toBe("demoted");
    expect(report.rows[0]?.flags.neverUsed).toBe(true);
    expect(report.rows[0]?.flags.archiveCandidate).toBe(false);
    expect(report.rows[0]?.recommendation).toBe("observe");
  });

  it("reports unblock rather than promote while a demoted skill is eligible for reset", () => {
    vi.useFakeTimers();
    const now = Math.floor(new Date("2026-05-14T10:00:00Z").getTime() / 1000);
    vi.setSystemTime(new Date(now * 1000));

    const { skillName } = createGeneratedSkill("Skill ready for unblock recommendation");
    db.setGeneratedSkillLifecycleState(skillName, "demoted", "prior false positives", now);

    for (let i = 0; i < 5; i++) {
      db.getRawDb()
        .prepare(
          `INSERT INTO generated_skill_telemetry (id, procedure_id, skill_name, decision, task_outcome, user_correction, created_at)
           VALUES (?, (SELECT id FROM procedures WHERE skill_path LIKE ?), ?, 'selected', 'success', 0, ?)`,
        )
        .run(`manual-clean-${i}`, `%${skillName}`, skillName, now + 3600 + i);
    }

    const report = db.buildGeneratedSkillTelemetryReport({ skillName, now: now + 7200 });
    const skill = db.getGeneratedSkillByName(skillName);

    expect(skill?.skillState).toBe("experimental");
    expect(skill?.skillStateReason).toContain("auto-unblocked");
    expect(report.rows[0]?.recommendation).toBe("unblock");
  });

  it("auto-unblocks demoted skill after enough clean uses (unblockAfterCleanUses policy)", () => {
    vi.useFakeTimers();
    const now = Math.floor(new Date("2026-05-14T10:00:00Z").getTime() / 1000);
    vi.setSystemTime(new Date(now * 1000));

    const { skillName } = createGeneratedSkill();
    // Demote the skill manually (simulates prior over-triggering)
    db.setGeneratedSkillLifecycleState(skillName, "demoted", "prior false positives");

    // Advance time so telemetry comes after demotion timestamp
    const afterDemotion = now + 3600;
    vi.setSystemTime(new Date(afterDemotion * 1000));

    // Record 5 clean successful activations — default unblockAfterCleanUses is 5.
    // The internal policy evaluation triggered by the last record should auto-unblock.
    for (let i = 0; i < 5; i++) {
      db.recordGeneratedSkillTelemetry({
        skillName,
        decision: "selected",
        taskOutcome: "success",
        createdAt: afterDemotion + i,
      });
    }

    // The internal refresh triggered by the 5th telemetry record should have unblocked the skill.
    // Do NOT call refreshGeneratedSkillLifecycleState again — the auto-promotion to trusted
    // would follow on the next refresh cycle.
    const skill = db.getGeneratedSkillByName(skillName);
    expect(skill?.skillState).toBe("experimental");
    expect(skill?.skillStateReason).toContain("auto-unblocked");
  });

  it("reports unblock recommendation distinctly from promotion", () => {
    vi.useFakeTimers();
    const now = Math.floor(new Date("2026-05-14T10:00:00Z").getTime() / 1000);
    vi.setSystemTime(new Date(now * 1000));

    const { id, skillName } = createGeneratedSkill("Skill ready for unblock report");
    db.setGeneratedSkillLifecycleState(skillName, "demoted", "prior false positives", now);

    const afterDemotion = now + 3600;
    db.getRawDb().prepare("UPDATE procedures SET skill_state_changed_at = ? WHERE id = ?").run(now, id);
    db.getRawDb()
      .prepare(
        `CREATE TRIGGER block_unblock_transition
         BEFORE UPDATE OF skill_state ON procedures
         WHEN NEW.skill_state = 'experimental'
         BEGIN
           SELECT RAISE(IGNORE);
         END`,
      )
      .run();
    // Insert telemetry directly so the automatic lifecycle refresh does not consume
    // the pending unblock before the operator report can display its recommendation.
    for (let i = 0; i < 5; i++) {
      db.getRawDb()
        .prepare(
          `INSERT INTO generated_skill_telemetry (
            id, procedure_id, skill_name, skill_version, decision, task_outcome, user_correction, caused_rework, created_at
          ) VALUES (?, ?, ?, ?, 'selected', 'success', 0, 0, ?)`,
        )
        .run(`telemetry-unblock-${i}`, id, skillName, 1, afterDemotion + i);
    }

    const report = db.buildGeneratedSkillTelemetryReport({
      skillName,
      now: afterDemotion + 20,
    });

    expect(report.rows[0]?.flags.unblockCandidate).toBe(true);
    expect(report.rows[0]?.recommendation).toBe("unblock");
  });
});

describe("skills doctor — disk reconciler", () => {
  it("reports no issues when all skill paths have SKILL.md on disk", () => {
    const { skillName } = createGeneratedSkill();
    // skill path is "skills/auto/validate-release-health-report" — doesn't exist on disk
    // but we test with a real temp dir to make it pass
    const proc = db.getGeneratedSkillByName(skillName);
    expect(proc).not.toBeNull();
    if (!proc) throw new Error("expected generated skill procedure");

    // Create the skill file on disk
    const skillDir = join(tmpDir, "skills", "auto", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# test skill");

    // Update DB to point to the absolute path and sync telemetry rows with the new basename.
    db.getRawDb().prepare("UPDATE procedures SET skill_path = ? WHERE id = ?").run(skillDir, proc.id);
    db.getRawDb()
      .prepare("UPDATE generated_skill_telemetry SET skill_name = ? WHERE procedure_id = ?")
      .run(skillName, proc.id);

    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
    });
    if (report.issues.length > 0) console.error(JSON.stringify(report.issues, null, 2));
    expect(report.issues).toHaveLength(0);
    expect(report.totalChecked).toBeGreaterThan(0);
  });

  it("requires SKILL.md and reports a bare skill directory as missing", () => {
    const { skillName } = createGeneratedSkill("Bare skill directory");
    const proc = db.getGeneratedSkillByName(skillName);
    expect(proc).not.toBeNull();
    if (!proc) throw new Error("expected generated skill procedure");

    const skillDir = join(tmpDir, "skills", "auto", skillName);
    mkdirSync(skillDir, { recursive: true });
    db.getRawDb().prepare("UPDATE procedures SET skill_path = ? WHERE id = ?").run(skillDir, proc.id);

    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
    });
    const issueForThisSkill = report.issues.find((i) => i.skillName === skillName);
    expect(issueForThisSkill?.issue).toBe("missing_on_disk");
  });

  it("detects missing skill files and reports them", () => {
    createGeneratedSkill("Missing skill on disk");
    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
    });
    // The skill path points to skills/auto/... but that doesn't exist in tmpDir
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.issues[0]?.issue).toBe("missing_on_disk");
  });

  it("resolves Windows absolute skill paths without prefixing workspaceRoot", () => {
    const { skillName } = createGeneratedSkill("Windows path skill");
    const proc = db.getGeneratedSkillByName(skillName);
    expect(proc).not.toBeNull();
    if (!proc) throw new Error("expected generated skill procedure");
    db.getRawDb()
      .prepare("UPDATE procedures SET skill_path = ? WHERE id = ?")
      .run("C:\\workspace\\skills\\auto\\windows-path-skill", proc.id);

    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
    });
    const issueForThisSkill = report.issues.find((i) => i.skillName === skillName);
    expect(issueForThisSkill?.resolvedAbsolutePath).toBe("C:\\workspace\\skills\\auto\\windows-path-skill\\SKILL.md");
  });

  it("marks missing skills as uninstalled when fix=true", () => {
    const { skillName } = createGeneratedSkill("Skill that will be deleted");
    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
      fix: true,
    });
    expect(report.issues.length).toBeGreaterThan(0);
    const updated = db.getGeneratedSkillByName(skillName);
    expect(updated?.skillState).toBe("uninstalled");
    expect(report.fixedCount).toBe(1);
    expect(report.fixedProcedureIds).toContain(updated?.id);
    expect(report.issues[0]?.fixed).toBe(true);
  });

  it("does not mark stat errors as uninstalled in fix mode", () => {
    const { skillName } = createGeneratedSkill("Skill path with stat error");
    const proc = db.getGeneratedSkillByName(skillName);
    expect(proc).not.toBeNull();
    if (!proc) throw new Error("expected generated skill procedure");

    const filePath = join(tmpDir, "not-a-directory");
    writeFileSync(filePath, "not a directory");
    db.getRawDb().prepare("UPDATE procedures SET skill_path = ? WHERE id = ?").run(filePath, proc.id);

    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
      fix: true,
    });
    const issueForThisSkill = report.issues.find((i) => i.skillName === "not-a-directory");
    const updated = db.getGeneratedSkillByName(skillName);

    expect(issueForThisSkill?.issue).toBe("stat_error");
    expect(issueForThisSkill?.fixed).toBe(false);
    expect(report.fixedCount).toBe(0);
    expect(report.failedFixCount).toBeGreaterThan(0);
    expect(updated?.skillState).not.toBe("uninstalled");
  });

  it("skips already-uninstalled rows", () => {
    const { skillName } = createGeneratedSkill("Already uninstalled skill");
    db.setGeneratedSkillLifecycleState(skillName, "uninstalled", "manually uninstalled");
    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
    });
    // The already-uninstalled row should not be counted as an issue
    const issueForThisSkill = report.issues.find((i) => i.skillName === skillName);
    expect(issueForThisSkill).toBeUndefined();
  });

  it("preserves rejected terminal rows when fix=true", () => {
    const { skillName } = createGeneratedSkill("Rejected skill missing on disk");
    db.setGeneratedSkillLifecycleState(skillName, "rejected", "operator rejected");

    const report = db.reconcileGeneratedSkillDiskState({
      workspaceRoot: tmpDir,
      fix: true,
    });
    const issueForThisSkill = report.issues.find((i) => i.skillName === skillName);
    const updated = db.getGeneratedSkillByName(skillName);

    expect(issueForThisSkill).toBeUndefined();
    expect(updated?.skillState).toBe("rejected");
  });

  it("skills doctor CLI reports missing skills", async () => {
    createGeneratedSkill("Doctor test skill");

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "doctor", "--workspace", tmpDir, "--json"], { from: "user" });
    const result = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      totalChecked?: number;
      fixedCount?: number;
      issues?: Array<{ issue: string; fixed: boolean }>;
    };
    expect(result.totalChecked).toBeGreaterThan(0);
    expect(result.issues?.some((i) => i.issue === "missing_on_disk")).toBe(true);
  });

  it("skills doctor CLI exits 2 when --fix leaves stat errors unfixed", async () => {
    const { skillName } = createGeneratedSkill("Doctor partial stat error");
    const proc = db.getGeneratedSkillByName(skillName);
    expect(proc).not.toBeNull();
    if (!proc) throw new Error("expected generated skill procedure");

    const filePath = join(tmpDir, "doctor-not-a-directory");
    writeFileSync(filePath, "not a directory");
    db.getRawDb().prepare("UPDATE procedures SET skill_path = ? WHERE id = ?").run(filePath, proc.id);

    process.argv = ["node", "vitest", "hybrid-mem"];
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerSkillsCommands(program, {
      factsDb: db,
      crystallizationStore: null,
      cfg: {} as never,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["skills", "doctor", "--workspace", tmpDir, "--fix", "--json"], { from: "user" });
    const result = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      fixedCount?: number;
      failedCount?: number;
      failedFixCount?: number;
      exitCode?: number;
      issues?: Array<{ issue: string; fixed: boolean }>;
    };

    expect(result.fixedCount).toBe(0);
    expect(result.failedCount).toBeGreaterThan(0);
    expect(result.failedFixCount).toBeGreaterThan(0);
    expect(result.exitCode).toBe(2);
    expect(result.issues?.some((i) => i.issue === "stat_error" && !i.fixed)).toBe(true);
    expect(process.exitCode).toBe(2);
  });
});
