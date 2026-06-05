import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findQuarantinedSkillDir,
  quarantineCrystallizedSkillOnDisk,
  removeCrystallizedSkillDir,
  restoreCrystallizedSkillOnDisk,
} from "../services/crystallization-disk.js";

describe("crystallization-disk", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("moves skill directory to crystallization-quarantine on disk quarantine", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "crystal-disk-"));
    const outputDir = join(tmpDir, "skills");
    const skillDir = join(outputDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# skill\n", "utf-8");

    const result = quarantineCrystallizedSkillOnDisk(skillPath, outputDir);
    expect(result.movedTo).toBeDefined();
    expect(existsSync(skillPath)).toBe(false);
    expect(readFileSync(join(result.movedTo!, "SKILL.md"), "utf-8")).toBe("# skill\n");
    expect(findQuarantinedSkillDir("my-skill", outputDir)).toBe(result.movedTo);
  });

  it("removeCrystallizedSkillDir deletes skill directory including sidecars", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "crystal-disk-rm-"));
    const skillDir = join(tmpDir, "rollback-skill");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# rollback\n", "utf-8");
    writeFileSync(join(skillDir, "scripts", "run.sh"), "#!/bin/bash\n", "utf-8");

    removeCrystallizedSkillDir(skillPath);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("restoreCrystallizedSkillOnDisk moves quarantined skill back to active output tree", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "crystal-disk-restore-"));
    const outputDir = join(tmpDir, "skills");
    const skillDir = join(outputDir, "restore-me");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# restore\n", "utf-8");

    const quarantined = quarantineCrystallizedSkillOnDisk(skillPath, outputDir);
    expect(quarantined.movedTo).toBeDefined();

    const restored = restoreCrystallizedSkillOnDisk(quarantined.movedTo!, outputDir, "restore-me");
    expect(restored.outputPath).toBe(join(outputDir, "restore-me", "SKILL.md"));
    expect(existsSync(restored.outputPath!)).toBe(true);
    expect(existsSync(quarantined.movedTo!)).toBe(false);
  });
});
