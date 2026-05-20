import { describe, expect, it } from "vitest";
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILE_BYTES_SAFE, utf8ByteLength } from "../config/skill-size-limits.js";
import { SkillValidator } from "../services/skill-validator.js";

const MINIMAL_PROCEDURE_SKILL = `---
name: "checking-test-skill"
description: >-
  Use this skill to check test notifications. Trigger when the user asks to check test notifications.
metadata:
  category: "procedure"
  provenance: "procedure:test"
  generated_at: "2026-05-20"
---

# Checking Test Skill

## Do Not Use When
- Destructive operations without approval.

## Workflow
1. Inspect test state via read-only tool.
2. Verify output matches expectations.

## Verification
- Confirm exit code 0 before reporting success.

## Examples
- User: "Check test notifications" → run workflow and verify output.
`;

describe("skill size limits", () => {
  it("MAX_SKILL_FILE_BYTES matches OpenClaw default 256 KB", () => {
    expect(MAX_SKILL_FILE_BYTES).toBe(256_000);
    expect(MAX_SKILL_FILE_BYTES_SAFE).toBeLessThan(MAX_SKILL_FILE_BYTES);
  });

  it("SkillValidator rejects content above safe write target", () => {
    const pad = "x".repeat(MAX_SKILL_FILE_BYTES_SAFE - utf8ByteLength(MINIMAL_PROCEDURE_SKILL) + 1);
    const oversized = `${MINIMAL_PROCEDURE_SKILL}\n${pad}`;
    const result = new SkillValidator().validate(oversized);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("bytes"))).toBe(true);
  });

  it("SkillValidator rejects raw file bytes above OpenClaw hard cap even with leading HTML comments", () => {
    const commentPad = "c".repeat(MAX_SKILL_FILE_BYTES);
    const withComments = `<!-- ${commentPad} -->\n${MINIMAL_PROCEDURE_SKILL}`;
    expect(utf8ByteLength(withComments)).toBeGreaterThan(MAX_SKILL_FILE_BYTES);
    const result = new SkillValidator().validate(withComments);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("OpenClaw loader byte limit"))).toBe(true);
  });

  it("SkillValidator rejects content one byte over OpenClaw hard cap", () => {
    const pad = "x".repeat(MAX_SKILL_FILE_BYTES - utf8ByteLength(MINIMAL_PROCEDURE_SKILL) + 1);
    const oversized = `${MINIMAL_PROCEDURE_SKILL}\n${pad}`;
    const result = new SkillValidator().validate(oversized);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("OpenClaw loader byte limit"))).toBe(true);
  });
});
