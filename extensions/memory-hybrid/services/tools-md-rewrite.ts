/**
 * LLM rewrite validation and fallback for TOOLS.md self-correction updates.
 */

import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { insertRulesUnderSection, ruleExistsInContent } from "./tools-md-section.js";

export const TOOLS_MD_MANAGED_BEGIN = "<!-- openclaw-hybrid-memory:managed-begin -->";
export const TOOLS_MD_MANAGED_END = "<!-- openclaw-hybrid-memory:managed-end -->";

export type ToolsMdRewriteValidation = {
  ok: boolean;
  reasons: string[];
};

/** Validate LLM-rewritten TOOLS.md before replacing the on-disk file. */
export function validateToolsMdRewrite(
  original: string,
  rewritten: string,
  newRules: readonly string[],
): ToolsMdRewriteValidation {
  const reasons: string[] = [];
  const trimmed = rewritten.trim();
  if (trimmed.length <= 50) reasons.push("rewritten content too short");
  if (!/^#\s/m.test(trimmed)) reasons.push("rewritten content missing top-level heading");
  if (original.includes(TOOLS_MD_MANAGED_BEGIN) && !trimmed.includes(TOOLS_MD_MANAGED_BEGIN)) {
    reasons.push("hybrid memory managed block missing from rewrite");
  }
  if (original.includes(TOOLS_MD_MANAGED_END) && !trimmed.includes(TOOLS_MD_MANAGED_END)) {
    reasons.push("hybrid memory managed block end marker missing from rewrite");
  }
  for (const rule of newRules) {
    const t = rule.trim();
    if (!t) continue;
    if (!ruleExistsInContent(trimmed, t)) {
      reasons.push(`new rule not present in rewrite: ${t.slice(0, 60)}`);
      break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function writeToolsMdFile(toolsPath: string, content: string): void {
  if (existsSync(toolsPath) && lstatSync(toolsPath).isSymbolicLink()) {
    writeFileSync(toolsPath, content, "utf-8");
  } else {
    atomicWriteFile(toolsPath, content);
  }
}

export type ApplyToolsRulesResult = {
  toolsApplied: number;
  method: "rewrite" | "insert" | "none";
  rewriteRejectedReasons?: string[];
};

/**
 * Apply TOOLS.md rules: try LLM rewrite when enabled, otherwise section insert.
 * Falls back to section insert when rewrite validation fails.
 */
export function applyToolsMdRules(opts: {
  toolsPath: string;
  sectionTitle: string;
  newRules: string[];
  autoRewrite: boolean;
  rewrittenContent?: string;
}): ApplyToolsRulesResult {
  const { toolsPath, sectionTitle, newRules, autoRewrite, rewrittenContent } = opts;
  const rules = newRules.map((r) => r.trim()).filter(Boolean);
  if (rules.length === 0) return { toolsApplied: 0, method: "none" };

  const currentTools = existsSync(toolsPath) ? readFileSync(toolsPath, "utf-8") : "";

  if (autoRewrite && rewrittenContent != null) {
    const cleaned = rewrittenContent
      .trim()
      .replace(/^```\w*\n?|```\s*$/g, "")
      .trim();
    const validation = validateToolsMdRewrite(currentTools, cleaned, rules);
    if (validation.ok) {
      writeToolsMdFile(toolsPath, `${cleaned}\n`);
      return { toolsApplied: rules.length, method: "rewrite" };
    }
    const fallback = insertRulesUnderSection(toolsPath, sectionTitle, rules);
    return {
      toolsApplied: fallback.inserted,
      method: "insert",
      rewriteRejectedReasons: validation.reasons,
    };
  }

  const { inserted } = insertRulesUnderSection(toolsPath, sectionTitle, rules);
  return { toolsApplied: inserted, method: "insert" };
}
