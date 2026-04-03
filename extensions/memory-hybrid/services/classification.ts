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

/**
 * Remove common model "thinking" wrappers that appear before JSON (#1007).
 */
function stripThinkingWrapperBlocks(s: string): string {
  return s
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

/**
 * Prefer JSON-looking content inside ``` / ```json fences when the model wraps output (#1007).
 */
function preferMarkdownJsonFenceContent(s: string): string {
  const re = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  const chunks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    chunks.push(m[1].trim());
  }
  if (chunks.length === 0) return s;
  const arrayChunk = chunks.find((c) => c.startsWith("["));
  if (arrayChunk) return arrayChunk;
  const objectChunk = chunks.find((c) => c.startsWith("{"));
  if (objectChunk) return objectChunk;
  return chunks[chunks.length - 1] ?? s;
}

/**
 * Extract the first top-level JSON array substring with bracket matching (respects strings).
 * Greedy `\\[[\\s\\S]*\\]` breaks when `]` appears inside string values or reasoning trails.
 */
function extractTopLevelJsonArraySubstring(s: string): string | null {
  const start = s.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const BATCH_OBJECT_ARRAY_KEYS = ["classifications", "results", "items", "data"] as const;

function tryParseBatchClassifyAsObjectWithArray(s: string): unknown[] | null {
  const t = s.trim();
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    for (const k of BATCH_OBJECT_ARRAY_KEYS) {
      const v = rec[k];
      if (Array.isArray(v)) return v;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse model output for {@link classifyMemoryOperationsBatch}. Exported for tests (#1007).
 */
export function parseBatchClassifyResponseContent(raw: string): unknown {
  let s = raw.trim();
  s = stripThinkingWrapperBlocks(s);
  s = preferMarkdownJsonFenceContent(s);
  s = s.trim();

  const tryArrayText = (text: string): unknown => {
    const t = text.trim();
    const fromBalanced = extractTopLevelJsonArraySubstring(t);
    if (fromBalanced) return JSON.parse(fromBalanced);
    if (t.startsWith("[")) return JSON.parse(t);
    const legacy = t.match(/\[[\s\S]*\]/);
    if (legacy) return JSON.parse(legacy[0]);
    throw new Error("no JSON array in batch classify response");
  };

  // Whole string is a JSON array
  if (s.startsWith("[")) {
    try {
      return tryArrayText(s);
    } catch {
      /* fall through */
    }
  }

  // Whole string is a JSON object wrapping the array (some JSON-mode APIs)
  const fromObject = tryParseBatchClassifyAsObjectWithArray(s);
  if (fromObject) return fromObject;

  // Prose or noise before/after — locate balanced array in the remainder
  try {
    return tryArrayText(s);
  } catch {
    /* fall through */
  }

  throw new Error("no JSON array in batch classify response");
}

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
    const parsed: unknown = parseBatchClassifyResponseContent(raw);
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
