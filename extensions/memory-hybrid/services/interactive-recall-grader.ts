/**
 * Lightweight top-N document grading for interactive auto-recall turns.
 */

import type OpenAI from "openai";
import type { DocumentGradingConfig } from "../config.js";
import type { SearchResult } from "../types/memory.js";
import { DocumentGrader } from "./document-grader.js";

export async function filterCandidatesByInteractiveGrading(
  query: string,
  candidates: SearchResult[],
  cfg: DocumentGradingConfig,
  openai: OpenAI,
): Promise<SearchResult[]> {
  if (!cfg.enabled || !cfg.interactiveRecall || candidates.length === 0) {
    return candidates;
  }

  const topN = Math.max(1, Math.min(12, cfg.interactiveTopN ?? 6));
  const toGrade = candidates.slice(0, topN);
  const tail = candidates.slice(topN);

  const grader = new DocumentGrader(openai, {
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
  });

  try {
    const grades = await grader.gradeDocuments(
      query,
      toGrade.map((r) => ({ factId: r.entry.id, text: r.entry.summary || r.entry.text })),
    );
    if (grades.length === 0) return [];

    const relevantIds = new Set(grades.filter((g) => g.relevant).map((g) => g.factId));
    if (relevantIds.size === 0) return [];

    const filteredHead = toGrade.filter((r) => relevantIds.has(r.entry.id));
    return [...filteredHead, ...tail];
  } catch {
    return tail;
  }
}
