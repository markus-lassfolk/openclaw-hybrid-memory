/**
 * Pure helpers for skill name derivation and exec-only detection (Issue #1430).
 */

/**
 * Derive a kebab-case skill name from example goals and tool sequence.
 * Prefers the first example goal, falls back to tool sequence hash.
 */
export function deriveSkillName(exampleGoals: string[], toolSequence: string[], patternId: string): string {
  const firstGoal = exampleGoals[0];
  if (firstGoal && firstGoal.trim().length > 0) {
    const slug = firstGoal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join("-");
    if (slug.length >= 3) return `auto-${slug}`;
  }

  const toolSlug = toolSequence
    .slice(0, 2)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  return `auto-${toolSlug}-${patternId.slice(0, 6)}`;
}

export function normalizeSkillName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "auto-generated-skill";
}

/** Slug-safe name for operator overrides at approve/install time (preserves underscores). */
export function sanitizeApprovedSkillSlug(name: string): string {
  const slug = name
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/^\.+/, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "auto-generated-skill";
}

/** Format a scalar for YAML frontmatter (quotes reserved words, numbers, and special chars). */
export function formatYamlFrontmatterScalar(value: string): string {
  if (value === "") return '""';

  const yamlReservedWords = new Set([
    "true",
    "false",
    "True",
    "False",
    "TRUE",
    "FALSE",
    "yes",
    "no",
    "Yes",
    "No",
    "YES",
    "NO",
    "on",
    "off",
    "On",
    "Off",
    "ON",
    "OFF",
    "null",
    "Null",
    "NULL",
    "~",
  ]);

  if (yamlReservedWords.has(value) || /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) {
    return JSON.stringify(value);
  }

  if (/^[\w.-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Check whether a tool sequence is entirely exec calls (shell-automatable).
 */
export function isExecOnlySequence(toolSequence: string[]): boolean {
  return toolSequence.length > 0 && toolSequence.every((t) => t === "exec");
}
