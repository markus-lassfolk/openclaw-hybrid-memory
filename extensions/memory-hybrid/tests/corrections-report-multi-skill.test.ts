import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyParsedCorrectionRules,
  formatSkillUpdateProposal,
  parseReportRulesForApply,
  resolveSkillUpdateTarget,
} from "../services/corrections-report.js";
import { listWorkspaceSkillTargets } from "../utils/skill-discovery.js";

function writeSkill(workspaceRoot: string, relDir: string, body = "# Skill\n"): string {
  const dir = join(workspaceRoot, relDir);
  mkdirSync(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, body, "utf-8");
  return skillPath;
}

describe("SKILL_UPDATE multi-skill resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "corrections-multi-"));
    writeSkill(tmpDir, "skills/hybrid-memory", "# Hybrid\n");
    writeSkill(tmpDir, "skills/auto/deploy-check", "# Deploy\n");
    writeSkill(tmpDir, "skills/auto/notify-user", "# Notify\n");
  });

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("listWorkspaceSkillTargets indexes top-level and auto skills", () => {
    const targets = listWorkspaceSkillTargets(tmpDir);
    expect(targets).toEqual(
      expect.arrayContaining([
        { slug: "deploy-check", relPath: "skills/auto/deploy-check/SKILL.md" },
        { slug: "hybrid-memory", relPath: "skills/hybrid-memory/SKILL.md" },
        { slug: "notify-user", relPath: "skills/auto/notify-user/SKILL.md" },
      ]),
    );
    expect(targets).toHaveLength(3);
  });

  it("resolves slug to the correct skill among many", () => {
    const deploy = resolveSkillUpdateTarget("[SKILL_UPDATE] deploy-check: Verify health endpoint", tmpDir);
    const hybrid = resolveSkillUpdateTarget("[SKILL_UPDATE] hybrid-memory: Confirm memory_store result", tmpDir);
    expect(deploy?.skillPath).toBe(join(tmpDir, "skills/auto/deploy-check/SKILL.md"));
    expect(hybrid?.skillPath).toBe(join(tmpDir, "skills/hybrid-memory/SKILL.md"));
  });

  it("resolves auto/slug format for skills under skills/auto", () => {
    const resolved = resolveSkillUpdateTarget("[SKILL_UPDATE] auto/notify-user: Ping before closing task", tmpDir);
    expect(resolved?.skillPath).toBe(join(tmpDir, "skills/auto/notify-user/SKILL.md"));
  });

  it("resolves explicit skills/auto/.../SKILL.md paths", () => {
    const resolved = resolveSkillUpdateTarget(
      "[SKILL_UPDATE] skills/auto/deploy-check/SKILL.md: Add rollback step",
      tmpDir,
    );
    expect(resolved?.skillPath).toBe(join(tmpDir, "skills/auto/deploy-check/SKILL.md"));
  });

  it("does not resolve free text when multiple skills exist", () => {
    expect(resolveSkillUpdateTarget("[SKILL_UPDATE] Add verification step before deploy", tmpDir)).toBeNull();
    const formatted = formatSkillUpdateProposal("Add verification step before deploy", tmpDir);
    expect(formatted).toBe("[SKILL_UPDATE] Add verification step before deploy");
  });

  it("does not resolve unknown slug", () => {
    const parsed = parseReportRulesForApply(
      ["## Proposed (review before applying)", "", "- [SKILL_UPDATE] missing-skill: Do thing", ""].join("\n"),
      tmpDir,
    );
    expect(parsed.skillUpdates).toHaveLength(0);
    expect(parsed.unresolvedSkillUpdates).toEqual(["missing-skill: Do thing"]);
  });

  it("prefers skills/foo over skills/auto/foo when slug collides", () => {
    writeSkill(tmpDir, "skills/shared-name", "# Top\n");
    writeSkill(tmpDir, "skills/auto/shared-name", "# Auto\n");
    const top = resolveSkillUpdateTarget("[SKILL_UPDATE] shared-name: Top-level change", tmpDir);
    const auto = resolveSkillUpdateTarget("[SKILL_UPDATE] auto/shared-name: Auto change", tmpDir);
    expect(top?.skillPath).toBe(join(tmpDir, "skills/shared-name/SKILL.md"));
    expect(auto?.skillPath).toBe(join(tmpDir, "skills/auto/shared-name/SKILL.md"));

    const targets = listWorkspaceSkillTargets(tmpDir);
    expect(targets).toEqual(
      expect.arrayContaining([
        { slug: "shared-name", relPath: "skills/shared-name/SKILL.md" },
        { slug: "auto/shared-name", relPath: "skills/auto/shared-name/SKILL.md" },
      ]),
    );
  });

  it("applyParsedCorrectionRules updates the correct skill files in a multi-skill report", () => {
    const report = [
      "## Proposed (review before applying)",
      "",
      "- [SKILL_UPDATE] hybrid-memory: Always confirm memory_store success",
      "- [SKILL_UPDATE] deploy-check: Check /health before deploy",
      "",
    ].join("\n");
    const parsed = parseReportRulesForApply(report, tmpDir);
    expect(parsed.skillUpdates).toHaveLength(2);
    expect(parsed.unresolvedSkillUpdates).toHaveLength(0);

    const { applied, errors } = applyParsedCorrectionRules({
      workspaceRoot: tmpDir,
      toolsSection: "Self-correction rules",
      parsed,
    });
    expect(errors).toEqual([]);
    expect(applied).toBe(2);

    expect(readFileSync(join(tmpDir, "skills/hybrid-memory/SKILL.md"), "utf-8")).toContain(
      "Always confirm memory_store success",
    );
    expect(readFileSync(join(tmpDir, "skills/auto/deploy-check/SKILL.md"), "utf-8")).toContain(
      "Check /health before deploy",
    );
  });

  it("formatSkillUpdateProposal normalizes slugs to explicit paths in reports", () => {
    const formatted = formatSkillUpdateProposal("deploy-check: Add smoke test", tmpDir);
    expect(formatted).toBe("[SKILL_UPDATE] skills/auto/deploy-check/SKILL.md: Add smoke test");
  });

  it("rejects explicit path when SKILL.md does not exist", () => {
    expect(resolveSkillUpdateTarget("[SKILL_UPDATE] skills/auto/nonexistent/SKILL.md: Change", tmpDir)).toBeNull();
  });
});
