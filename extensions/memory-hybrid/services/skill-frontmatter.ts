/**
 * Skill Creator-compatible YAML frontmatter for generated procedure skills (issue #1545).
 */

import { MAX_SKILL_DESCRIPTION_CHARS } from "../config/skill-size-limits.js";
import { validateSkillName } from "./skill-name-validator.js";

export type ProcedureSkillFrontmatterInput = {
  name: string;
  description: string;
  category: string;
  provenance: string;
  generatedAt: string;
};

const SKILL_CREATOR_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "metadata",
]);

/** Escape a double-quoted YAML string value. */
function yamlDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Folded block scalar for descriptions that contain colons or quotes. */
function yamlFoldedBlock(value: string): string {
  const lines = value.split(/\r?\n/);
  const body = lines.map((line) => `  ${line}`).join("\n");
  return `>- \n${body}`;
}

function formatDescriptionField(description: string): string {
  const trimmed = description.length > MAX_SKILL_DESCRIPTION_CHARS
    ? `${description.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 14)}… [truncated]`
    : description;
  if (/[:#"'\n]/.test(trimmed) || trimmed.length > 120) {
    return `description: ${yamlFoldedBlock(trimmed)}`;
  }
  return `description: ${yamlDoubleQuoted(trimmed)}`;
}

/**
 * Emit Skill Creator-compatible frontmatter (only allowed top-level keys).
 */
export function formatProcedureSkillFrontmatter(input: ProcedureSkillFrontmatterInput): string {
  const nameViolations = validateSkillName(input.name);
  if (nameViolations.length > 0) {
    throw new Error(`Invalid skill name: ${nameViolations.join("; ")}`);
  }
  const description = formatDescriptionField(input.description);
  const metadataLines = [
    `  category: ${yamlDoubleQuoted(input.category)}`,
    `  provenance: ${yamlDoubleQuoted(input.provenance)}`,
    `  generated_at: ${yamlDoubleQuoted(input.generatedAt)}`,
  ];
  return `---
name: ${yamlDoubleQuoted(input.name)}
${description}
metadata:
${metadataLines.join("\n")}
---`;
}

/**
 * Validate that generated frontmatter uses only Skill Creator-allowed top-level keys.
 */
export function validateSkillCreatorFrontmatterKeys(frontmatterBlock: string): string[] {
  const violations: string[] = [];
  const lines = frontmatterBlock.split(/\r?\n/).filter((l) => l.trim() !== "---");
  for (const line of lines) {
    if (!line.trim() || line.startsWith(" ") || line.startsWith("\t")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!match) continue;
    const key = match[1];
    if (!SKILL_CREATOR_TOP_LEVEL_KEYS.has(key)) {
      violations.push(`Unsupported top-level frontmatter key: ${key}`);
    }
  }
  return violations;
}

/**
 * Parse frontmatter block (between --- markers) into flat keys including metadata.* .
 */
export function parseSkillFrontmatterKeys(frontmatterBody: string): Map<string, string> {
  const keys = new Map<string, string>();
  const lines = frontmatterBody.split(/\r?\n/);
  let i = 0;
  let currentTopKey: string | null = null;
  let descriptionMode: "none" | "folded" | "quoted" = "none";
  let descriptionParts: string[] = [];

  const flushDescription = () => {
    if (descriptionParts.length > 0) {
      keys.set("description", descriptionParts.join("\n").trim());
      descriptionParts = [];
    }
    descriptionMode = "none";
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (descriptionMode === "folded") {
      if (/^\s{2,}\S/.test(line)) {
        descriptionParts.push(line.replace(/^\s{2}/, ""));
        i++;
        continue;
      }
      flushDescription();
      continue;
    }
    if (descriptionMode === "quoted") {
      const joined = descriptionParts.join("\n") + line;
      if (joined.endsWith('"') && !joined.endsWith('\\"')) {
        keys.set("description", joined.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"'));
        descriptionParts = [];
        descriptionMode = "none";
      } else {
        descriptionParts.push(line);
      }
      i++;
      continue;
    }

    const topMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (topMatch && !line.startsWith(" ")) {
      currentTopKey = topMatch[1].toLowerCase();
      const rest = topMatch[2].trim();
      if (currentTopKey === "description") {
        if (rest === ">-") {
          descriptionMode = "folded";
          i++;
          continue;
        }
        if (rest.startsWith('"')) {
          descriptionMode = "quoted";
          descriptionParts = [rest];
          if (rest.endsWith('"') && rest.length > 1) {
            keys.set("description", rest.slice(1, -1));
            descriptionMode = "none";
            descriptionParts = [];
          }
          i++;
          continue;
        }
        keys.set("description", rest.replace(/^["']|["']$/g, ""));
      } else if (currentTopKey === "metadata" && rest === "") {
        i++;
        while (i < lines.length) {
          const metaLine = lines[i] ?? "";
          const metaMatch = metaLine.match(/^\s{2,}([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
          if (!metaMatch) break;
          const metaKey = metaMatch[1].toLowerCase();
          const metaVal = metaMatch[2].trim().replace(/^["']|["']$/g, "");
          keys.set(`metadata.${metaKey}`, metaVal);
          i++;
        }
        continue;
      } else if (rest) {
        keys.set(currentTopKey, rest.replace(/^["']|["']$/g, ""));
      }
    }
    i++;
  }
  flushDescription();
  return keys;
}
