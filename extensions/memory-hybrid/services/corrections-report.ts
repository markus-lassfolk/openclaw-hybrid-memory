/**
 * Parse self-correction report markdown for corrections approve-all and list commands.
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { inferTargetFile } from "../cli/cmd-store.js";
import { isPathInsideDir } from "../cli/install/workspace.js";
import { listWorkspaceSkillMdPaths } from "../utils/skill-discovery.js";
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

const ALLOWED_PERSONA_TARGET_FILES = new Set(["SOUL.md", "USER.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md"]);

function isSafePersonaTargetFile(fileName: string): boolean {
  return ALLOWED_PERSONA_TARGET_FILES.has(fileName) && !fileName.includes("/") && !fileName.includes("..");
}

function isSafeSkillPathUnderWorkspace(workspaceRoot: string, skillPath: string): boolean {
  return isPathInsideDir(workspaceRoot, skillPath) && skillPath.replace(/\\/g, "/").includes("/skills/");
}

/** Extract change text from a SKILL_UPDATE body after the target path prefix. */
export function parseSkillUpdateChange(body: string): string {
  const trimmed = body.trim();
  const explicit = trimmed.match(SKILL_PATH_IN_TEXT);
  if (explicit) {
    const after = trimmed
      .slice(trimmed.indexOf(explicit[1]) + explicit[1].length)
      .replace(/^\s*:\s*/, "")
      .trim();
    return after || trimmed;
  }
  const colonSplit = trimmed.match(/^([^\s:]+):\s*(.+)$/s);
  if (colonSplit) return colonSplit[2].trim();
  return trimmed;
}

/**
 * Format a SKILL_UPDATE proposal line with an explicit skills/.../SKILL.md prefix when resolvable.
 */
export function formatSkillUpdateProposal(line: string, workspaceRoot: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "[SKILL_UPDATE] ";
  if (SKILL_PATH_IN_TEXT.test(trimmed)) {
    return SKILL_UPDATE_PREFIX.test(trimmed) ? trimmed : `[SKILL_UPDATE] ${trimmed}`;
  }
  const resolved = resolveSkillUpdateTarget(`[SKILL_UPDATE] ${trimmed}`, workspaceRoot);
  if (resolved) {
    const rel = relative(workspaceRoot, resolved.skillPath).split("\\").join("/");
    const change = parseSkillUpdateChange(trimmed);
    return `[SKILL_UPDATE] ${rel}: ${change}`;
  }
  return `[SKILL_UPDATE] ${trimmed}`;
}

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

/** Resolve `head` from `head: change` to an absolute SKILL.md path when it exists. */
function resolveSkillPathFromHead(workspaceRoot: string, head: string): string | null {
  const normalized = head.replace(/\\/g, "/").trim();
  if (!normalized) return null;

  if (normalized.startsWith("skills/") && normalized.endsWith(".md")) {
    const abs = join(workspaceRoot, normalized);
    return existsSync(abs) ? abs : null;
  }

  const autoSlash = normalized.match(/^auto\/([\w-]+)$/);
  if (autoSlash) {
    const abs = join(workspaceRoot, "skills", "auto", autoSlash[1]!, "SKILL.md");
    return existsSync(abs) ? abs : null;
  }

  if (/^[\w-]+$/.test(normalized)) {
    const top = join(workspaceRoot, "skills", normalized, "SKILL.md");
    if (existsSync(top)) return top;
    const auto = join(workspaceRoot, "skills", "auto", normalized, "SKILL.md");
    if (existsSync(auto)) return auto;
  }

  return null;
}

/**
 * Resolve a SKILL_UPDATE line to a workspace-relative skills/*.md path when possible.
 * Accepts explicit `skills/.../SKILL.md`, `slug: change`, or `auto/slug: change`.
 */
export function resolveSkillUpdateTarget(text: string, workspaceRoot: string): { skillPath: string } | null {
  const body = text.replace(SKILL_UPDATE_PREFIX, "").trim();
  const explicit = body.match(SKILL_PATH_IN_TEXT);
  if (explicit) {
    const rel = explicit[1].replace(/\\/g, "/");
    const abs = join(workspaceRoot, rel);
    if (existsSync(abs)) return { skillPath: abs };
  }
  const colonSplit = body.match(/^([^\s:]+):\s*(.+)$/s);
  if (colonSplit) {
    const resolved = resolveSkillPathFromHead(workspaceRoot, colonSplit[1]!);
    if (resolved) return { skillPath: resolved };
  }
  const soleSkill = resolveSingleWorkspaceSkill(workspaceRoot);
  if (soleSkill) return { skillPath: soleSkill };
  return null;
}

/** When exactly one SKILL.md exists under workspace/skills, use it as an implicit target. */
function resolveSingleWorkspaceSkill(workspaceRoot: string): string | null {
  const candidates = listWorkspaceSkillMdPaths(workspaceRoot).filter((p) =>
    isSafeSkillPathUnderWorkspace(workspaceRoot, p),
  );
  return candidates.length === 1 ? candidates[0]! : null;
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
      if (resolved && isSafeSkillPathUnderWorkspace(workspaceRoot, resolved.skillPath)) {
        skillUpdates.push({ skillPath: resolved.skillPath, change: parseSkillUpdateChange(body) });
      } else if (resolved) {
        unresolvedSkillUpdates.push(`${body} (path outside workspace)`);
      } else {
        unresolvedSkillUpdates.push(body);
      }
    } else if (AGENTS_RULE_PREFIX.test(text)) {
      const rule = text.replace(AGENTS_RULE_PREFIX, "").trim();
      const targetFile = inferTargetFile(rule);
      if (!isSafePersonaTargetFile(targetFile)) {
        unresolvedSkillUpdates.push(`[AGENTS_RULE] unsafe target ${targetFile}: ${rule.slice(0, 80)}`);
        continue;
      }
      pushAgentsRule(targetFile, rule);
    } else if (TOOLS_RULE_PREFIX.test(text)) {
      toolsRules.push(text.replace(TOOLS_RULE_PREFIX, "").trim());
    } else {
      toolsRules.push(text);
    }
  }

  return { toolsRules, agentsRulesByFile, skillUpdates, unresolvedSkillUpdates };
}

const SKILL_UPDATE_SECTION = "Self-correction skill updates";

function defaultHeadingForMarkdownFile(fileName: string): string {
  const base = fileName.replace(/\.md$/i, "");
  return `# ${base.toUpperCase()}`;
}

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
    if (!isSafePersonaTargetFile(targetFile)) {
      errors.push(`Unsafe persona target file: ${targetFile}`);
      continue;
    }
    const targetPath = join(workspaceRoot, targetFile);
    const { inserted } = insertRulesUnderSection(
      targetPath,
      toolsSection,
      rules,
      defaultHeadingForMarkdownFile(targetFile),
    );
    applied += inserted;
  }

  for (const { skillPath, change } of parsed.skillUpdates) {
    if (!isSafeSkillPathUnderWorkspace(workspaceRoot, skillPath)) {
      errors.push(`Skill path outside workspace: ${skillPath}`);
      continue;
    }
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
