/**
 * Memory Operation Classification (ADD/UPDATE/DELETE/NOOP)
 *
 * Extracted from index.ts - pure function for classifying memory operations
 */

import type OpenAI from "openai";
import type { MemoryEntry } from "../types/memory.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { capturePluginError } from "./error-reporter.js";

export type MemoryClassification = {
  action: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  targetId?: string;
  reason: string;
  /** For UPDATE: the updated text to store (only if LLM suggests a merge) */
  updatedText?: string;
};

/**
 * Parse LLM classification response into MemoryClassification.
 * Format: "ACTION [id] | reason". Exported for tests.
 */
export function parseClassificationResponse(content: string, existingFacts: MemoryEntry[]): MemoryClassification {
  const match = content.match(/^(ADD|UPDATE|DELETE|NOOP)\s*([a-f0-9-]*)\s*\|\s*(.+)$/i);
  if (!match) {
    return { action: "ADD", reason: `unparseable LLM response: ${content.slice(0, 80)}` };
  }

  const action = match[1].toUpperCase() as MemoryClassification["action"];
  const targetId = match[2]?.trim() || undefined;
  const reason = match[3].trim();

  if (action === "UPDATE" || action === "DELETE") {
    if (!targetId) {
      return { action: "ADD", reason: `missing targetId for ${action}; treating as ADD` };
    }
    const validTarget = existingFacts.find((f) => f.id === targetId);
    if (!validTarget) {
      return { action: "ADD", reason: `LLM referenced unknown id ${targetId}; treating as ADD` };
    }
  }

  return { action, targetId, reason };
}

function formatExistingFactsLines(existingFacts: MemoryEntry[]): string {
  return existingFacts
    .slice(0, 5)
    .map(
      (f, i) =>
        `${i + 1}. [id=${f.id}] ${f.category}${f.entity ? ` | entity: ${f.entity}` : ""}${f.key ? ` | key: ${f.key}` : ""}: ${f.text.slice(0, 300)}`,
    )
    .join("\n");
}

/** Same rules as prompts/memory-classify.txt — stated once in batch prompts, not repeated per candidate. */
const CLASSIFY_RULES_LINES = `Classify as one of:
- ADD: The new fact is genuinely new information not covered by any existing fact.
- UPDATE <id>: The new fact supersedes or updates an existing fact (e.g., a preference changed, a value was corrected). Specify which existing fact id it replaces.
- DELETE <id>: The new fact explicitly retracts or negates an existing fact (e.g., "I no longer use X"). Specify which fact to invalidate.
- NOOP: The new fact is already adequately captured by existing facts. No action needed.`;

/**
 * Classify an incoming fact against existing similar facts.
 * Uses a cheap LLM call to determine ADD/UPDATE/DELETE/NOOP.
 * Falls back to ADD on error.
 */
function buildClassifyPromptParts(
  candidateText: string,
  candidateEntity: string | null,
  candidateKey: string | null,
  existingFacts: MemoryEntry[],
): { prompt: string } {
  const existingLines = formatExistingFactsLines(existingFacts);

  const template = loadPrompt("memory-classify");
  const prompt = fillPrompt(template, {
    NEW_FACT: candidateText.slice(0, 500),
    ENTITY_LINE: candidateEntity ? `\nEntity: ${candidateEntity}` : "",
    KEY_LINE: candidateKey ? `\nKey: ${candidateKey}` : "",
    EXISTING_FACTS: existingLines,
  });
  return { prompt };
}

/** Per-candidate facts only; rules and JSON schema live in the batch message header. */
function buildBatchCandidateSection(
  candidateText: string,
  candidateEntity: string | null,
  candidateKey: string | null,
  existingFacts: MemoryEntry[],
): string {
  const existingLines = formatExistingFactsLines(existingFacts);
  const template = loadPrompt("memory-classify-batch-candidate");
  return fillPrompt(template, {
    NEW_FACT: candidateText.slice(0, 500),
    ENTITY_LINE: candidateEntity ? `\nEntity: ${candidateEntity}` : "",
    KEY_LINE: candidateKey ? `\nKey: ${candidateKey}` : "",
    EXISTING_FACTS: existingLines,
  });
}

export async function classifyMemoryOperation(
  candidateText: string,
  candidateEntity: string | null,
  candidateKey: string | null,
  existingFacts: MemoryEntry[],
  openai: OpenAI,
  model: string,
  logger: { warn: (msg: string) => void },
): Promise<MemoryClassification> {
  if (existingFacts.length === 0) {
    return { action: "ADD", reason: "no similar facts found" };
  }

  const { prompt } = buildClassifyPromptParts(candidateText, candidateEntity, candidateKey, existingFacts);

  try {
    const { withLLMRetry } = await import("./chat.js");
    const resp = await withLLMRetry(
      () =>
        openai.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 100,
        }),
      { maxRetries: 2 },
    );
    const content = (resp.choices[0]?.message?.content ?? "").trim();
    return parseClassificationResponse(content, existingFacts);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "classify-memory-operation",
      subsystem: "openai",
      model,
    });
    logger.warn(`memory-hybrid: classify operation failed: ${err}`);
    return { action: "ADD", reason: "classification failed; defaulting to ADD" };
  }
}

/** One candidate for {@link classifyMemoryOperationsBatch} (#862). */
export type ClassifyMemoryOperationInput = {
  candidateText: string;
  candidateEntity: string | null;
  candidateKey: string | null;
  existingFacts: MemoryEntry[];
};

function parseBatchClassificationRow(row: unknown, existingFacts: MemoryEntry[]): MemoryClassification {
  if (!row || typeof row !== "object") {
    return { action: "ADD", reason: "invalid batch row" };
  }
  const r = row as Record<string, unknown>;
  const action = typeof r.action === "string" ? r.action.toUpperCase() : "";
  const targetId = typeof r.targetId === "string" && r.targetId.trim() ? r.targetId.trim() : undefined;
  const reason = typeof r.reason === "string" ? r.reason.trim() : "batch classification";
  if (action === "ADD" || action === "NOOP") {
    return { action: action as MemoryClassification["action"], reason };
  }
  if (action === "UPDATE" || action === "DELETE") {
    if (!targetId) {
      return { action: "ADD", reason: `batch: missing targetId for ${action}` };
    }
    const validTarget = existingFacts.find((f) => f.id === targetId);
    if (!validTarget) {
      return { action: "ADD", reason: `batch: unknown targetId ${targetId}` };
    }
    return { action: action as MemoryClassification["action"], targetId, reason };
  }
  return { action: "ADD", reason: `batch: unknown action ${action}` };
}

/**
 * Classify multiple store candidates in one LLM call when each has similar facts (#862).
 * Falls back to sequential {@link classifyMemoryOperation} if parsing fails or length mismatches.
 */
export async function classifyMemoryOperationsBatch(
  items: ClassifyMemoryOperationInput[],
  openai: OpenAI,
  model: string,
  logger: { warn: (msg: string) => void },
): Promise<MemoryClassification[]> {
  if (items.length === 0) return [];
  if (items.length === 1) {
    const one = items[0];
    return [
      await classifyMemoryOperation(
        one.candidateText,
        one.candidateEntity,
        one.candidateKey,
        one.existingFacts,
        openai,
        model,
        logger,
      ),
    ];
  }

  const blocks = items.map((it, idx) => {
    const section = buildBatchCandidateSection(it.candidateText, it.candidateEntity, it.candidateKey, it.existingFacts);
    return `### Candidate ${idx}\n${section}`;
  });

  const header = `You are a memory classifier. There are ${items.length} independent candidates below. ${CLASSIFY_RULES_LINES}

Respond with ONLY a JSON array of exactly ${items.length} objects in order (index 0 = first candidate). Do not use a one-line "ACTION | reason" reply; use JSON only. Each object must be:
{"action":"ADD"|"UPDATE"|"DELETE"|"NOOP","targetId":string|null,"reason":string}
For UPDATE or DELETE, targetId must be one of the existing fact ids listed under that candidate. For ADD or NOOP use null for targetId.

`;

  const fullPrompt = `${header}\n${blocks.join("\n\n")}`;

  try {
    const { withLLMRetry } = await import("./chat.js");
    const resp = await withLLMRetry(
      () =>
        openai.chat.completions.create({
          model,
          messages: [{ role: "user", content: fullPrompt }],
          temperature: 0,
          max_tokens: Math.min(800, 80 * items.length),
        }),
      { maxRetries: 2 },
    );
    const raw = (resp.choices[0]?.message?.content ?? "").trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("no JSON array in batch classify response");
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length !== items.length) {
      throw new Error(
        `batch classify expected ${items.length} results, got ${Array.isArray(parsed) ? parsed.length : "non-array"}`,
      );
    }
    return items.map((it, i) => parseBatchClassificationRow(parsed[i], it.existingFacts));
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "classify-memory-operations-batch",
      subsystem: "openai",
      model,
      severity: "info",
    });
    logger.warn(`memory-hybrid: batch classify failed (${err}); falling back to sequential calls`);
    const out: MemoryClassification[] = [];
    for (const it of items) {
      out.push(
        await classifyMemoryOperation(
          it.candidateText,
          it.candidateEntity,
          it.candidateKey,
          it.existingFacts,
          openai,
          model,
          logger,
        ),
      );
    }
    return out;
  }
}
