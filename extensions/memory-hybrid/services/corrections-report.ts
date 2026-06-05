/**
 * Parse self-correction report markdown for corrections approve-all and list commands.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { inferTargetFile } from "../cli/cmd-store.js";
import { insertRulesUnderSection } from "./tools-md-section.js";

export type ParsedCorrectionRules = {
  toolsRules: string[];
  /** Persona / identity file rules keyed by basename (SOUL.md, USER.md, …). */
  agentsRulesByFile: Map<string, string[]>;
  /** Skill file updates: absolute path + change text. */
  skillUpdates: Array<{ skillPath: string; change: string }>;
  /** SKILL_UPDATE lines that could not be resolved to a skill path. */
  unresolvedSkillUpdates: string[];
};

const SKILL_PATH_IN_TEXT = /\b(skills\/[^\s:]+\.md)\b/i;
const SKILL_UPDATE_PREFIX = /^\[SKILL_UPDATE\]\s*/i;
const AGENTS_RULE_PREFIX = /^\[AGENTS_RULE\]\s*/i;
const TOOLS_RULE_PREFIX = /^\[TOOLS_RULE\]\s*/i;

/** Extract items from "Suggested TOOLS.md rules" and "Proposed" sections for list display. */
export function parseReportProposedSections(content: string): string[] {
  const lines = content.split("\n");
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Suggested TOOLS.md rules") || trimmed === "## Proposed (review before applying)") {
      inSection = true;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      inSection = false;
      continue;
    }
    if (inSection && trimmed.startsWith("- ") && trimmed.length > 2) items.push(trimmed.slice(2).trim());
  }
  return items;
}

/**
 * Resolve a SKILL_UPDATE line to a workspace-relative skills/*.md path when possible.
 * Accepts explicit `skills/.../SKILL.md` in the text or `skills/auto/slug: change`.
 */
export function resolveSkillUpdateTarget(text: string, workspaceRoot: string): { skillPath: string } | null {
  const body = text.replace(SKILL_UPDATE_PREFIX, "").trim();
  const explicit = body.match(SKILL_PATH_IN_TEXT);
  if (explicit) {
    const rel = explicit[1].replace(/\\/g, "/");
    const abs = join(workspaceRoot, rel);
    if (existsSync(abs)) return { skillPath: abs };
    if (rel.endsWith(".md")) return { skillPath: abs };
  }
  const colonSplit = body.match(/^([^\s:]+):\s*(.+)$/);
  if (colonSplit) {
    const head = colonSplit[1].replace(/\\/g, "/");
    if (head.startsWith("skills/") && head.endsWith(".md")) {
      return { skillPath: join(workspaceRoot, head) };
    }
    if (/^[\w-]+$/.test(head)) {
      const candidate = join(workspaceRoot, "skills", head, "SKILL.md");
      if (existsSync(candidate)) return { skillPath: candidate };
      const autoCandidate = join(workspaceRoot, "skills", "auto", head, "SKILL.md");
      if (existsSync(autoCandidate)) return { skillPath: autoCandidate };
    }
  }
  return null;
}

/** Parse report sections into typed apply targets. */
export function parseReportRulesForApply(content: string, workspaceRoot: string): ParsedCorrectionRules {
  const toolsRules: string[] = [];
  const agentsRulesByFile = new Map<string, string[]>();
  const skillUpdates: Array<{ skillPath: string; change: string }> = [];
  const unresolvedSkillUpdates: string[] = [];

  const pushAgentsRule = (targetFile: string, rule: string) => {
    const list = agentsRulesByFile.get(targetFile) ?? [];
    list.push(rule);
    agentsRulesByFile.set(targetFile, list);
  };

  const lines = content.split("\n");
  let inSuggested = false;
  let inProposed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Suggested TOOLS.md rules")) {
      inSuggested = true;
      inProposed = false;
      continue;
    }
    if (trimmed === "## Proposed (review before applying)") {
      inSuggested = false;
      inProposed = true;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      inSuggested = false;
      inProposed = false;
      continue;
    }
    if (!trimmed.startsWith("- ") || trimmed.length <= 2) continue;
    const text = trimmed.slice(2).trim();

    if (inSuggested) {
      toolsRules.push(text);
      continue;
    }
    if (!inProposed) continue;

    if (SKILL_UPDATE_PREFIX.test(text)) {
      const body = text.replace(SKILL_UPDATE_PREFIX, "").trim();
      const resolved = resolveSkillUpdateTarget(text, workspaceRoot);
      if (resolved) {
        const change =
          body.replace(SKILL_PATH_IN_TEXT, "").replace(/^[\w-]+:\s*/, "").trim() || body;
        skillUpdates.push({ skillPath: resolved.skillPath, change });
      } else {
        unresolvedSkillUpdates.push(body);
      }
    } else if (AGENTS_RULE_PREFIX.test(text)) {
      const rule = text.replace(AGENTS_RULE_PREFIX, "").trim();
      pushAgentsRule(inferTargetFile(rule), rule);
    } else if (TOOLS_RULE_PREFIX.test(text)) {
      toolsRules.push(text.replace(TOOLS_RULE_PREFIX, "").trim());
    } else {
      toolsRules.push(text);
    }
  }

  return { toolsRules, agentsRulesByFile, skillUpdates, unresolvedSkillUpdates };
}

const SKILL_UPDATE_SECTION = "Self-correction skill updates";

/** Apply parsed correction rules to workspace files. */
export function applyParsedCorrectionRules(opts: {
  workspaceRoot: string;
  toolsSection: string;
  parsed: ParsedCorrectionRules;
}): { applied: number; errors: string[] } {
  const { workspaceRoot, toolsSection, parsed } = opts;
  let applied = 0;
  const errors: string[] = [];

  if (parsed.toolsRules.length > 0) {
    const toolsPath = join(workspaceRoot, "TOOLS.md");
    const { inserted } = insertRulesUnderSection(toolsPath, toolsSection, parsed.toolsRules);
    applied += inserted;
  }

  for (const [targetFile, rules] of parsed.agentsRulesByFile) {
    const targetPath = join(workspaceRoot, targetFile);
    const defaultHeading = targetFile.replace(/\.md$/i, "").startsWith("#")
      ? targetFile
      : `# ${targetFile.replace(/\.md$/i, "").toUpperCase()}`;
    const { inserted } = insertRulesUnderSection(targetPath, toolsSection, rules, defaultHeading);
    applied += inserted;
  }

  for (const { skillPath, change } of parsed.skillUpdates) {
    if (!existsSync(skillPath)) {
      errors.push(`Skill file not found: ${skillPath}`);
      continue;
    }
    const { inserted } = insertRulesUnderSection(skillPath, SKILL_UPDATE_SECTION, [change], "# Skill update");
    applied += inserted;
  }

  for (const unresolved of parsed.unresolvedSkillUpdates) {
    errors.push(`Unresolved SKILL_UPDATE (no matching skill path): ${unresolved.slice(0, 120)}`);
  }

  return { applied, errors };
}
