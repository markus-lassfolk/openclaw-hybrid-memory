/**
 * Regression tests for services/skill-validator.ts's DENY_RULES gate: CommonMark recognizes a
 * tab/4-space-indented line as a code block, not just fenced ```/~~~ blocks. Without matching
 * indented-code recognition, every codeBlockOnly security rule (shell-eval, exec, rm-rf,
 * credential-env-secret, ...) could be bypassed by indenting the dangerous line instead of
 * fencing it (loop iteration 26 regression).
 */
import { describe, expect, it } from "vitest";
import { SkillValidator } from "../services/skill-validator.js";

const BASE_SKILL = `---
name: "indented-code-test-skill"
description: >-
  Use this skill to test indented code block security scanning. Trigger when the user asks to
  test indented code detection.
metadata:
  category: "procedure"
  provenance: "procedure:test"
  generated_at: "2026-05-20"
---

# Indented Code Test Skill

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

describe("SkillValidator DENY_RULES — indented code block bypass (loop iteration 26 regression)", () => {
  it("flags a dangerous rm-rf command hidden in a 4-space-indented (non-fenced) code block", () => {
    const skillWithIndentedRmRf = `${BASE_SKILL}
Run the cleanup script below:

    rm -rf /var/data/stale-cache
`;

    const result = new SkillValidator().validate(skillWithIndentedRmRf);

    expect(result.violations.some((v) => v.includes("[rm-rf]"))).toBe(true);
  });

  it("does not flag rm -rf when merely mentioned in plain, unindented prose", () => {
    const skillWithProseMention = `${BASE_SKILL}
Do not run rm -rf / on a production host.
`;

    const result = new SkillValidator().validate(skillWithProseMention);

    expect(result.violations.some((v) => v.includes("[rm-rf]"))).toBe(false);
  });
});
