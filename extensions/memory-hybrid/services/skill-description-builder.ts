/**
 * Pushy, multi-paraphrase Skill Creator descriptions (primary trigger surface).
 */

import { MAX_SKILL_DESCRIPTION_CHARS } from "../config/skill-size-limits.js";
import { paraphraseShouldTrigger } from "./skill-eval-synthesizer.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
    .slice(0, 6);
}

function mineToolsFromRecipe(recipe: unknown): string[] {
  if (!Array.isArray(recipe)) return [];
  const tools = new Set<string>();
  for (const step of recipe) {
    if (step && typeof step === "object" && typeof (step as Record<string, unknown>).tool === "string") {
      const t = String((step as Record<string, unknown>).tool);
      if (t.length >= 2 && t.length <= 24) tools.add(t);
    }
  }
  return [...tools].slice(0, 4);
}

export type SkillDescriptionInput = {
  taskPattern: string;
  keyword: string;
  recipe: unknown;
};

/**
 * Third-person, pushy description with what + when + domain keywords.
 */
export function buildPushySkillDescription(input: SkillDescriptionInput): string {
  const task = input.taskPattern.trim();
  const keywords = tokenize(task);
  const tools = mineToolsFromRecipe(input.recipe);
  const triggers = paraphraseShouldTrigger(task, input.keyword);
  const triggerSample = triggers.map((t) => `"${t}"`).join(", ");
  const keywordHint = keywords.length > 0 ? keywords.join(", ") : input.keyword;
  const toolHint = tools.length > 0 ? ` Tools: ${tools.join(", ")}.` : "";

  let desc =
    `Guides a validated workflow for ${task}. ` +
    `Use this skill whenever the user asks to ${task.toLowerCase()}, mentions ${keywordHint}, ` +
    `or uses phrasing like ${triggerSample}, even if they do not name a specific skill. ` +
    `Do not use for destructive changes, external sends, credential access, or unrelated troubleshooting.${toolHint}`;

  if (desc.length > MAX_SKILL_DESCRIPTION_CHARS) {
    desc =
      `Guides ${task}. Use when the user mentions ${keywordHint} or similar requests (${triggerSample}). ` +
      `Not for destructive ops, sends, or credentials.${toolHint}`;
  }
  if (desc.length > MAX_SKILL_DESCRIPTION_CHARS) {
    const marker = "… [truncated]";
    const contentLimit = Math.max(0, MAX_SKILL_DESCRIPTION_CHARS - marker.length);
    desc = desc.slice(0, contentLimit).trimEnd() + marker;
    if (desc.length > MAX_SKILL_DESCRIPTION_CHARS) {
      desc = desc.slice(0, MAX_SKILL_DESCRIPTION_CHARS);
    }
  }
  return desc;
}
