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

describe("corrections-report", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "corrections-report-"));
  });

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("routes AGENTS_RULE to inferTargetFile not AGENTS.md", () => {
    const report = [
      "## Proposed (review before applying)",
      "",
      "- [AGENTS_RULE] Be proactive and break tasks into milestones",
      "",
    ].join("\n");
    const parsed = parseReportRulesForApply(report, tmpDir);
    expect(parsed.agentsRulesByFile.has("SOUL.md")).toBe(true);
    expect(parsed.agentsRulesByFile.has("AGENTS.md")).toBe(false);
  });

  it("resolves SKILL_UPDATE to skills path", () => {
    const skillDir = join(tmpDir, "skills", "hybrid-memory");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill\n", "utf-8");
    const resolved = resolveSkillUpdateTarget(
      "[SKILL_UPDATE] skills/hybrid-memory/SKILL.md: Add verification step",
      tmpDir,
    );
    expect(resolved?.skillPath).toBe(join(skillDir, "SKILL.md"));
  });

  it("applyParsedCorrectionRules creates TOOLS.md when missing", () => {
    const report = ["## Suggested TOOLS.md rules", "", "- Always confirm before delete", ""].join("\n");
    const parsed = parseReportRulesForApply(report, tmpDir);
    const { applied } = applyParsedCorrectionRules({
      workspaceRoot: tmpDir,
      toolsSection: "Self-correction rules",
      parsed,
    });
    expect(applied).toBe(1);
    expect(readFileSync(join(tmpDir, "TOOLS.md"), "utf-8")).toContain("Always confirm before delete");
  });

  it("formatSkillUpdateProposal adds skills path when skill exists", () => {
    const skillDir = join(tmpDir, "skills", "hybrid-memory");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill\n", "utf-8");
    const formatted = formatSkillUpdateProposal("hybrid-memory: Add verification step before deploy", tmpDir);
    expect(formatted).toContain("skills/hybrid-memory/SKILL.md");
    expect(formatted).toContain("Add verification step");
  });
});
