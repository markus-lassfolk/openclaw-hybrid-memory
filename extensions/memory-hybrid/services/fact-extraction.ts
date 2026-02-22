/**
 * Structured Fact Extraction
 *
 * Extracted from index.ts - pure function for extracting structured fields from text
 */

import type { MemoryCategory } from "../config.js";
import { tryExtractionFromTemplates } from "../utils/extraction-from-template.js";
import { getExtractionTemplates } from "../utils/language-keywords.js";

/**
 * Extract structured fields (entity, key, value) from fact text.
 * Supports English and Swedish patterns.
 */
export function extractStructuredFields(
  text: string,
  category: MemoryCategory,
): { entity: string | null; key: string | null; value: string | null } {
  const lower = text.toLowerCase();

  const decisionMatch = text.match(
    /(?:decided|chose|picked|went with|selected|choosing)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for|due to|over)\s+(.+?))?\.?$/i,
  );
  if (decisionMatch) {
    return {
      entity: "decision",
      key: decisionMatch[1].trim().slice(0, 100),
      value: decisionMatch[2]?.trim() || "no rationale recorded",
    };
  }

  const decisionMatchSv = text.match(
    /(?:bestämde|valde)\s+(?:att\s+(?:använda\s+)?)?(.+?)(?:\s+(?:eftersom|för att)\s+(.+?))?\.?$/i,
  );
  if (decisionMatchSv) {
    return {
      entity: "decision",
      key: decisionMatchSv[1].trim().slice(0, 100),
      value: decisionMatchSv[2]?.trim() || "no rationale recorded",
    };
  }

  const choiceMatch = text.match(
    /(?:use|using|chose|prefer|picked)\s+(.+?)\s+(?:over|instead of|rather than)\s+(.+?)(?:\s+(?:because|since|for|due to)\s+(.+?))?\.?$/i,
  );
  if (choiceMatch) {
    return {
      entity: "decision",
      key: `${choiceMatch[1].trim()} over ${choiceMatch[2].trim()}`,
      value: choiceMatch[3]?.trim() || "preference",
    };
  }

  const ruleMatch = text.match(
    /(?:always|never|must|should always|should never|alltid|aldrig)\s+(.+?)\.?$/i,
  );
  if (ruleMatch) {
    return {
      entity: "convention",
      key: ruleMatch[1].trim().slice(0, 100),
      value: lower.includes("never") || lower.includes("aldrig") ? "never" : "always",
    };
  }

  const possessiveMatch = text.match(
    /(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/,
  );
  if (possessiveMatch) {
    return {
      entity: possessiveMatch[1] || "user",
      key: possessiveMatch[2].trim(),
      value: possessiveMatch[3].trim(),
    };
  }

  const possessiveMatchSv = text.match(
    /(?:mitt|min)\s+(\S+)\s+är\s+(.+?)\.?$/i,
  );
  if (possessiveMatchSv) {
    return {
      entity: "user",
      key: possessiveMatchSv[1].trim(),
      value: possessiveMatchSv[2].trim(),
    };
  }

  const preferMatch = text.match(
    /[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/,
  );
  if (preferMatch) {
    return {
      entity: "user",
      key: preferMatch[1],
      value: preferMatch[2].trim(),
    };
  }

  const preferMatchSv = text.match(
    /jag\s+(föredrar|gillar|ogillar|vill ha|behöver)\s+(.+?)\.?$/i,
  );
  if (preferMatchSv) {
    return {
      entity: "user",
      key: preferMatchSv[1],
      value: preferMatchSv[2].trim(),
    };
  }

  const heterMatch = text.match(
    /heter\s+(.+?)\.?$/i,
  );
  if (heterMatch) {
    return {
      entity: "entity",
      key: "name",
      value: heterMatch[1].trim(),
    };
  }

  const templateResult = tryExtractionFromTemplates(getExtractionTemplates(), text);
  if (templateResult) return templateResult;

  const emailMatch = text.match(/([\w.-]+@[\w.-]+\.\w+)/);
  if (emailMatch) {
    return { entity: null, key: "email", value: emailMatch[1] };
  }

  const phoneMatch = text.match(/(\+?\d{10,})/);
  if (phoneMatch) {
    return { entity: null, key: "phone", value: phoneMatch[1] };
  }

  if (category === "entity") {
    const words = text.split(/\s+/);
    // Include Swedish/Nordic letters (åäö) and other Unicode letters so names like Doris, Lotta, Åsa match
    const properNouns = words.filter((w) => /^\p{Lu}\p{L}+$/u.test(w));
    if (properNouns.length > 0) {
      return { entity: properNouns[0], key: null, value: null };
    }
  }

  return { entity: null, key: null, value: null };
}
