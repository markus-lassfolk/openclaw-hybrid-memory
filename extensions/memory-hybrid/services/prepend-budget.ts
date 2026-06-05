/**
 * Per-turn global prepend token budget shared across before_agent_start hooks.
 * Recall initializes and consumes first; active-task and other injectors respect remaining budget.
 */

import { estimateTokens } from "../utils/text.js";

export type PrependBudgetState = {
  totalTokens: number;
  remainingTokens: number;
  sessionKey: string;
};

export type PrependBudgetRef = { value: PrependBudgetState | null };

export function createPrependBudgetRef(): PrependBudgetRef {
  return { value: null };
}

export function initPrependBudget(ref: PrependBudgetRef, totalTokens: number, sessionKey: string): void {
  const total = Math.max(0, Math.floor(totalTokens));
  ref.value = {
    totalTokens: total,
    remainingTokens: total,
    sessionKey,
  };
}

export function getRemainingPrependTokens(ref: PrependBudgetRef | undefined): number | undefined {
  return ref?.value?.remainingTokens;
}

/** Reserve tokens (e.g. for downstream hooks) without injecting content yet. */
export function reservePrependBudget(ref: PrependBudgetRef | undefined, tokens: number): number {
  if (!ref?.value) return 0;
  const reserve = Math.max(0, Math.floor(tokens));
  const applied = Math.min(reserve, ref.value.remainingTokens);
  ref.value.remainingTokens = Math.max(0, ref.value.remainingTokens - applied);
  return applied;
}

/** Consume tokens for injected text; returns tokens charged. */
export function consumePrependBudget(ref: PrependBudgetRef | undefined, text: string): number {
  if (!ref?.value || !text) return 0;
  const cost = estimateTokens(text);
  const applied = Math.min(cost, ref.value.remainingTokens);
  ref.value.remainingTokens = Math.max(0, ref.value.remainingTokens - applied);
  return applied;
}

/** Cap a token budget to remaining global prepend budget (chars ≈ tokens * 4). */
export function capBudgetToPrependRemaining(ref: PrependBudgetRef | undefined, requestedTokens: number): number {
  const remaining = getRemainingPrependTokens(ref);
  if (remaining === undefined) return Math.max(0, Math.floor(requestedTokens));
  return Math.max(0, Math.min(Math.floor(requestedTokens), remaining));
}

/** Trim prepend text to fit remaining global budget; returns trimmed text and tokens charged. */
export function trimPrependToRemainingBudget(
  ref: PrependBudgetRef | undefined,
  text: string,
): { text: string; chargedTokens: number } {
  if (!text) return { text: "", chargedTokens: 0 };
  const remaining = getRemainingPrependTokens(ref);
  if (remaining === undefined) {
    return { text, chargedTokens: estimateTokens(text) };
  }
  if (remaining <= 0) return { text: "", chargedTokens: 0 };

  const cost = estimateTokens(text);
  if (cost <= remaining) {
    return { text, chargedTokens: cost };
  }

  const maxChars = Math.max(0, remaining * 4);
  const trimmed = `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n…(prepend budget cap)\n`;
  const trimmedCost = Math.min(estimateTokens(trimmed), remaining);
  return { text: trimmed, chargedTokens: trimmedCost };
}

/** Charge prepend budget for text already sized to fit; use after building capped content. */
export function finalizePrependCharge(ref: PrependBudgetRef | undefined, text: string): void {
  if (!ref?.value || !text) return;
  consumePrependBudget(ref, text);
}
