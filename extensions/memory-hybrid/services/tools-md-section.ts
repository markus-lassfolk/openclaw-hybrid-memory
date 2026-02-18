/**
 * TOOLS.md section handling (issue #34): insert self-correction rules under a
 * named section instead of appending at end. Dedup by normalized line.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

function normalizeRuleLine(line: string): string {
  return line.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Find the line index of a section heading (e.g. "## Self-correction rules").
 * Section is identified by exact match of ## <sectionTitle> (case-insensitive for title).
 */
function findSectionStart(lines: string[], sectionTitle: string): number {
  const needle = "## " + sectionTitle.trim();
  const lower = needle.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.toLowerCase() === lower || trimmed.toLowerCase().startsWith(lower + " ")) {
      return i;
    }
  }
  return -1;
}

/**
 * Find the end of the section (next ## or end of file).
 */
function findSectionEnd(lines: string[], startIndex: number): number {
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ")) return i;
  }
  return lines.length;
}

/**
 * Extract existing bullet lines under the section (e.g. "- rule text").
 */
function getExistingRuleLines(lines: string[], startIndex: number, endIndex: number): string[] {
  const rules: string[] = [];
  for (let i = startIndex + 1; i < endIndex; i++) {
    const line = lines[i].trim();
    if (line.startsWith("- ") && line.length > 2) {
      rules.push(line.slice(2).trim());
    }
  }
  return rules;
}

/**
 * Insert new rules under the given section. If section exists, append new rules
 * (dedup by normalized content). If section does not exist, append it at end of file.
 * Each rule is written as "- <rule>\n".
 */
export function insertRulesUnderSection(
  filePath: string,
  sectionTitle: string,
  newRules: string[],
): { inserted: number; sectionExisted: boolean } {
  const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const lines = content.split("\n");
  const existingSet = new Set<string>();
  let sectionStart = findSectionStart(lines, sectionTitle);

  if (sectionStart >= 0) {
    const sectionEnd = findSectionEnd(lines, sectionStart);
    const existing = getExistingRuleLines(lines, sectionStart, sectionEnd);
    existing.forEach((r) => existingSet.add(normalizeRuleLine(r)));
  }

  const toInsert: string[] = [];
  for (const r of newRules) {
    const t = r.trim();
    if (!t) continue;
    if (existingSet.has(normalizeRuleLine(t))) continue;
    existingSet.add(normalizeRuleLine(t));
    toInsert.push(t);
  }

  if (toInsert.length === 0) {
    return { inserted: 0, sectionExisted: sectionStart >= 0 };
  }

  const bulletLines = toInsert.map((t) => "- " + t);
  let newContent: string;

  if (sectionStart >= 0) {
    const sectionEnd = findSectionEnd(lines, sectionStart);
    const before = lines.slice(0, sectionEnd).join("\n");
    const after = lines.slice(sectionEnd).join("\n");
    const insertBlock = (before.trimEnd().endsWith("\n") ? "" : "\n") + bulletLines.join("\n") + (after ? "\n" : "");
    newContent = before + insertBlock + (after ? "\n" + after : "");
  } else {
    const sectionHeader = "\n\n## " + sectionTitle + "\n\n";
    newContent = (content.trimEnd() || "# TOOLS") + sectionHeader + bulletLines.join("\n") + "\n";
  }

  writeFileSync(filePath, newContent, "utf-8");
  return { inserted: toInsert.length, sectionExisted: sectionStart >= 0 };
}
