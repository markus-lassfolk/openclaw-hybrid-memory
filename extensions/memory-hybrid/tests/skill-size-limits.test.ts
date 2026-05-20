import { describe, expect, it } from "vitest";
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILE_BYTES_SAFE } from "../config/skill-size-limits.js";
import { SkillValidator } from "../services/skill-validator.js";
import { utf8ByteLength } from "../config/skill-size-limits.js";

describe("skill size limits", () => {
  it("MAX_SKILL_FILE_BYTES matches OpenClaw default 256 KB", () => {
    expect(MAX_SKILL_FILE_BYTES).toBe(256_000);
    expect(MAX_SKILL_FILE_BYTES_SAFE).toBeLessThan(MAX_SKILL_FILE_BYTES);
  });

  it("SkillValidator rejects content at hard-cap-plus-one bytes", () => {
    const base = `---\nname: test-skill\ndescription: "Test skill for byte boundary"\nmetadata:\n  category: procedure\n  provenance: procedure:test\n---\n\n# Test\n\n## When to Activate\nUse for testing.\n\n## Scope\nBounded.\n\n## Do Not Use When\nNever destructive.\n\n## Workflow\n1. Verify output.\n\n## Verification\nConfirm exit code 0.\n\n## Anti-patterns / Known Failures\n- Avoid dumps.\n\n## Examples\n- Good: run test.\n\n## Provenance\n- Source: test\n`;
    const pad = "x".repeat(MAX_SKILL_FILE_BYTES_SAFE - utf8ByteLength(base) + 1);
    const oversized = `${base}\n${pad}`;
    const validator = new SkillValidator();
    const result = validator.validate(oversized);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("bytes"))).toBe(true);
  });
});
