/**
 * Anti-contamination guard for deductive synthesis (Issue #1916).
 */

import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";

export type ContaminationCheckResult = {
  allowed: boolean;
  reason?: string;
  layer: "deterministic" | "llm" | "dedupe";
};

/** Extract capitalized / quoted entity-like tokens from text. */
function extractNamedEntities(text: string): string[] {
  const entities = new Set<string>();
  const quoted = text.match(/"([^"]{2,40})"/g) ?? [];
  for (const q of quoted) entities.add(q.replace(/"/g, ""));
  const proper = text.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?\b/g) ?? [];
  for (const p of proper) entities.add(p);
  return [...entities];
}

/** Layer 1: every named entity in draft must appear in ≥1 source fact. */
export function checkEntityContamination(
  draft: string,
  sourceTexts: string[],
): ContaminationCheckResult {
  const entities = extractNamedEntities(draft);
  if (entities.length === 0) return { allowed: true, layer: "deterministic" };
  const corpus = sourceTexts.join("\n").toLowerCase();
  for (const entity of entities) {
    if (!corpus.includes(entity.toLowerCase())) {
      return {
        allowed: false,
        reason: `entity "${entity}" not found in source facts`,
        layer: "deterministic",
      };
    }
  }
  return { allowed: true, layer: "deterministic" };
}

/** Layer 3: normalize and compare against existing deductive fact texts. */
export function isDuplicateDraft(draft: string, existingTexts: string[]): boolean {
  const norm = draft.toLowerCase().replace(/\s+/g, " ").trim();
  for (const existing of existingTexts) {
    const e = existing.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm === e || (norm.length > 20 && e.includes(norm))) return true;
  }
  return false;
}

/** Layer 2: nano-LLM validator for entity attributions. */
export async function validateAttributionsWithLlm(
  draft: string,
  sourceTexts: string[],
  openai: OpenAI,
  model = "openai/gpt-4.1-nano",
): Promise<ContaminationCheckResult> {
  const sources = sourceTexts.map((t, i) => `${i + 1}. ${t.slice(0, 300)}`).join("\n");
  try {
    const response = await chatComplete({
      model,
      content: `Sources:\n${sources}\n\nDraft:\n${draft}\n\nAre all entity attributions in the draft supported by the sources? Reply YES or NO only.`,
      temperature: 0,
      maxTokens: 10,
      openai,
      timeoutMs: 8000,
      feature: CostFeature.contaminationGuard,
    });
    if (/^\s*yes\s*$/i.test(response.trim())) {
      return { allowed: true, layer: "llm" };
    }
    return { allowed: false, reason: "LLM rejected attributions", layer: "llm" };
  } catch {
    return { allowed: true, layer: "llm" };
  }
}

export async function runContaminationGuard(
  draft: string,
  sourceTexts: string[],
  existingTexts: string[],
  opts?: { openai?: OpenAI; skipLlm?: boolean },
): Promise<ContaminationCheckResult> {
  const deterministic = checkEntityContamination(draft, sourceTexts);
  if (!deterministic.allowed) return deterministic;

  if (isDuplicateDraft(draft, existingTexts)) {
    return { allowed: false, reason: "duplicate of existing fact", layer: "dedupe" };
  }

  if (!opts?.skipLlm && opts?.openai) {
    return validateAttributionsWithLlm(draft, sourceTexts, opts.openai);
  }
  return { allowed: true, layer: "deterministic" };
}
