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
 *  5. Link new global fact → source agent facts via DERIVED_FROM.
 *  6. Return a report.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";
import type { CrossAgentLearningConfig } from "../config/types/features.js";
import { chatCompleteWithRetry } from "./chat.js";
import { loadPrompt as loadPromptSync, fillPrompt } from "../utils/prompt-loader.js";
import { capturePluginError } from "./error-reporter.js";
import { parseTags, serializeTags } from "../utils/tags.js";
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
// Category whitelist for agent lessons we consider for generalisation
const LEARNABLE_CATEGORIES = new Set(["pattern", "rule", "fact", "decision"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull all agent-scoped facts (pattern/rule/fact/decision) within a recency window. */
function collectAgentLessons(factsDb: FactsDB, windowDays: number, minSourceConfidence: number): AgentLesson[] {
  const db = factsDb.getRawDb();
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
      .all(minSourceConfidence, cutoff) as Array<{
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
  const db = factsDb.getRawDb();
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
  const db = factsDb.getRawDb();
  if (!db) return false;

  try {
    const link = db
      .prepare(
        `SELECT ml.id
         FROM memory_links ml
         JOIN facts f ON f.id = ml.source_fact_id
         WHERE ml.target_fact_id = ?
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

  if (cfg.enabled === false) {
    return result;
  }

  try {
    const allLessons = collectAgentLessons(factsDb, cfg.windowDays, cfg.minSourceConfidence);

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
            tags: [CROSS_AGENT_TAG, "*", ...sourceAgentIds.slice(0, 3)],
            summary: lesson.rationale?.slice(0, 200) ?? null,
          });

          result.generalisedStored++;
          result.newFacts.push({
            id: newFact.id,
            text: lesson.text,
            agentSources: sourceAgentIds,
          });

          // Link new global fact → source agent facts via DERIVED_FROM
          for (const sourceFact of sourceFacts) {
            try {
              factsDb.createLink(
                newFact.id,
                sourceFact.factId,
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
  const db = factsDb.getRawDb();
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

    // Use public getByIds API to convert rows to MemoryEntry
    const ids = rows.map((r) => r.id as string);
    const entryMap = factsDb.getByIds(ids);
    return ids.map((id) => entryMap.get(id)).filter((e): e is MemoryEntry => e !== undefined);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Gap 1: Cross-agent lesson retrieval by agent+context
// ---------------------------------------------------------------------------

/**
 * Retrieve cross-agent lessons applicable to a target agent and context.
 *
 * Performs a FTS search scoped to cross-agent-learning facts, then filters by:
 * - applicableAgents includes targetAgent or "*" (stored as tags)
 * - confidence >= minConfidence
 *
 * @param factsDb       Facts database.
 * @param targetAgent   Agent ID requesting lessons (matched against tags).
 * @param context       Natural-language context query for relevance ranking.
 * @param limit         Max results to return (default 5).
 * @param minConfidence Minimum confidence threshold (default 0.6).
 * @returns             Relevant MemoryEntry lessons, sorted by relevance.
 */
export async function getCrossAgentLessons(
  factsDb: FactsDB,
  targetAgent: string,
  context: string,
  limit: number = 5,
  minConfidence: number = 0.6,
): Promise<MemoryEntry[]> {
  const db = factsDb.getRawDb();
  if (!db) return [];

  try {
    // Pull all candidate cross-agent facts above the confidence threshold.
    // We load more than `limit` then filter/rank in JS.
    const rows = db
      .prepare(
        `SELECT * FROM facts
         WHERE source = ?
           AND scope = 'global'
           AND category IN ('pattern', 'rule')
           AND confidence >= ?
           AND superseded_at IS NULL
         ORDER BY confidence DESC, importance DESC
         LIMIT 200`,
      )
      .all(CROSS_AGENT_SOURCE, minConfidence) as Array<Record<string, unknown>>;

    if (rows.length === 0) return [];

    // Filter by applicableAgents: tag must include targetAgent or the wildcard "*"
    const agentLower = targetAgent.toLowerCase();
    const candidates = rows.filter((row) => {
      const tags = parseTags(row.tags as string | null);
      // A fact is applicable if it has the target agent's tag or the global wildcard "*"
      // It must also carry the cross-agent tag (to distinguish from other global patterns)
      if (!tags.includes(CROSS_AGENT_TAG)) return false;
      return tags.includes(agentLower) || tags.includes("*");
    });

    if (candidates.length === 0) {
      // Fallback: return facts that have no specific agent restriction (only cross-agent tag)
      // These are general lessons applicable to all agents — exclude facts tagged for other agents.
      const generalRows = rows.filter((row) => {
        const tags = parseTags(row.tags as string | null);
        if (!tags.includes(CROSS_AGENT_TAG)) return false;
        // Only include facts with no agent-specific tags (i.e., wildcard or truly general)
        const agentSpecificTags = tags.filter(
          (t) => t !== CROSS_AGENT_TAG && t !== "*" && !t.startsWith("verified-by:"),
        );
        return agentSpecificTags.length === 0 || tags.includes("*");
      });
      const generalIds = generalRows.slice(0, limit).map((r) => r.id as string);
      const generalEntryMap = factsDb.getByIds(generalIds);
      return generalIds.map((id) => generalEntryMap.get(id)).filter((e): e is MemoryEntry => e !== undefined);
    }

    // Rank by text similarity to context (simple keyword overlap scoring)
    const contextWords = new Set(
      context
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );

    const scored = candidates.map((row) => {
      const text = (row.text as string ?? "").toLowerCase();
      let overlap = 0;
      for (const word of contextWords) {
        if (text.includes(word)) overlap++;
      }
      const confidence = row.confidence as number ?? 0;
      const importance = row.importance as number ?? 0;
      const score = overlap * 0.5 + confidence * 0.3 + importance * 0.2;
      return { row, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const topIds = scored.slice(0, limit).map(({ row }) => row.id as string);
    const topEntryMap = factsDb.getByIds(topIds);
    return topIds.map((id) => topEntryMap.get(id)).filter((e): e is MemoryEntry => e !== undefined);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Gap 2: Brief injection formatter
// ---------------------------------------------------------------------------

/**
 * Format a list of cross-agent lessons into a markdown brief suitable for
 * injection into an agent's context window.
 *
 * @param lessons  Array of MemoryEntry lessons from getCrossAgentLessons.
 * @returns        Markdown string, or empty string when lessons is empty.
 */
export function formatBriefInjection(lessons: MemoryEntry[]): string {
  if (lessons.length === 0) return "";

  const lines: string[] = ["## Lessons from previous tasks"];

  for (const lesson of lessons) {
    const tags = lesson.tags ?? [];
    // sourceAgent is stored as a tag (the agent IDs contributing to this lesson)
    const agentTags = tags.filter(
      (t) => t !== CROSS_AGENT_TAG && t !== "*" && !t.startsWith("verified-by:"),
    );
    const sourceAgent = agentTags[0] ?? "unknown";
    const confidence = lesson.confidence?.toFixed(2) ?? "?";
    lines.push(`- ${lesson.text} (learned by ${sourceAgent}, confidence: ${confidence})`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gap 3: Verification tracking
// ---------------------------------------------------------------------------

/**
 * Record that a verifying agent has confirmed a cross-agent lesson.
 * Adds the agent to a "verified-by:<agent>" tag and boosts confidence (capped at 1.0).
 *
 * @param factsDb         Facts database.
 * @param lessonId        ID of the cross-agent lesson fact.
 * @param verifyingAgent  Agent ID confirming the lesson.
 * @param boost           Confidence boost (default 0.1, capped at 1.0 total).
 */
export async function verifyLessonForAgent(
  factsDb: FactsDB,
  lessonId: string,
  verifyingAgent: string,
  boost: number = 0.1,
): Promise<void> {
  const db = factsDb.getRawDb();
  if (!db) return;

  try {
    const row = db
      .prepare(`SELECT id, confidence, tags FROM facts WHERE id = ? AND source = ? AND superseded_at IS NULL`)
      .get(lessonId, CROSS_AGENT_SOURCE) as { id: string; confidence: number; tags: string | null } | undefined;

    if (!row) return;

    const verifiedByTag = `verified-by:${verifyingAgent.toLowerCase()}`;
    const existingTags = parseTags(row.tags);

    // Only add tag if not already present
    const updatedTags = existingTags.includes(verifiedByTag)
      ? existingTags
      : [...existingTags, verifiedByTag];

    // Boost confidence, cap at 1.0
    const newConfidence = Math.min(1.0, (row.confidence ?? 0.6) + boost);

    db.prepare(`UPDATE facts SET confidence = ?, tags = ? WHERE id = ?`).run(
      newConfidence,
      serializeTags(updatedTags),
      lessonId,
    );
  } catch {
    // Non-fatal: fact may have been deleted or superseded
  }
}
