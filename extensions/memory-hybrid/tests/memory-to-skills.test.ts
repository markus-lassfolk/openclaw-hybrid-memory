import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getToolNamesFromRecipe,
  stepConsistency,
  distinctToolCount,
  singleToolDominanceRatio,
  isLikelyBoilerplateTaskPattern,
  isGenericSkillDescription,
  parseSynthesizedSkill,
  getExistingSkillSlugs,
} from "../services/memory-to-skills.js";
import type { ProcedureEntry } from "../types/memory.js";

function makeProcedure(recipeJson: string, taskPattern = "task"): ProcedureEntry {
  return {
    id: "test-id",
    taskPattern,
    recipeJson,
    procedureType: "positive",
    successCount: 1,
    failureCount: 0,
    lastValidated: null,
    lastFailed: null,
    confidence: 0.8,
    ttlDays: 30,
    promotedToSkill: 0,
    skillPath: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("memory-to-skills getToolNamesFromRecipe", () => {
  it("parses array of steps with tool names", () => {
    const recipe = JSON.stringify([
      { tool: "read_file", args: {} },
      { tool: "search_replace" },
      { tool: "run_terminal_cmd" },
    ]);
    expect(getToolNamesFromRecipe(recipe)).toEqual(["read_file", "search_replace", "run_terminal_cmd"]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(getToolNamesFromRecipe("not json")).toEqual([]);
  });

  it("skips steps without tool", () => {
    const recipe = JSON.stringify([{ tool: "a" }, {}, { tool: "b" }]);
    expect(getToolNamesFromRecipe(recipe)).toEqual(["a", "b"]);
  });
});

describe("memory-to-skills stepConsistency", () => {
  it("returns 1 when all procedures have same tool sequence", () => {
    const procs = [
      makeProcedure(JSON.stringify([{ tool: "a" }, { tool: "b" }])),
      makeProcedure(JSON.stringify([{ tool: "a" }, { tool: "b" }])),
      makeProcedure(JSON.stringify([{ tool: "a" }, { tool: "b" }])),
    ];
    expect(stepConsistency(procs)).toBe(1);
  });

  it("returns 0 when no procedures have steps", () => {
    const procs = [
      makeProcedure("[]"),
      makeProcedure("[]"),
    ];
    expect(stepConsistency(procs)).toBe(0);
  });

  it("returns fraction when majority matches at each position", () => {
    const procs = [
      makeProcedure(JSON.stringify([{ tool: "a" }, { tool: "b" }])),
      makeProcedure(JSON.stringify([{ tool: "a" }, { tool: "b" }])),
      makeProcedure(JSON.stringify([{ tool: "x" }, { tool: "b" }])),
    ];
    const c = stepConsistency(procs);
    expect(c).toBeGreaterThan(0.5);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe("memory-to-skills distinctToolCount", () => {
  it("counts distinct tools across procedures", () => {
    const procs = [
      makeProcedure(JSON.stringify([{ tool: "read_file" }, { tool: "search_replace" }])),
      makeProcedure(JSON.stringify([{ tool: "read_file" }, { tool: "run_terminal_cmd" }])),
    ];
    expect(distinctToolCount(procs)).toBe(3);
  });

  it("returns 0 when no steps", () => {
    expect(distinctToolCount([makeProcedure("[]")])).toBe(0);
  });
});

describe("memory-to-skills singleToolDominanceRatio", () => {
  it("returns 0 when no steps", () => {
    expect(singleToolDominanceRatio([makeProcedure("[]")])).toBe(0);
  });

  it("returns 1 when all steps are same tool", () => {
    const procs = [
      makeProcedure(JSON.stringify([{ tool: "exec" }, { tool: "exec" }, { tool: "exec" }])),
      makeProcedure(JSON.stringify([{ tool: "exec" }, { tool: "exec" }])),
    ];
    expect(singleToolDominanceRatio(procs)).toBe(1);
  });

  it("returns fraction when mixed", () => {
    const procs = [
      makeProcedure(JSON.stringify([{ tool: "a" }, { tool: "b" }, { tool: "c" }])),
      makeProcedure(JSON.stringify([{ tool: "a" }, { tool: "b" }, { tool: "c" }])),
    ];
    expect(singleToolDominanceRatio(procs)).toBe(1 / 3);
  });
});

describe("memory-to-skills isLikelyBoilerplateTaskPattern", () => {
  it("returns true for short task", () => {
    expect(isLikelyBoilerplateTaskPattern("ab")).toBe(true);
    expect(isLikelyBoilerplateTaskPattern("short")).toBe(true);
  });

  it("returns true for injected-context phrases", () => {
    expect(isLikelyBoilerplateTaskPattern("Use the relevant memories provided")).toBe(true);
    expect(isLikelyBoilerplateTaskPattern("Access relevant context for the user")).toBe(true);
    expect(isLikelyBoilerplateTaskPattern("Pre-injected memory block")).toBe(true);
  });

  it("returns false for concrete tasks", () => {
    expect(isLikelyBoilerplateTaskPattern("Deploy auth service to staging")).toBe(false);
    expect(isLikelyBoilerplateTaskPattern("Check Home Assistant health")).toBe(false);
  });
});

describe("memory-to-skills isGenericSkillDescription", () => {
  it("returns true for empty or very short", () => {
    expect(isGenericSkillDescription("")).toBe(true);
    expect(isGenericSkillDescription("short")).toBe(true);
  });

  it("returns true for vague phrases", () => {
    expect(isGenericSkillDescription("Access and review relevant memories based on the current context")).toBe(true);
    expect(isGenericSkillDescription("Do something as needed when appropriate")).toBe(true);
  });

  it("returns false for specific descriptions", () => {
    expect(isGenericSkillDescription("SSH to host and run health check script")).toBe(false);
    expect(isGenericSkillDescription("Multi-model PR review council")).toBe(false);
  });
});

describe("memory-to-skills parseSynthesizedSkill", () => {
  it("parses YAML frontmatter and body", () => {
    const raw = `---
name: council-pr-review
description: Multi-model PR review council
---

# Council PR Review
## Steps
1. Enumerate reviewers
2. Spawn agents
`;
    const out = parseSynthesizedSkill(raw);
    expect(out.name).toBe("council-pr-review");
    expect(out.description).toBe("Multi-model PR review council");
    expect(out.body).toContain("# Council PR Review");
    expect(out.body).toContain("Enumerate reviewers");
  });

  it("uses defaults when no frontmatter", () => {
    const raw = "# My Skill\n\nBody here.";
    const out = parseSynthesizedSkill(raw);
    expect(out.name).toBe("skill");
    expect(out.description).toBe("");
    expect(out.body).toBe("# My Skill\n\nBody here.");
  });

  it("strips markdown code fence wrapper", () => {
    const raw = "```markdown\n---\nname: foo-bar\ndescription: A skill\n---\n\n# Foo Bar\nBody.\n```";
    const out = parseSynthesizedSkill(raw);
    expect(out.name).toBe("foo-bar");
    expect(out.description).toBe("A skill");
    expect(out.body).toContain("# Foo Bar");
    expect(out.body).not.toMatch(/^```/);
  });
});

describe("memory-to-skills getExistingSkillSlugs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-to-skills-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty set when no skills dir", () => {
    expect(getExistingSkillSlugs(tmpDir).size).toBe(0);
  });

  it("collects slugs from skills/ and skills/auto-generated/", () => {
    mkdirSync(join(tmpDir, "skills", "foo"), { recursive: true });
    writeFileSync(join(tmpDir, "skills", "foo", "SKILL.md"), "# Foo");
    mkdirSync(join(tmpDir, "skills", "auto-generated", "bar"), { recursive: true });
    writeFileSync(join(tmpDir, "skills", "auto-generated", "bar", "SKILL.md"), "# Bar");

    const slugs = getExistingSkillSlugs(tmpDir);
    expect(slugs.has("foo")).toBe(true);
    expect(slugs.has("bar")).toBe(true);
  });

  it("ignores directories without SKILL.md", () => {
    mkdirSync(join(tmpDir, "skills", "no-skill"), { recursive: true });
    const slugs = getExistingSkillSlugs(tmpDir);
    expect(slugs.has("no-skill")).toBe(false);
  });
});
