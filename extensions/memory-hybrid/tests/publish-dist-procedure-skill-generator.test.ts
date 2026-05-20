/**
 * Publish/dist integrity for procedure skill generator (issues #1544, #1548).
 * Requires `npm run build` so dist/ exists.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const require = createRequire(import.meta.url);

function isNodeSqliteAvailable(): boolean {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

const distExists = existsSync(join(distDir, "services", "procedure-skill-generator.js"));
const sqliteAvailable = isNodeSqliteAvailable();

describe.skipIf(!distExists)("publish dist procedure-skill-generator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "publish-dist-proc-skill-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports key dist modules with expected exports", async () => {
    const valMod = await import(pathToFileURL(join(distDir, "services", "skill-validator.js")).href);
    const constMod = await import(pathToFileURL(join(distDir, "utils", "constants.js")).href);
    const textMod = await import(pathToFileURL(join(distDir, "utils", "text.js")).href);
    expect(typeof valMod.SkillValidator).toBe("function");
    expect(constMod.ACTION_VERB_PATTERN).toBeInstanceOf(RegExp);
    expect(typeof textMod.stripLeadingHtmlComments).toBe("function");

    if (sqliteAvailable) {
      const genMod = await import(pathToFileURL(join(distDir, "services", "procedure-skill-generator.js")).href);
      const factsMod = await import(pathToFileURL(join(distDir, "backends", "facts-db.js")).href);
      expect(typeof genMod.generateAutoSkills).toBe("function");
      expect(typeof factsMod.FactsDB).toBe("function");
    }
  });

  it("dist generator uses advanced policy path, not legacy raw dump", () => {
    const content = readFileSync(join(distDir, "services", "procedure-skill-generator.js"), "utf-8");
    expect(content).toContain("evaluateProcedureForPromotion");
    expect(content).toContain("writeDraftSkill");
    expect(content).not.toContain("Auto-generated procedure");
    expect(content).not.toContain("## Steps (last time this worked)");
  });

  it.skipIf(!sqliteAvailable)("dist E2E: bounded procedure drafts Skill Creator-style skill", async () => {
    const { FactsDB } = await import(pathToFileURL(join(distDir, "backends", "facts-db.js")).href);
    const { generateAutoSkills } = await import(
      pathToFileURL(join(distDir, "services", "procedure-skill-generator.js")).href
    );

    const db = new FactsDB(join(tmpDir, "facts.db"));
    const skillsDir = join(tmpDir, "skills-auto");
    const recipe = JSON.stringify([
      { tool: "read", args: { path: "status.json" }, summary: "Check notification status" },
      { tool: "exec", args: { command: "npm test" }, summary: "Run validation test command" },
      { tool: "read", args: { path: "report.json" }, summary: "Verify report exists" },
    ]);
    const proc = db.upsertProcedure({
      taskPattern: "Check Moltbook notifications",
      recipeJson: recipe,
      procedureType: "positive",
      successCount: 5,
      failureCount: 0,
      confidence: 0.9,
      lastValidated: 1_700_000_000,
      sourceSessionId: "s1",
    });
    db.recordProcedureSuccess(proc.id, undefined, "s2");
    db.recordProcedureSuccess(proc.id, undefined, "s3");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.summary?.drafted).toBe(1);
    const slugDir = join(skillsDir, "check-moltbook-notifications");
    const skillMd = readFileSync(join(slugDir, "SKILL.md"), "utf-8");
    expect(skillMd.startsWith("---\n")).toBe(true);
    expect(skillMd).toContain("name:");
    expect(skillMd).toContain("metadata:");
    expect(skillMd).toContain("## Workflow");
    expect(skillMd).toContain("## Verification");
    expect(skillMd).not.toMatch(/\*\*\w+\*\*\s*\{/);
    expect(existsSync(join(slugDir, "evals", "results.json"))).toBe(true);
    db.close();
  });

  it.skipIf(!sqliteAvailable)("dist E2E: noisy trace is deferred without SKILL.md", async () => {
    const { FactsDB } = await import(pathToFileURL(join(distDir, "backends", "facts-db.js")).href);
    const { generateAutoSkills } = await import(
      pathToFileURL(join(distDir, "services", "procedure-skill-generator.js")).href
    );

    const db = new FactsDB(join(tmpDir, "facts-noisy.db"));
    const skillsDir = join(tmpDir, "skills-noisy");
    const steps = Array.from({ length: 30 }, (_, i) => ({
      tool: "read",
      summary: `scroll debug dump step ${i}`,
    }));
    const proc = db.upsertProcedure({
      taskPattern: "Noisy marathon session trace",
      recipeJson: JSON.stringify(steps),
      procedureType: "positive",
      successCount: 5,
      failureCount: 0,
      confidence: 0.9,
      lastValidated: 1_700_000_000,
      sourceSessionId: "s1",
    });
    db.recordProcedureSuccess(proc.id, undefined, "s2");
    db.recordProcedureSuccess(proc.id, undefined, "s3");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.summary?.drafted ?? 0).toBe(0);
    expect(result.deferredReasons).toContain("noisy_trace");
    expect(existsSync(join(skillsDir, "noisy-marathon-session-trace", "SKILL.md"))).toBe(false);
    db.close();
  });
});
