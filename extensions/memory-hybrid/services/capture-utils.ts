/**
 * Utilities for auto-capture filtering and category detection.
 */

import type { MemoryCategory } from "../types/memory.js";
import { CAPTURE_FILTER_PATTERNS } from "./auto-capture.js";

export function shouldCapture(text: string, captureMaxChars: number, memoryTriggers: RegExp[]): boolean {
  if (text.length < 10 || text.length > captureMaxChars) return false;
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
