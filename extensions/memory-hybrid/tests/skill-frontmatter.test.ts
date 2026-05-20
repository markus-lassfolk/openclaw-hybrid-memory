import { describe, expect, it } from "vitest";
import {
  formatProcedureSkillFrontmatter,
  parseSkillFrontmatterKeys,
  validateSkillCreatorFrontmatterKeys,
} from "../services/skill-frontmatter.js";

describe("skill-frontmatter", () => {
  it("emits valid YAML for colon-bearing descriptions", () => {
    const block = formatProcedureSkillFrontmatter({
      name: "check-moltbook-notifications",
      description:
        'Use when the user asks to Check Moltbook notifications. Trigger examples: "Check Moltbook notifications", "run the validated moltbook workflow". Do not use for destructive changes.',
      category: "procedure",
      provenance: "procedure:2d94a740-ce22-4a93-acb6-7adad9407093",
      generatedAt: "2026-05-20",
    });
    expect(block).toContain("description:");
    expect(block).toContain("metadata:");
    expect(block).toContain("category:");
    expect(block).not.toMatch(/^category:/m);
    const violations = validateSkillCreatorFrontmatterKeys(block.split("---\n")[1]?.split("\n---")[0] ?? "");
    expect(violations).toEqual([]);
    const keys = parseSkillFrontmatterKeys(block.split("---\n")[1]?.split("\n---")[0] ?? "");
    expect(keys.get("name")).toBe("check-moltbook-notifications");
    expect(keys.get("metadata.category")).toBe("procedure");
    expect(keys.get("metadata.provenance")).toContain("procedure:");
  });

  it("parses multi-line double-quoted description with preserved newlines", () => {
    const body = [
      'description: "Use when the user asks',
      "  to check notifications.",
      '  Second line here."',
      "metadata:",
      "  category: procedure",
    ].join("\n");
    const keys = parseSkillFrontmatterKeys(body);
    expect(keys.get("description")).toBe("Use when the user asks\n  to check notifications.\n  Second line here.");
  });
});
