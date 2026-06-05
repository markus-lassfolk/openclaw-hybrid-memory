import type { MemoryEntry } from "../../types/memory.js";
import { sanitizePromptInjection } from "../skill-prompt-injection.js";

/** Approximate token count from character count (chars / 4). */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Serialize a MemoryEntry as a compact string for context injection.
 *
 * Format:
 * ```
 * [entity: X | category: Y | confidence: 0.95 | stored: 2026-02-15]
 * Fact text here.
 * ```
 *
 * When `options.isContradicted` is true, a warning line is prepended so the
 * consumer knows the fact has an unresolved contradiction.
 *
 * Prompt-injection markers in the memory text are sanitized before serialization
 * so that stored user-authored or web-ingested content cannot escalate into
 * instructions in the assembled prompt (Issue #1579).
 */
export function serializeFactForContext(entry: MemoryEntry, options?: { isContradicted?: boolean }): string {
  const parts: string[] = [];

  if (entry.entity) parts.push(`entity: ${sanitizePromptInjection(entry.entity)}`);
  parts.push(`category: ${entry.category}`);
  parts.push(`confidence: ${entry.confidence.toFixed(2)}`);
  const storedSec = entry.sourceDate ?? entry.createdAt;
  const storedDate = new Date(storedSec * 1000).toISOString().slice(0, 10);
  parts.push(`stored: ${storedDate}`);

  const header = `[${parts.join(" | ")}]`;
  const sanitizedText = sanitizePromptInjection(entry.text);
  const body = `${header}\n${sanitizedText}`;
  if (options?.isContradicted) {
    return `[WARNING: CONTRADICTED — verify before use]\n${body}`;
  }
  return body;
}

/**
 * Pack fused results into a token budget in score order.
 * Returns serialized strings + factIds + tokens used.
 */
export function packIntoBudget(
  entries: Array<{ factId: string; entry: MemoryEntry }>,
  budgetTokens: number,
  options?: { contradictedIds?: Set<string> },
): { packed: string[]; tokensUsed: number } {
  const packed: string[] = [];
  let tokensUsed = 0;

  for (const { factId, entry } of entries) {
    const serialized = serializeFactForContext(entry, {
      isContradicted: options?.contradictedIds?.has(factId) ?? false,
    });
    const tokens = estimateTokenCount(serialized);
    if (tokensUsed + tokens > budgetTokens) break;
    packed.push(serialized);
    tokensUsed += tokens;
  }
  return { packed, tokensUsed };
}
