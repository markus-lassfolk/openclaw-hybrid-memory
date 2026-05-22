/**
 * Utilities for auto-capture filtering and category detection.
 */

import type { MemoryCategory } from "../types/memory.js";
import { CAPTURE_FILTER_PATTERNS } from "./auto-capture.js";

/**
 * Returns true if the text is a memory-classifier artifact or LLM reasoning trace.
 * These should never be stored as memory facts.
 * See: https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1560
 */
export function isPromptArtifactOrReasoningTrace(text: string): boolean {
  const trimmed = text.trim();
  // Chain-of-thought / reasoning trace markers
  if (trimmed.startsWith("<think>")) return true;
  if (/^<thinking>[\s\S]*<\/thinking>$/i.test(trimmed)) return true;
  if (/^think\s*/i.test(trimmed) && /thinking\s*process/i.test(trimmed)) return true;
  if (/^thinking\s*process[:#]/i.test(trimmed)) return true;
  if (/^the\s+user\s+is\s+(asking|requesting)\s+me\s+to\s+(classify|extract)/i.test(trimmed)) return true;
  // Classifier output markers (NOOP |, ADD |, UPDATE |, DELETE |)
  if (/^(ADD|UPDATE|DELETE|NOOP)(?:\s*[a-f0-9-]+)?\s*\|\s*[^|\s]/i.test(trimmed)) return true;
  // Classifier JSON output: single object or array of objects with an "action" field
  // To avoid false positives, require additional classifier-specific fields like "reason" or "targetId"
  try {
    if (/^[[{]/.test(trimmed) && /"action"\s*:/i.test(trimmed)) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && parsed[0] && typeof parsed[0] === "object" && "action" in parsed[0]) {
          // Require classifier-specific fields to avoid matching legitimate action logs
          const first = parsed[0] as Record<string, unknown>;
          if ("reason" in first || "targetId" in first || "confidence" in first) {
            return true;
          }
        }
      } else if (parsed && typeof parsed === "object" && "action" in parsed) {
        // Require classifier-specific fields to avoid matching legitimate action logs
        if ("reason" in parsed || "targetId" in parsed || "confidence" in parsed) {
          return true;
        }
      }
    }
  } catch {
    // Not JSON
  }
  // Memory-hybrid capability hints (issue #1560)
  if (trimmed.startsWith("<!-- ") && trimmed.includes("memory-hybrid:")) return true;
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
