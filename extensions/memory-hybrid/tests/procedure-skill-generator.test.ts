import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { generateAutoSkills } from "../services/procedure-skill-generator.js";

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

describe("generateAutoSkills", () => {
  it("generates SKILL.md and recipe.json for validated procedure", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Check Moltbook notifications",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "notifications.json" }, summary: "Check notification state" },
        { tool: "exec", args: { command: "npm test" }, summary: "Run validation test" },
        { tool: "read", args: { path: "report.json" }, summary: "Verify report output" },
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

  it("dry-run does not write files", () => {
    db.upsertProcedure({
      taskPattern: "Dry run procedure",
      recipeJson: JSON.stringify([
        { tool: "read", args: { path: "input.json" }, summary: "Check input" },
        { tool: "exec", args: { command: "npm test" }, summary: "Run validation test" },
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
  });
});
