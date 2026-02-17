import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
        { tool: "web_fetch", args: { url: "https://api.example.com/agents" } },
        { tool: "message", args: { text: "Done" } },
      ]),
      procedureType: "positive",
      successCount: 3,
      confidence: 0.8,
      ttlDays: 30,
    });

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: false,
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
    expect(skillContent).toContain("web_fetch");
    expect(skillContent).toContain(proc.id);

    const recipeContent = JSON.parse(readFileSync(recipePath, "utf-8"));
    expect(Array.isArray(recipeContent)).toBe(true);
    expect(recipeContent).toHaveLength(2);

    const updated = db.getProcedureById(proc.id);
    expect(updated!.promotedToSkill).toBe(1);
    expect(updated!.skillPath).toContain("check-moltbook-notifications");
  });

  it("dry-run does not write files", () => {
    db.upsertProcedure({
      taskPattern: "Dry run procedure",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 5,
    });

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        skillTTLDays: 30,
        dryRun: true,
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
