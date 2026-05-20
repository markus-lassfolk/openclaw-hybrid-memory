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
      parts[0] = toGerund(parts[0]);
      name = parts.join("-");
    }
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    name = name.slice(0, MAX_SKILL_NAME_LENGTH).replace(/-$/, "");
  }
  return name;
}

/**
 * Convert a verb to its gerund form following English grammar rules.
 */
function toGerund(verb: string): string {
  if (verb.length === 0) return verb;
  
  // Drop silent 'e' before adding 'ing' (analyze → analyzing, configure → configuring)
  if (verb.endsWith("e") && verb.length > 2) {
    // Keep 'e' for verbs ending in 'ee', 'ye', 'oe' (agree → agreeing, see → seeing)
    const beforeE = verb[verb.length - 2];
    if (beforeE !== "e" && beforeE !== "y" && beforeE !== "o") {
      return verb.slice(0, -1) + "ing";
    }
  }
  
  // For single-syllable verbs ending in consonant-vowel-consonant (CVC),
  // double the final consonant (run → running, plan → planning)
  // Skip common exceptions (fix → fixing, box → boxing where final x is not doubled)
  if (verb.length >= 3) {
    const last = verb[verb.length - 1];
    const secondLast = verb[verb.length - 2];
    const thirdLast = verb[verb.length - 3];
    const vowels = "aeiou";
    const consonants = "bcdfghjklmnpqrstvwxyz";
    
    if (
      consonants.includes(last) &&
      vowels.includes(secondLast) &&
      consonants.includes(thirdLast) &&
      last !== "w" &&
      last !== "x" &&
      last !== "y"
    ) {
      // Only double for short words (likely single syllable)
      // This heuristic avoids doubling in longer words like "benefit" → "benefiting"
      if (verb.length <= 4) {
        return verb + last + "ing";
      }
    }
  }
  
  return verb + "ing";
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
