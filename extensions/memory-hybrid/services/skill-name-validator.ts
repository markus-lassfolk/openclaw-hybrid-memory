/**
 * Skill Creator name rules: gerund form, length, reserved words.
 */

const RESERVED_NAME_WORDS = /\b(?:anthropic|claude)\b/i;
const MAX_SKILL_NAME_LENGTH = 64;

const GERUND_MAP: Array<[RegExp, string]> = [
  [/^check[-_]?/, "checking-"],
  [/^validate[-_]?/, "validating-"],
  [/^verify[-_]?/, "verifying-"],
  [/^run[-_]?/, "running-"],
  [/^read[-_]?/, "reading-"],
  [/^write[-_]?/, "writing-"],
  [/^send[-_]?/, "sending-"],
  [/^create[-_]?/, "creating-"],
  [/^update[-_]?/, "updating-"],
  [/^fix[-_]?/, "fixing-"],
  [/^debug[-_]?/, "debugging-"],
  [/^install[-_]?/, "installing-"],
  [/^deploy[-_]?/, "deploying-"],
  [/^test[-_]?/, "testing-"],
  [/^monitor[-_]?/, "monitoring-"],
  [/^audit[-_]?/, "auditing-"],
];

/**
 * Convert slug to gerund-form skill name (Skill Creator convention).
 */
export function toGerundSkillName(slug: string): string {
  let name = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  for (const [pattern, prefix] of GERUND_MAP) {
    if (pattern.test(name)) {
      name = name.replace(pattern, prefix);
      break;
    }
  }
  if (!/^[a-z]+ing-/.test(name) && !name.startsWith("ing-")) {
    const parts = name.split("-").filter(Boolean);
    if (parts.length > 0 && !parts[0].endsWith("ing")) {
      parts[0] = `${parts[0]}ing`;
      name = parts.join("-");
    }
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    name = name.slice(0, MAX_SKILL_NAME_LENGTH).replace(/-$/, "");
  }
  return name;
}

export function validateSkillName(name: string): string[] {
  const violations: string[] = [];
  if (!name || name.length === 0) violations.push("name is empty");
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    violations.push(`name exceeds ${MAX_SKILL_NAME_LENGTH} characters`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    violations.push("name must use only lowercase letters, numbers, and hyphens");
  }
  if (RESERVED_NAME_WORDS.test(name)) {
    violations.push("name contains reserved word (anthropic/claude)");
  }
  return violations;
}
