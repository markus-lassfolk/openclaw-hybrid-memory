import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { generateAutoSkillForProcedure, generateAutoSkills } from "../services/procedure-skill-generator.js";

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
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(recipePath)).toBe(true);

    const skillContent = readFileSync(skillPath, "utf-8");
    expect(skillContent).toContain("Check Moltbook notifications");
    expect(skillContent).toContain("## Workflow");
    expect(skillContent).toContain(proc.id);

    const recipeContent = JSON.parse(readFileSync(recipePath, "utf-8"));
    expect(Array.isArray(recipeContent)).toBe(true);
    expect(recipeContent).toHaveLength(3);

    const updated = db.getProcedureById(proc.id);
    expect(updated?.promotedToSkill).toBe(1);
    expect(updated?.skillPath).toContain("check-moltbook-notifications");
  });

  it("keeps collision-adjusted draft metadata aligned with the output directory", () => {
    mkdirSync(join(skillsDir, "validate-colliding-release-report"), { recursive: true });
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

  it("defaults --apply to draft-only instead of silently escalating to auto-safe", () => {
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
      drafted: 0,
      deferred: 1,
    });
    expect(result.decisions?.[0]).toMatchObject({
      action: "deferred-for-human",
      humanReviewRequired: true,
    });
    expect(existsSync(join(skillsDir, "validate-release-health-report", "SKILL.md"))).toBe(false);
  });

  it("single procedure apply also defaults to draft-only", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Validate single procedure report",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "status.json" }, summary: "Check status" },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
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
        apply: true,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "policy-blocked",
    });
    expect(existsSync(join(skillsDir, "validate-single-procedure-report", "SKILL.md"))).toBe(false);
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
