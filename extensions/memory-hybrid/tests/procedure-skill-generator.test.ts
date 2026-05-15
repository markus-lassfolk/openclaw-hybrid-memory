import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { generateAutoSkillForProcedure, generateAutoSkills } from "../services/procedure-skill-generator.js";
import { SKILL_COMPLETE_MARKER } from "../utils/atomic-write.js";

let tmpDir: string;
let db: FactsDB;
let skillsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "procedure-skill-gen-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
  skillsDir = join(tmpDir, "skills-auto");
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function recordDistinctSuccesses(procId: string): void {
  db.recordProcedureSuccess(procId, undefined, `${procId}-session-2`);
  db.recordProcedureSuccess(procId, undefined, `${procId}-session-3`);
}

describe("generateAutoSkills", () => {
  it("generates SKILL.md and recipe.json for validated procedure", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Check Moltbook notifications",
      recipeJson: JSON.stringify([
        {
          tool: "read",
          args: { path: "notifications.json" },
          summary: "Check notification state",
        },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        {
          tool: "read",
          args: { path: "report.json" },
          summary: "Verify report output",
        },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.8,
      sourceSessionId: "s1",
      ttlDays: 30,
    });

    db.recordProcedureSuccess(proc.id, undefined, "s2");
    db.recordProcedureSuccess(proc.id, undefined, "s3");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: false,
        apply: true,
        policy: "auto-safe",
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.generated).toBe(1);
    expect(result.paths).toHaveLength(1);
    const skillPath = join(skillsDir, "check-moltbook-notifications", "SKILL.md");
    const recipePath = join(skillsDir, "check-moltbook-notifications", "recipe.json");
    const proposalMetadataPath = join(skillsDir, "check-moltbook-notifications", "proposal-metadata.json");
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(recipePath)).toBe(true);
    expect(existsSync(proposalMetadataPath)).toBe(true);

    const skillContent = readFileSync(skillPath, "utf-8");
    expect(skillContent).toContain("Check Moltbook notifications");
    expect(skillContent).toContain("## Workflow");
    expect(skillContent).toContain("## Telemetry");
    expect(skillContent).toContain("openclaw hybrid-mem skills record check-moltbook-notifications");
    expect(skillContent).toContain(proc.id);

    const recipeContent = JSON.parse(readFileSync(recipePath, "utf-8"));
    expect(Array.isArray(recipeContent)).toBe(true);
    expect(recipeContent).toHaveLength(3);
    const verification = JSON.parse(
      readFileSync(join(skillsDir, "check-moltbook-notifications", "verification.json"), "utf-8"),
    ) as { lifecycleState?: string; telemetryCommand?: string; validatorScore?: number };
    expect(verification.lifecycleState).toBe("experimental");
    expect(verification.telemetryCommand).toBe("openclaw hybrid-mem skills record check-moltbook-notifications");
    expect(typeof verification.validatorScore).toBe("number");

    const proposalMetadata = JSON.parse(readFileSync(proposalMetadataPath, "utf-8"));
    expect(proposalMetadata).toMatchObject({
      source_procedures: [proc.id],
      success_count: expect.any(Number),
      failure_count: expect.any(Number),
      risk_level: expect.stringMatching(/^(low|medium|high)$/),
      validator_score: expect.any(Number),
    });

    const updated = db.getProcedureById(proc.id);
    expect(updated?.promotedToSkill).toBe(1);
    expect(updated?.skillPath).toContain("check-moltbook-notifications");
    expect(updated?.skillState).toBe("experimental");
  });

  it("keeps collision-adjusted draft metadata aligned with the output directory", () => {
    mkdirSync(join(skillsDir, "validate-colliding-release-report"), { recursive: true });
    writeFileSync(
      join(skillsDir, "validate-colliding-release-report", SKILL_COMPLETE_MARKER),
      new Date().toISOString(),
      "utf-8",
    );
    const proc = db.upsertProcedure({
      taskPattern: "Validate colliding release report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status input" },
        { tool: "exec", args: { command: "npm test" }, summary: "Run validation test" },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "collision-a1",
    });
    recordDistinctSuccesses(proc.id);

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 1,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.generated).toBe(1);
    const collidedDir = join(skillsDir, "validate-colliding-release-report-1");
    const skillContent = readFileSync(join(collidedDir, "SKILL.md"), "utf-8");
    const verification = JSON.parse(readFileSync(join(collidedDir, "verification.json"), "utf-8"));

    expect(skillContent).toContain("name: validate-colliding-release-report-1");
    expect(skillContent).toContain("# Validate Colliding Release Report 1");
    expect(verification).toMatchObject({
      skill: "validate-colliding-release-report-1",
      generatedSkillPath: join(skillsDir, "validate-colliding-release-report-1"),
    });
  });

  it("ignores incomplete atomic temp and backup directories when resolving slug collisions", () => {
    const tempDir = join(skillsDir, "validate-crashed-temp-report.tmp-1234-deadbeef");
    const backupDir = join(skillsDir, ".validate-crashed-temp-report.bak-1700000000000-deadbeef");
    for (const dir of [tempDir, backupDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "# Incomplete atomic artifact\n", "utf-8");
    }

    const proc = db.upsertProcedure({
      taskPattern: "Validate crashed temp report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status input" },
        { tool: "exec", args: { command: "npm test" }, summary: "Run validation test" },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "crashed-temp-a1",
    });
    recordDistinctSuccesses(proc.id);

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 1,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.generated).toBe(1);
    expect(result.paths).toEqual([join(skillsDir, "validate-crashed-temp-report", "SKILL.md")]);
    expect(existsSync(join(skillsDir, "validate-crashed-temp-report", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(backupDir, "SKILL.md"))).toBe(true);
  });

  it("preserves legacy skill directories that lack completion markers when resolving slug collisions", () => {
    const legacyDir = join(skillsDir, "validate-markerless-legacy-report");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "SKILL.md"),
      `---
name: unrelated-legacy-skill
description: Existing legacy skill created before completion markers.
---

# Unrelated Legacy Skill

## Workflow
1. Keep this legacy skill untouched.
`,
      "utf-8",
    );

    const proc = db.upsertProcedure({
      taskPattern: "Validate markerless legacy report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status input" },
        { tool: "exec", args: { command: "npm test" }, summary: "Run validation test" },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "legacy-markerless-a1",
    });
    recordDistinctSuccesses(proc.id);

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 1,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.generated).toBe(1);
    expect(result.paths).toEqual([join(skillsDir, "validate-markerless-legacy-report-1", "SKILL.md")]);
    expect(readFileSync(join(legacyDir, "SKILL.md"), "utf-8")).toContain("unrelated-legacy-skill");
    expect(existsSync(join(skillsDir, "validate-markerless-legacy-report-1", "SKILL.md"))).toBe(true);
  });

  it("dry-run does not write files", () => {
    db.upsertProcedure({
      taskPattern: "Dry run procedure",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "input.json" }, summary: "Check input" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 5,
      confidence: 0.9,
      sourceSessionId: "dry1",
    });

    const dryProc = db.listProcedures(1)[0];
    db.recordProcedureSuccess(dryProc.id, undefined, "dry2");
    db.recordProcedureSuccess(dryProc.id, undefined, "dry3");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: true,
        policy: "auto-safe",
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.dryRun).toBe(true);
    expect(result.generated).toBe(1);
    expect(result.paths.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(skillsDir, "dry-run-procedure", "SKILL.md"))).toBe(false);
  });

  it("detects duplicate procedures and only generates one skill", () => {
    const recipeJson = JSON.stringify([
      { tool: "read", args: { path: "status.json" }, summary: "Check status" },
      {
        tool: "exec",
        args: { command: "npm test" },
        summary: "Run validation test",
      },
      { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
    ]);
    const procA = db.upsertProcedure({
      id: "duplicate-procedure-a",
      taskPattern: "Validate duplicate procedure",
      recipeJson,
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "duplicate-dry-a1",
    });
    recordDistinctSuccesses(procA.id);
    const procB = db.upsertProcedure({
      id: "duplicate-procedure-b",
      taskPattern: "Validate duplicate procedure",
      recipeJson,
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "duplicate-dry-b1",
    });
    recordDistinctSuccesses(procB.id);

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 10,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.generated).toBe(1);
    expect(result.paths).toEqual([join(skillsDir, "validate-duplicate-procedure", "SKILL.md")]);
    expect(
      (result.decisions ?? []).filter((d) => d.action !== "deferred-for-human").map((decision) => decision.skillPath),
    ).toEqual([join(skillsDir, "validate-duplicate-procedure")]);
    expect(existsSync(join(skillsDir, "validate-duplicate-procedure", "SKILL.md"))).toBe(false);
  });

  it("uses one stable runId for every decision in a batch", () => {
    const procA = db.upsertProcedure({
      taskPattern: "Validate release report A",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "a.json" }, summary: "Read report A" },
        {
          tool: "exec",
          args: { command: "npm test -- report-a" },
          summary: "Validate report A",
        },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "runid-a1",
    });
    recordDistinctSuccesses(procA.id);
    const procB = db.upsertProcedure({
      taskPattern: "Validate release report B",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "b.json" }, summary: "Read report B" },
        {
          tool: "exec",
          args: { command: "npm test -- report-b" },
          summary: "Validate report B",
        },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "runid-b1",
    });
    recordDistinctSuccesses(procB.id);

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 10,
      },
      { info: () => {}, warn: () => {} },
    );

    const runIds = new Set(
      (result.decisions ?? [])
        .map((decision) => decision.runId)
        .filter((runId): runId is string => typeof runId === "string"),
    );
    expect(result.decisions).toHaveLength(2);
    expect(runIds.size).toBe(1);
  });

  it("legacy non-dry-run apply defaults to auto-safe and writes draft artifacts", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Validate release health report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "default-policy-1",
    });
    recordDistinctSuccesses(proc.id);

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        apply: true,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.summary).toMatchObject({
      candidates: 1,
      eligible: 1,
      drafted: 1,
      deferred: 0,
    });
    expect(result.decisions?.[0]).toMatchObject({
      action: "promoted-to-draft",
      humanReviewRequired: false,
    });
    expect(existsSync(join(skillsDir, "validate-release-health-report", "SKILL.md"))).toBe(true);
  });

  it("explicit draft-only policy blocks non-dry-run batch writes", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Validate explicit draft policy report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "explicit-draft-policy-1",
    });
    recordDistinctSuccesses(proc.id);

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        apply: true,
        policy: "draft-only",
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.summary).toMatchObject({
      candidates: 1,
      eligible: 1,
      drafted: 0,
      deferred: 1,
    });
    expect(result.decisions?.[0]).toMatchObject({
      action: "deferred-for-human",
      humanReviewRequired: true,
    });
    expect(existsSync(join(skillsDir, "validate-explicit-draft-policy-report", "SKILL.md"))).toBe(false);
  });

  it("single procedure dry-run under default draft-only policy requires human approval and writes nothing", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Validate single procedure report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "single-default-policy-1",
    });
    recordDistinctSuccesses(proc.id);

    const result = generateAutoSkillForProcedure(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        procedureId: proc.id,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "policy-blocked",
      reasons: ["policy_requires_human_approval"],
    });
    expect(existsSync(join(skillsDir, "validate-single-procedure-report", "SKILL.md"))).toBe(false);
  });

  it("single procedure legacy non-dry-run apply defaults to auto-safe and writes draft artifacts", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Validate single apply report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "single-apply-default-policy-1",
    });
    recordDistinctSuccesses(proc.id);

    const result = generateAutoSkillForProcedure(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        procedureId: proc.id,
        apply: true,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result).toMatchObject({
      ok: true,
      alreadyPromoted: false,
      dryRun: false,
      enabled: false,
    });
    expect(existsSync(join(skillsDir, "validate-single-apply-report", "SKILL.md"))).toBe(true);
  });

  it("does not count deferred procedures as generated dry-run paths", () => {
    db.upsertProcedure({
      taskPattern: "Validate low confidence dry-run report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      failureCount: 0,
      confidence: 0.1,
      sourceSessionId: "deferred-dry-run-a",
    });

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 10,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.summary).toMatchObject({
      candidates: 1,
      eligible: 0,
      deferred: 1,
      drafted: 0,
    });
    expect(result.generated).toBe(0);
    expect(result.paths).toEqual([]);
    expect(result.decisions?.[0]).toMatchObject({
      action: "deferred-for-human",
      skillPath: null,
    });
  });

  it("does not inflate failedEval for deferred/rejected procedures", () => {
    db.upsertProcedure({
      taskPattern: "Validate low confidence report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      failureCount: 5,
      confidence: 0.1,
      sourceSessionId: "failed-eval-a",
    });

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 10,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.summary).toMatchObject({
      candidates: 1,
      deferred: 1,
      failedEval: 0,
    });
  });

  it("rolls back written draft artifacts and in-run reservations when batch persistence fails", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Validate rollback batch behavior",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "rollback-batch-a",
    });
    recordDistinctSuccesses(proc.id);
    const retry = db.upsertProcedure({
      taskPattern: "Validate rollback batch behavior",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "rollback-batch-retry-a",
    });
    recordDistinctSuccesses(retry.id);

    const markSpy = vi.spyOn(db, "markProcedurePromoted").mockImplementationOnce(() => {
      throw new Error("mark failed");
    });

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 2,
      },
      { info: () => {}, warn: () => {} },
    );

    markSpy.mockRestore();

    expect(result.generated).toBe(1);
    expect(result.paths).toEqual([join(skillsDir, "validate-rollback-batch-behavior", "SKILL.md")]);
    expect(result.skipped).toBe(1);
    expect(result.summary).toMatchObject({
      eligible: 2,
      drafted: 1,
      failedValidation: 1,
      deferred: 0,
    });
    expect(result.decisions?.find((decision) => decision.procedureId === proc.id)).toMatchObject({
      action: "failed-validation",
      reasons: ["write_failed"],
    });
    expect(result.decisions?.find((decision) => decision.procedureId === retry.id)).toMatchObject({
      action: "promoted-to-draft",
      skillPath: join(skillsDir, "validate-rollback-batch-behavior"),
    });
    expect(existsSync(join(skillsDir, "validate-rollback-batch-behavior", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "validate-rollback-batch-behavior-1"))).toBe(false);
    expect(db.getProcedureById(proc.id)?.promotedToSkill).toBe(0);
    expect(db.getProcedureById(retry.id)?.promotedToSkill).toBe(1);
  });

  it("rolls back written draft artifacts when markProcedurePromoted fails for single-procedure generation", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Validate rollback single behavior",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.9,
      sourceSessionId: "rollback-single-a",
    });
    recordDistinctSuccesses(proc.id);

    const markSpy = vi.spyOn(db, "markProcedurePromoted").mockImplementation(() => {
      throw new Error("mark failed");
    });

    const result = generateAutoSkillForProcedure(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        procedureId: proc.id,
        apply: true,
        policy: "auto-safe",
      },
      { info: () => {}, warn: () => {} },
    );

    markSpy.mockRestore();

    expect(result).toMatchObject({
      ok: false,
      reason: "write-failed",
    });
    expect(existsSync(join(skillsDir, "validate-rollback-single-behavior"))).toBe(false);
    expect(db.getProcedureById(proc.id)?.promotedToSkill).toBe(0);
  });

  it("skips procedures below validation threshold", () => {
    db.upsertProcedure({
      taskPattern: "Only two successes",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 2,
    });

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.generated).toBe(0);
    expect(result.paths).toHaveLength(0);
    expect(result.summary?.candidates).toBe(0);
  });
});
