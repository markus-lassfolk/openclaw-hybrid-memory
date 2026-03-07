/**
 * LLM Re-ranker Service (Issue #161).
 *
 * After RRF fusion produces a ranked list, optionally re-rank the top-N candidates
 * using an LLM for semantic relevance to the original query.
 *
 * Key design:
 * - Takes top candidateCount facts from RRF fusion results.
 * - Builds a prompt listing each fact with ID, snippet, confidence, and date.
 * - Sends to LLM requesting a JSON array of fact IDs ordered by relevance.
 * - Facts omitted by the LLM are appended after ranked ones (preserving original order).
 * - Returns top outputCount facts.
 * - Timeout: if LLM takes >timeoutMs, falls back to original RRF ranking.
 * - Graceful degradation: any failure returns original order unchanged.
 */

import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import type { RerankingConfig } from "../config.js";
import { extractJsonArray } from "./json-array-parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fact with its score and metadata needed for re-ranking. */
export interface ScoredFact {
  /** Fact UUID. */
  factId: string;
  /** Full fact text. */
  text: string;
  /** Confidence score 0-1. */
  confidence: number;
  /** ISO date string (YYYY-MM-DD) of when the fact was stored. */
  storedDate: string;
  /** Final score from RRF pipeline (used for fallback ordering). */
  finalScore: number;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the re-ranking prompt listing all candidate facts.
 * Each fact is presented with its ID, a text snippet (up to 200 chars),
 * confidence, and stored date so the LLM can judge freshness.
 */
export function buildRerankPrompt(query: string, facts: ScoredFact[]): string {
  const factLines = facts
    .map((f, i) => {
      const snippet = f.text.length > 200 ? `${f.text.slice(0, 197)}...` : f.text;
      return (
        `${i + 1}. ID: ${f.factId}\n` +
        `   Text: ${snippet}\n` +
        `   Confidence: ${f.confidence.toFixed(2)}\n` +
        `   Stored: ${f.storedDate}`
      );
    })
    .join("\n\n");

  return (
    `You are a retrieval relevance ranker. Given a search query and a list of candidate facts, ` +
    `return a JSON array of fact IDs ordered from most to least relevant to the query.\n\n` +
    `Query: "${query}"\n\n` +
    `Candidate facts:\n${factLines}\n\n` +
    `Return ONLY a JSON array of fact ID strings in relevance order. ` +
    `Example: ["id-a", "id-b", "id-c"]`
  );
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSON array of fact IDs from an LLM response.
 * Handles responses that wrap the JSON in prose or code fences.
 * Uses candidate-based extraction (try each [...] substring) so that later
 * bracketed text (e.g. "id-1 first because [it was relevant]") does not over-match.
 */
export function parseRankedIds(response: string): string[] {
  const trimmed = extractJsonArray(response)
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((id) => (id as string).trim());
  // De-dupe by first occurrence to match lookup behavior.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of trimmed) {
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Core re-ranking logic
// ---------------------------------------------------------------------------

/**
 * Re-rank RRF fusion results using an LLM.
 *
 * @param query - Original search query.
 * @param facts - Ordered facts from RRF fusion (best-first). May be the full fused list.
 * @param config - Re-ranking configuration.
 * @param openai - OpenAI-compatible client for LLM calls.
 * @returns On success, re-ranked facts (at most outputCount). On any failure (error,
 *   timeout, or unparseable/empty response), returns the original list unchanged.
 */
export async function rerankResults(
  query: string,
  facts: ScoredFact[],
  config: RerankingConfig,
  openai: OpenAI,
): Promise<ScoredFact[]> {
  if (!config.enabled || facts.length === 0) return facts;

  // Split into the candidate set (to re-rank) and the tail (to append unchanged).
  const candidates = facts.slice(0, config.candidateCount);
  const tail = facts.slice(config.candidateCount);

  const prompt = buildRerankPrompt(query, candidates);
  const model = config.model ?? "openai/gpt-4.1-nano";

  try {
    const response = await chatComplete({
      model,
      content: prompt,
      temperature: 0,
      maxTokens: 1000,
      openai,
      timeoutMs: config.timeoutMs,
    });

    const rankedIds = parseRankedIds(response);

    // If LLM returned nothing useful, fall back to original order sliced to outputCount (consistent with error path).
    if (rankedIds.length === 0) {
      return facts.slice(0, config.outputCount);
    }

    // Build a lookup map from the candidate set.
    const factById = new Map(candidates.map((f) => [f.factId, f]));
    const ranked: ScoredFact[] = [];
    const seen = new Set<string>();

    // Add LLM-ranked facts first (in the order the LLM specified).
    for (const id of rankedIds) {
      const fact = factById.get(id);
      if (fact && !seen.has(id)) {
        ranked.push(fact);
        seen.add(id);
      }
    }

    // Append candidate facts not returned by the LLM (preserving original order).
    for (const fact of candidates) {
      if (!seen.has(fact.factId)) {
        ranked.push(fact);
      }
    }

    // Append the tail facts (beyond candidateCount) and slice to outputCount.
    return [...ranked, ...tail].slice(0, config.outputCount);
  } catch (err) {
    // Timeout or any error: fall back to original RRF ranking, sliced to outputCount.
    void err;
    return facts.slice(0, config.outputCount);
  }
}
