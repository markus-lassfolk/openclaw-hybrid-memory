/**
 * Memory Operation Classification (ADD/UPDATE/DELETE/NOOP)
 *
 * Extracted from index.ts - pure function for classifying memory operations
 */

import OpenAI from "openai";
import type { MemoryEntry } from "../types/memory.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
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
export function parseClassificationResponse(
  content: string,
  existingFacts: MemoryEntry[],
): MemoryClassification {
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

/**
 * Classify an incoming fact against existing similar facts.
 * Uses a cheap LLM call to determine ADD/UPDATE/DELETE/NOOP.
 * Falls back to ADD on error.
 */
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

  const existingLines = existingFacts
    .slice(0, 5)
    .map(
      (f, i) =>
        `${i + 1}. [id=${f.id}] ${f.category}${f.entity ? ` | entity: ${f.entity}` : ""}${f.key ? ` | key: ${f.key}` : ""}: ${f.text.slice(0, 300)}`,
    )
    .join("\n");

  const template = loadPrompt("memory-classify");
  const prompt = fillPrompt(template, {
    NEW_FACT: candidateText.slice(0, 500),
    ENTITY_LINE: candidateEntity ? `\nEntity: ${candidateEntity}` : "",
    KEY_LINE: candidateKey ? `\nKey: ${candidateKey}` : "",
    EXISTING_FACTS: existingLines,
  });

  try {
    // Retry logic for transient errors (rate limits, 5xx)
    const maxRetries = 2;
    let lastError: Error | undefined;
    let resp;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        resp = await openai.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 100,
        });
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    if (!resp) throw lastError;
    const content = (resp.choices[0]?.message?.content ?? "").trim();
    return parseClassificationResponse(content, existingFacts);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'classify-memory-operation',
      subsystem: 'openai',
      model,
    });
    logger.warn(`memory-hybrid: classify operation failed: ${err}`);
    return { action: "ADD", reason: "classification failed; defaulting to ADD" };
  }
}
