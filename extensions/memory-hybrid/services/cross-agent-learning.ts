/**
 * Cross-Agent Learning — Generalise agent-scoped lessons into global patterns.
 * Issue #263 — Phase 2.
 *
 * Algorithm:
 *  1. Pull recent agent-scoped pattern/rule facts from all agents.
 *  2. For each agent, collect lessons that are NOT already in global scope.
 *  3. Send a batch to the LLM with the cross-agent-generalize prompt.
 *  4. For each generalised lesson, store a new global fact (category="pattern",
 *     scope="global", source="cross-agent-learning", importance boosted +0.1).
 *  5. Link source agent facts → new global fact via DERIVED_FROM.
 *  6. Return a report.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";
import type { CrossAgentLearningConfig } from "../config/types/features.js";
import { chatCompleteWithRetry } from "./chat.js";
import { loadPrompt as loadPromptSync, fillPrompt } from "../utils/prompt-loader.js";
import { capturePluginError } from "./error-reporter.js";
import type OpenAI from "openai";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrossAgentLearningResult {
  agentsScanned: number;
  lessonsConsidered: number;
  generalisedStored: number;
  linksCreated: number;
  skippedDuplicates: number;
  errors: number;
  newFacts: Array<{ id: string; text: string; agentSources: string[] }>;
}

export interface AgentLesson {
  factId: string;
  agentId: string;
  text: string;
  category: string;
  importance: number;
  confidence: number;
  createdAt: number;
}

interface LLMGeneralisedLesson {
  text: string;
  rationale: string;
  sourceAgents: string[];
  importance: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CROSS_AGENT_SOURCE = "cross-agent-learning";
const CROSS_AGENT_TAG = "cross-agent";
const GENERALISED_CATEGORIES = ["pattern", "rule"] as const;
// Category whitelist for agent lessons we consider for generalisation
const LEARNABLE_CATEGORIES = new Set(["pattern", "rule", "fact", "decision"]);
// Minimum confidence for a source fact to be considered
const MIN_SOURCE_CONFIDENCE = 0.4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull all agent-scoped facts (pattern/rule/fact/decision) within a recency window. */
function collectAgentLessons(factsDb: FactsDB, windowDays: number): AgentLesson[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;
  if (!db) return [];

  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;
  try {
    const rows = db
      .prepare(
        `SELECT id, scope_target, text, category, importance, confidence, created_at
         FROM facts
         WHERE scope = 'agent'
           AND scope_target IS NOT NULL
           AND superseded_at IS NULL
           AND confidence >= ?
           AND created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(MIN_SOURCE_CONFIDENCE, cutoff) as Array<{
      id: string;
      scope_target: string;
      text: string;
      category: string;
      importance: number;
      confidence: number;
      created_at: number;
    }>;

    return rows
      .filter((r) => LEARNABLE_CATEGORIES.has(r.category))
      .map((r) => ({
        factId: r.id,
        agentId: r.scope_target,
        text: r.text,
        category: r.category,
        importance: r.importance,
        confidence: r.confidence,
        createdAt: r.created_at,
      }));
  } catch {
    return [];
  }
}

/** Check if a semantically equivalent global fact already exists (text hash dedup). */
function globalFactAlreadyExists(factsDb: FactsDB, text: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;
  if (!db) return false;

  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  try {
    const existing = db
      .prepare(
        `SELECT id FROM facts
         WHERE scope = 'global'
           AND source = ?
           AND LOWER(REPLACE(REPLACE(text, char(9), ' '), char(10), ' ')) LIKE ?
           AND superseded_at IS NULL
         LIMIT 1`,
      )
      .get(CROSS_AGENT_SOURCE, `%${normalised.slice(0, 60)}%`) as { id: string } | undefined;
    return !!existing;
  } catch {
    return false;
  }
}

/** Check if source agent-fact has already been linked to a global generalised fact. */
function agentFactAlreadyGeneralised(factsDb: FactsDB, agentFactId: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;
  if (!db) return false;

  try {
    const link = db
      .prepare(
        `SELECT ml.id
         FROM memory_links ml
         JOIN facts f ON f.id = ml.target_fact_id
         WHERE ml.source_fact_id = ?
           AND ml.link_type = 'DERIVED_FROM'
           AND f.source = ?
           AND f.scope = 'global'
         LIMIT 1`,
      )
      .get(agentFactId, CROSS_AGENT_SOURCE) as { id: string } | undefined;
    return !!link;
  } catch {
    return false;
  }
}

/** Build prompt for LLM generalisation. */
function buildGeneralisePrompt(
  lessons: AgentLesson[],
): string {
  let template: string;
  try {
    template = loadPromptSync("cross-agent-generalize");
  } catch {
    // Inline fallback when prompt file not found
    template = `You are an AI memory system helper. The following facts were learned by individual AI agents (agent-scoped). Your task is to identify which of these lessons are general enough to apply across ALL agents as shared global knowledge.

Agent lessons:
{{lessons}}

Return a JSON array (no markdown fences) of generalised lessons. Each item must have:
- "text": the generalised lesson in one concise sentence (max 200 chars)
- "rationale": why this generalises across agents (max 100 chars)
- "sourceAgents": array of agentIds whose lessons contributed
- "importance": 0.6-0.9 float

Rules:
- Only generalise lessons that are truly cross-agent applicable (e.g. "Always verify X before Y")
- Do NOT generalise facts that are agent-specific workflows, personal preferences, or single-agent observations
- Do NOT include lessons already obviously covered by common knowledge
- Return [] if no lessons qualify
- Maximum 10 generalised lessons per call`;
  }

  const lessonsJson = JSON.stringify(
    lessons.map((l) => ({
      agentId: l.agentId,
      category: l.category,
      text: l.text,
      confidence: l.confidence,
    })),
    null,
    2,
  );

  return fillPrompt(template, { lessons: lessonsJson });
}

/** Call LLM and parse the generalised lessons. */
async function callLLMForGeneralisation(
  openai: OpenAI,
  model: string,
  prompt: string,
  fallbackModels: string[],
  logger: { warn?: (msg: string) => void },
): Promise<LLMGeneralisedLesson[]> {
  const text = await chatCompleteWithRetry({
    openai,
    model,
    fallbackModels,
    content: prompt,
    maxTokens: 2000,
    timeoutMs: 40000,
  });

  if (!text || text.trim().length === 0) return [];

  // Strip markdown fences if present
  const jsonStr = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is LLMGeneralisedLesson =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as LLMGeneralisedLesson).text === "string" &&
        (item as LLMGeneralisedLesson).text.trim().length > 0,
    );
  } catch {
    logger.warn?.(`cross-agent-learning: failed to parse LLM response as JSON: ${text.slice(0, 200)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run cross-agent learning: generalise agent-scoped lessons into global facts.
 *
 * @param factsDb    Facts database.
 * @param openai     OpenAI client (multi-provider proxy).
 * @param cfg        Cross-agent learning config.
 * @param logger     Logger (warn-only needed).
 * @returns          Summary report.
 */
export async function runCrossAgentLearning(
  factsDb: FactsDB,
  openai: OpenAI,
  cfg: CrossAgentLearningConfig,
  logger: { warn?: (msg: string) => void } = {},
): Promise<CrossAgentLearningResult> {
  const result: CrossAgentLearningResult = {
    agentsScanned: 0,
    lessonsConsidered: 0,
    generalisedStored: 0,
    linksCreated: 0,
    skippedDuplicates: 0,
    errors: 0,
    newFacts: [],
  };

  try {
    const allLessons = collectAgentLessons(factsDb, cfg.windowDays);

    // Gather unique agent IDs
    const agentIds = new Set(allLessons.map((l) => l.agentId));
    result.agentsScanned = agentIds.size;

    if (allLessons.length === 0) {
      return result;
    }

    // Filter out lessons that are already generalised
    const candidates = allLessons.filter((l) => !agentFactAlreadyGeneralised(factsDb, l.factId));
    result.lessonsConsidered = candidates.length;

    if (candidates.length === 0) {
      return result;
    }

    // Process in batches of cfg.batchSize
    const batchSize = cfg.batchSize ?? 20;
    const batches: AgentLesson[][] = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      batches.push(candidates.slice(i, i + batchSize));
    }

    const model = cfg.model ?? "gpt-4o-mini";
    const fallbackModels = cfg.fallbackModels ?? [];

    for (const batch of batches) {
      try {
        const prompt = buildGeneralisePrompt(batch);
        const generalised = await callLLMForGeneralisation(openai, model, prompt, fallbackModels, logger);

        for (const lesson of generalised) {
          if (!lesson.text || lesson.text.trim().length < 10) continue;
          if (lesson.text.length > 500) {
            lesson.text = lesson.text.slice(0, 497) + "...";
          }

          // Skip if already exists globally
          if (globalFactAlreadyExists(factsDb, lesson.text)) {
            result.skippedDuplicates++;
            continue;
          }

          // Find the source agent facts that contributed
          const sourceAgentIds = lesson.sourceAgents ?? batch.map((b) => b.agentId);
          const sourceFacts = batch.filter((b) => sourceAgentIds.includes(b.agentId));

          const importance = Math.min(0.95, Math.max(0.5, lesson.importance ?? 0.7) + 0.1);

          // Store as global fact
          const newFact = factsDb.store({
            text: lesson.text,
            category: "pattern",
            entity: null,
            key: null,
            value: null,
            importance,
            confidence: 0.75,
            scope: "global",
            source: CROSS_AGENT_SOURCE,
            tags: [CROSS_AGENT_TAG, ...sourceAgentIds.slice(0, 3)],
            summary: lesson.rationale?.slice(0, 200) ?? null,
          });

          result.generalisedStored++;
          result.newFacts.push({
            id: newFact.id,
            text: lesson.text,
            agentSources: sourceAgentIds,
          });

          // Link each source agent fact → new global fact via DERIVED_FROM
          for (const sourceFact of sourceFacts) {
            try {
              factsDb.createLink(
                sourceFact.factId,
                newFact.id,
                "DERIVED_FROM",
                0.8,
              );
              result.linksCreated++;
            } catch {
              // Non-fatal: link already exists or fact deleted
            }
          }
        }
      } catch (batchErr) {
        result.errors++;
        capturePluginError(batchErr instanceof Error ? batchErr : new Error(String(batchErr)), { operation: "cross-agent-learning-batch" });
        logger.warn?.(`cross-agent-learning: batch error: ${batchErr}`);
      }
    }
  } catch (err) {
    result.errors++;
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "cross-agent-learning" });
    logger.warn?.(`cross-agent-learning: error: ${err}`);
  }

  return result;
}

/**
 * Get all cross-agent generalised facts.
 */
export function getCrossAgentFacts(factsDb: FactsDB, limit = 100): MemoryEntry[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;
  if (!db) return [];

  try {
    const rows = db
      .prepare(
        `SELECT * FROM facts
         WHERE source = ?
           AND scope = 'global'
           AND superseded_at IS NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(CROSS_AGENT_SOURCE, limit) as Array<Record<string, unknown>>;

    // Use rowToEntry via FactsDB — cast to access private method
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r) => (factsDb as any).rowToEntry(r) as MemoryEntry);
  } catch {
    return [];
  }
}
