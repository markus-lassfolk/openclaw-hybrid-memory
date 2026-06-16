/**
 * Query intent classifier for Retrieval v2 (Issue #1910).
 * Heuristic regex first (≤1ms); optional LLM refinement when confidence < threshold.
 */

import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";

export type QueryIntent = "WHY" | "WHEN" | "ENTITY" | "WHAT" | "GENERAL";

export type IntentClassification = {
  intent: QueryIntent;
  confidence: number;
  source: "heuristic" | "llm" | "explicit";
};

const WHY_PATTERNS = [
  /\bwhy\b/i,
  /\bbecause\b/i,
  /\bcaused\b/i,
  /\breason\b/i,
  /\bhow come\b/i,
];

const WHEN_PATTERNS = [
  /\bwhen\b/i,
  /\bbefore\b/i,
  /\bafter\b/i,
  /\blast\s+(?:week|month|year|time)\b/i,
  /\byesterday\b/i,
  /\btimeline\b/i,
];

const ENTITY_PATTERNS = [/\bwho\b/i, /\bwhich\s+(?:person|team|company|project)\b/i];

const WHAT_PATTERNS = [/\bwhat\b/i, /\bhow\s+to\b/i, /\bexplain\b/i];

/** Count capitalized tokens (proper nouns heuristic). */
function properNounRatio(text: string): number {
  const tokens = text.split(/\s+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return 0;
  const proper = tokens.filter((t) => /^[A-Z][a-z]/.test(t) || /^[A-Z]{2,}$/.test(t));
  return proper.length / tokens.length;
}

/** Fast heuristic intent classification. */
export function classifyIntentHeuristic(query: string): IntentClassification {
  const q = query.trim();
  if (!q) return { intent: "GENERAL", confidence: 0.5, source: "heuristic" };

  const scores: Record<QueryIntent, number> = {
    WHY: 0,
    WHEN: 0,
    ENTITY: 0,
    WHAT: 0,
    GENERAL: 0.1,
  };

  for (const p of WHY_PATTERNS) if (p.test(q)) scores.WHY += 0.35;
  for (const p of WHEN_PATTERNS) if (p.test(q)) scores.WHEN += 0.35;
  for (const p of ENTITY_PATTERNS) if (p.test(q)) scores.ENTITY += 0.3;
  for (const p of WHAT_PATTERNS) if (p.test(q)) scores.WHAT += 0.25;

  const pnRatio = properNounRatio(q);
  if (pnRatio >= 0.3) scores.ENTITY += 0.25;

  let best: QueryIntent = "GENERAL";
  let bestScore = scores.GENERAL;
  for (const intent of ["WHY", "WHEN", "ENTITY", "WHAT"] as const) {
    if (scores[intent] > bestScore) {
      best = intent;
      bestScore = scores[intent];
    }
  }

  const confidence = Math.min(0.95, 0.4 + bestScore);
  return { intent: best, confidence, source: "heuristic" };
}

const VALID_INTENTS: QueryIntent[] = ["WHY", "WHEN", "ENTITY", "WHAT", "GENERAL"];

function parseLlmIntent(response: string): QueryIntent | null {
  const upper = response.trim().toUpperCase();
  for (const intent of VALID_INTENTS) {
    if (upper.includes(intent)) return intent;
  }
  return null;
}

export type IntentClassifierConfig = {
  enabled: boolean;
  llmRefinement: boolean;
  heuristicThreshold: number;
  model?: string;
  timeoutMs?: number;
};

type SessionCache = Map<string, IntentClassification>;

const sessionCaches = new Map<string, SessionCache>();
const MAX_TRACKED_SESSIONS = 200;

function evictOldestSession() {
  if (sessionCaches.size <= MAX_TRACKED_SESSIONS) return;
  const oldest = sessionCaches.keys().next().value;
  if (oldest) sessionCaches.delete(oldest);
}

function queryHash(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** Classify query intent with optional LLM refinement and session cache. */
export async function classifyQueryIntent(
  query: string,
  config: IntentClassifierConfig,
  opts?: {
    explicitIntent?: QueryIntent;
    sessionId?: string;
    openai?: OpenAI;
  },
): Promise<IntentClassification> {
  if (opts?.explicitIntent) {
    return { intent: opts.explicitIntent, confidence: 1, source: "explicit" };
  }
  if (!config.enabled) {
    return { intent: "GENERAL", confidence: 0.5, source: "heuristic" };
  }

  const cacheKey = queryHash(query);
  if (opts?.sessionId) {
    let cache = sessionCaches.get(opts.sessionId);
    if (!cache) {
      evictOldestSession();
      cache = new Map();
      sessionCaches.set(opts.sessionId, cache);
    }
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const heuristic = classifyIntentHeuristic(query);
  let result = heuristic;

  if (
    config.llmRefinement &&
    heuristic.confidence < config.heuristicThreshold &&
    opts?.openai
  ) {
    try {
      const response = await chatComplete({
        model: config.model ?? "openai/gpt-4.1-nano",
        content: `Classify this search query into exactly one intent: WHY, WHEN, ENTITY, WHAT, or GENERAL.\nQuery: "${query.trim()}"\nReply with only the intent word.`,
        temperature: 0,
        maxTokens: 20,
        openai: opts.openai,
        timeoutMs: config.timeoutMs ?? 5000,
        feature: CostFeature.intentRouter,
      });
      const parsed = parseLlmIntent(response);
      if (parsed) {
        result = { intent: parsed, confidence: 0.85, source: "llm" };
      }
    } catch {
      /* fall back to heuristic */
    }
  }

  if (opts?.sessionId) {
    sessionCaches.get(opts.sessionId)?.set(cacheKey, result);
  }
  return result;
}

/** Clear session intent cache (for tests). */
export function clearIntentSessionCache(sessionId?: string): void {
  if (sessionId) sessionCaches.delete(sessionId);
  else sessionCaches.clear();
}
