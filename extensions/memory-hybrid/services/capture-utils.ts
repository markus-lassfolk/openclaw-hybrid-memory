/**
 * Utilities for auto-capture filtering and category detection.
 */

import type { MemoryCategory } from "../types/memory.js";
import { CAPTURE_FILTER_PATTERNS } from "./auto-capture.js";

/**
 * Returns true if `text` matches patterns that indicate it is a chain-of-thought,
 * reasoning-trace, or classifier prompt/output artifact rather than genuine user content.
 * Used by auto-capture, CLI store, and memory_store classification paths to reject
 * the garbage facts that pollute hot memories and progressive recall (#1560).
 */
export function isPromptArtifactOrReasoningTrace(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Reject text beginning with think/think markers (with optional leading whitespace)
  if (/^think\s/i.test(trimmed)) return true;
  // Reject "Thinking Process" headers emitted by some models
  if (/^Thinking Process[;:]/i.test(trimmed)) return true;
  // Reject classifier/system prompt fragments
  if (/^The user is asking me to (classify|extract)/i.test(trimmed)) return true;
  // Reject structured operation markers from memory classification
  if (/^NOOP \|/i.test(trimmed)) return true;
  if (/^ADD \|/i.test(trimmed)) return true;
  if (/^UPDATE \|/i.test(trimmed)) return true;
  // Reject classifier JSON output
  if (/^\{"action"\s*:/i.test(trimmed)) return true;
  // Reject capability-hint markers injected into system context
  if (/^<!--\s*memory-hybrid\s*:\s*capability\s*hints/i.test(trimmed)) return true;

  return false;
}

export function shouldCapture(text: string, captureMaxChars: number, memoryTriggers: RegExp[]): boolean {
  if (text.length < 10 || text.length > captureMaxChars) return false;
  if (isPromptArtifactOrReasoningTrace(text)) return false;
  if (text.includes("<relevant-memories>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("**") && text.includes("\n-")) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (CAPTURE_FILTER_PATTERNS.some((r) => r.test(text))) return false;
  return memoryTriggers.some((r) => r.test(text));
}

export function detectCategory(
  text: string,
  categoryDecisionRegex: RegExp,
  categoryPreferenceRegex: RegExp,
  categoryEntityRegex: RegExp,
  categoryFactRegex: RegExp,
): MemoryCategory {
  const lower = text.toLowerCase();
  if (categoryDecisionRegex.test(lower)) return "decision";
  if (categoryPreferenceRegex.test(lower)) return "preference";
  if (/\+\d{10,}|@[\w.-]+\.\w+/.test(lower) || categoryEntityRegex.test(lower)) return "entity";
  if (categoryFactRegex.test(lower)) return "fact";
  return "other";
}
