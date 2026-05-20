/**
 * In-repo Skill Creator `quick_validate.py` equivalent (#1545).
 *
 * Re-implements the Anthropic Skill Creator's name/description/structure rules
 * so we can hard-gate generation before writing skills to disk and so the same
 * regression test can run against built `dist`, not just source.
 *
 * Reference: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
 */

import { MAX_SKILL_DESCRIPTION_CHARS } from "../config/skill-size-limits.js";
import { parseSkillFrontmatterKeys } from "./skill-frontmatter.js";

const MAX_SKILL_NAME_LENGTH = 64;
const RESERVED_NAME_WORDS = /\b(?:anthropic|claude)\b/i;
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "metadata",
]);

export type SkillCreatorViolation = {
  rule: string;
  message: string;
};

export type SkillCreatorValidationResult = {
  valid: boolean;
  violations: SkillCreatorViolation[];
};

/** Quick-validate a complete `SKILL.md` string (frontmatter + body) per Skill Creator rules. */
export function quickValidateSkillMarkdown(skillMd: string): SkillCreatorValidationResult {
  const violations: SkillCreatorViolation[] = [];
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return {
      valid: false,
      violations: [
        { rule: "frontmatter-missing", message: "SKILL.md must start with a YAML frontmatter block (--- ... ---)" },
      ],
    };
  }
  const frontmatter = fmMatch[1];
  const keys = parseSkillFrontmatterKeys(frontmatter);

  const name = keys.get("name") ?? "";
  if (!name) {
    violations.push({ rule: "name-missing", message: "frontmatter must include non-empty `name`" });
  } else {
    if (name.length > MAX_SKILL_NAME_LENGTH) {
      violations.push({
        rule: "name-too-long",
        message: `name exceeds ${MAX_SKILL_NAME_LENGTH} chars (${name.length})`,
      });
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      violations.push({
        rule: "name-invalid-chars",
        message: "name must use only lowercase letters, numbers, and hyphens",
      });
    }
    if (RESERVED_NAME_WORDS.test(name)) {
      violations.push({
        rule: "name-reserved",
        message: 'name cannot contain reserved words "anthropic" or "claude"',
      });
    }
    if (/<[^>]+>/.test(name)) {
      violations.push({ rule: "name-xml", message: "name cannot contain XML tags" });
    }
  }

  const description = keys.get("description") ?? "";
  if (!description) {
    violations.push({ rule: "description-missing", message: "frontmatter must include non-empty `description`" });
  } else {
    if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
      violations.push({
        rule: "description-too-long",
        message: `description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} chars (${description.length})`,
      });
    }
    if (/<[^>]+>/.test(description)) {
      violations.push({ rule: "description-xml", message: "description cannot contain XML tags" });
    }
  }

  for (const lineRaw of frontmatter.split(/\r?\n/)) {
    if (!lineRaw.trim() || lineRaw.startsWith(" ") || lineRaw.startsWith("\t")) continue;
    const m = lineRaw.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!m) continue;
    const key = m[1];
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      violations.push({
        rule: "unsupported-top-level-key",
        message: `unsupported top-level frontmatter key: ${key} (allowed: ${[...ALLOWED_TOP_LEVEL_KEYS].join(", ")})`,
      });
    }
  }

  const body = skillMd.slice(fmMatch[0].length);
  const bodyLines = body.split(/\r?\n/).length;
  if (bodyLines > 500) {
    violations.push({
      rule: "body-too-long",
      message: `SKILL.md body exceeds 500 lines (${bodyLines}); use progressive disclosure into references/`,
    });
  }
  // Catch both drive-letter paths (`C:\Users\...`) and bare backslash paths
  // (`scripts\helper.py`). Excludes legitimate Markdown escapes like `\|` or
  // common LaTeX/regex within code fences (the latter are rarely emitted by
  // procedure skills, so we accept some false-positive risk for safety).
  const winDrive = /[A-Za-z]:\\(?:[^\s/]+\\)/;
  const winRelative = /(?:^|[\s"'`])[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+|\\[A-Za-z0-9_.-]+)/;
  if (winDrive.test(body) || winRelative.test(body)) {
    violations.push({
      rule: "windows-paths",
      message: "Windows-style backslash paths detected; use forward slashes only",
    });
  }

  return { valid: violations.length === 0, violations };
}
