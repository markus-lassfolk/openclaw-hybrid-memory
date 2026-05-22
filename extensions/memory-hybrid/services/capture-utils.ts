/**
 * Utilities for auto-capture filtering and category detection.
 */

import type { MemoryCategory } from "../types/memory.js";
import { CAPTURE_FILTER_PATTERNS } from "./auto-capture.js";

const CLASSIFICATION_ARTIFACT_PHRASES = [
  "classify a new memory fact",
  "you are a memory classifier",
  "a new fact is being stored",
  "compare it against existing facts and decide what to do",
  "respond with exactly one line in this format: action [id] | reason",
  "respond with only a json array",
] as const;

const ONE_LINE_CLASSIFICATION_RE = /^(ADD|NOOP|UPDATE|DELETE)(?:\s+[^|\n]+)?\s*\|\s*\S+/i;

function looksLikeClassifierJsonArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => looksLikeClassifierJsonArtifact(item));
  }

  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.classifications)) return looksLikeClassifierJsonArtifact(obj.classifications);

  const action = typeof obj.action === "string" ? obj.action.trim().toUpperCase() : "";
  if (!["ADD", "UPDATE", "DELETE", "NOOP"].includes(action)) return false;

  const hasClassifierShape =
    "reason" in obj || "targetId" in obj || "target_id" in obj || "classification" in obj || "existingFactId" in obj;
  return hasClassifierShape;
}

/**
 * Reject internal classifier prompts/results before they can become durable memory facts.
 *
 * This intentionally covers both one-line classification responses (for example
 * `NOOP | ...`) and batch JSON classifier structures. These artifacts describe the
 * storage decision, not user knowledge, so they must never enter SQLite or LanceDB.
 */
export function isClassificationArtifactForStorage(input: unknown): boolean {
  if (typeof input !== "string") return looksLikeClassifierJsonArtifact(input);

  const text = input.trim();
  if (!text) return false;
  const lower = text.toLowerCase();

  if (text.startsWith("NOOP |")) return true;
  if (ONE_LINE_CLASSIFICATION_RE.test(text)) return true;
  if (CLASSIFICATION_ARTIFACT_PHRASES.some((phrase) => lower.includes(phrase))) return true;

  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      return looksLikeClassifierJsonArtifact(JSON.parse(text));
    } catch {
      return false;
    }
  }

  return false;
}

export function assertNotClassificationArtifactForStorage(input: unknown): void {
  if (isClassificationArtifactForStorage(input)) {
    throw new Error("memory-hybrid: refusing to store classification artifact");
  }
}

export function shouldCapture(text: string, captureMaxChars: number, memoryTriggers: RegExp[]): boolean {
  if (text.length < 10 || text.length > captureMaxChars) return false;
  if (text.includes("<relevant-memories>")) return false;
  if (isClassificationArtifactForStorage(text)) return false;
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
