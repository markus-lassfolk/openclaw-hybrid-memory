/**
 * Directive extraction (issue #39): scan session JSONL for user messages
 * that contain directive phrases (10 categories: explicit memory requests,
 * future behavior changes, absolute rules, corrections, preferences, warnings,
 * procedural, implicit corrections, emotional emphasis, conditional rules).
 * Uses multi-language directive signals from .language-keywords.json.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getDirectiveCategoryRegexes } from "../utils/language-keywords.js";
import { extractMessageText, truncate, timestampFromFilename } from "../utils/text.js";

/** 10 directive categories (can overlap — a message may have multiple types). */
export const DIRECTIVE_CATEGORIES = [
  "explicit_memory",
  "future_behavior",
  "absolute_rule",
  "correction",
  "preference",
  "warning",
  "procedural",
  "implicit_correction",
  "emotional_emphasis",
  "conditional_rule",
] as const;

export type DirectiveCategory = (typeof DIRECTIVE_CATEGORIES)[number];

export type DirectiveIncident = {
  userMessage: string;
  /** Which directive categories were detected (can be multiple). */
  categories: DirectiveCategory[];
  /** Extracted rule/instruction (what the agent should remember). */
  extractedRule: string;
  /** Preceding agent message (what triggered the directive). */
  precedingAssistant: string;
  /** Confidence score 0-1 (how certain this is a real directive vs conversational noise). */
  confidence: number;
  timestamp?: string;
  sessionFile: string;
};

export type DirectiveExtractResult = {
  incidents: DirectiveIncident[];
  sessionsScanned: number;
};

/**
 * Phase 2: Check if an incident contains a procedural directive (category 7).
 * Returns true if procedure creation is recommended.
 */
export function isProceduralDirective(incident: DirectiveIncident): boolean {
  return incident.categories.includes("procedural");
}

/**
 * @deprecated Use isProceduralDirective instead (typo fix).
 */
export function isProceduraDirective(incident: DirectiveIncident): boolean {
  return isProceduralDirective(incident);
}

/**
 * Phase 2: Extract task intent from a procedural directive for procedure storage.
 * This is a heuristic — LLM-based extraction would be more accurate.
 */
export function extractTaskIntentFromDirective(userMessage: string, context: string): string {
  // Try to extract the task description from the directive
  // Look for patterns like "before you do X", "first check Y", "when Z happens"
  const lower = userMessage.toLowerCase();
  
  // Pattern 1: "before you do X" -> task = X
  let match = lower.match(/before you (?:do|run|execute|start)\s+(.+?)(?:[,.]|$)/);
  if (match) return match[1].trim().slice(0, 200);
  
  // Pattern 2: "first check X" -> task = "check X"
  match = lower.match(/first (?:check|verify|ensure)\s+(.+?)(?:[,.]|$)/);
  if (match) return `check ${match[1].trim()}`.slice(0, 200);
  
  // Pattern 3: "when X happens/occurs" -> task = "when X"
  match = lower.match(/when (.+?)\s+(?:happens|occurs)(?:[,.]|$)/);
  if (match) return `when ${match[1].trim()}`.slice(0, 200);
  
  // Pattern 3b: "when X, Y" (without happens/occurs) -> task = "when X"
  match = lower.match(/when ([^,]+),/);
  if (match) return `when ${match[1].trim()}`.slice(0, 200);
  
  // Pattern 4: Use first sentence with action verb
  const sentences = userMessage.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 10);
  for (const s of sentences) {
    if (/\b(check|verify|ensure|make sure|always|never|first|before)\b/i.test(s)) {
      return s.toLowerCase().slice(0, 200);
    }
  }
  
  // Fallback: use the extracted rule or first sentence (ensure lowercase for consistency)
  const fallback = context || sentences[0] || userMessage;
  return fallback.toLowerCase().slice(0, 200);
}

const MAX_USER_MSG = 800;
const MAX_ASSISTANT_MSG = 500;

/** Patterns that indicate a user message should be skipped (heartbeat, cron, system, etc.). */
const SKIP_PATTERNS = [
  /heartbeat/i,
  /cron\s+job|cronjob|schedule.*run|run\s+the\s+nightly|run\s+the\s+weekly/i,
  /compact|pre-compaction|compaction\s+flush/i,
  /sub-?agent|subagent\s+announce/i,
  /NO_REPLY|no\s+reply\s+needed/i,
  /^\s*\{.*"schedule"/m, // JSON cron definition
];

function shouldSkipUserMessage(text: string): boolean {
  if (!text || text.length < 25) return true;
  const t = text.trim();
  if (t.length < 25) return true;
  for (const re of SKIP_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

let categoryRegexCache: Map<DirectiveCategory, RegExp> | null = null;

/**
 * Detect directive categories in a user message.
 * Returns array of categories (can be empty if no clear directive).
 * Confidence is based on signal strength and context.
 * Now uses multilingual keywords from language-keywords.ts.
 */
function detectDirectiveCategories(text: string): { categories: DirectiveCategory[]; confidence: number } {
  if (!categoryRegexCache) {
    const regexes = getDirectiveCategoryRegexes();
    categoryRegexCache = new Map();
    categoryRegexCache.set("explicit_memory", regexes.explicit_memory);
    categoryRegexCache.set("future_behavior", regexes.future_behavior);
    categoryRegexCache.set("absolute_rule", regexes.absolute_rule);
    categoryRegexCache.set("preference", regexes.preference);
    categoryRegexCache.set("warning", regexes.warning);
    categoryRegexCache.set("procedural", regexes.procedural);
    categoryRegexCache.set("implicit_correction", regexes.implicit_correction);
    categoryRegexCache.set("conditional_rule", regexes.conditional_rule);
    categoryRegexCache.set("correction", regexes.correction);
  }

  const categories: DirectiveCategory[] = [];

  // Test against each category regex
  for (const [category, regex] of categoryRegexCache) {
    if (regex.test(text)) {
      categories.push(category);
    }
  }

  // Emotional emphasis (ALL CAPS words, multiple !!!, frustrated emoji)
  const hasAllCaps = /\b[A-Z]{4,}\b/.test(text);
  const hasMultipleExclamation = /!{2,}/.test(text);
  const hasFrustratedEmoji = /[🤬😤😡]/.test(text);
  if (hasAllCaps || hasMultipleExclamation || hasFrustratedEmoji) {
    categories.push("emotional_emphasis");
  }

  // Confidence heuristic:
  // - 1+ explicit category: 0.7+
  // - 2+ categories: 0.8+
  // - Emotional emphasis boosts confidence
  // - Very short message (< 40 chars) reduces confidence
  let confidence = 0.5;
  if (categories.length >= 1) confidence = 0.7;
  if (categories.length >= 2) confidence = 0.8;
  if (categories.includes("emotional_emphasis")) confidence = Math.min(1.0, confidence + 0.1);
  if (text.length < 40) confidence *= 0.8;

  return { categories, confidence };
}

/**
 * Extract a concise rule/instruction from the user message.
 * This is a simple heuristic; LLM-based extraction would be more accurate.
 * Improved: if colon exists ("Remember: ..."), take text after it.
 */
function extractRule(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  
  // Heuristic: If a colon exists, extract text after it (common pattern: "Remember: do X")
  const colonMatch = trimmed.match(/:\s*(.+)/);
  if (colonMatch) {
    const afterColon = colonMatch[1].trim();
    if (afterColon.length >= 10) {
      return afterColon.slice(0, 200);
    }
  }
  
  if (trimmed.length <= 200) return trimmed;
  
  // Try to find a sentence with directive keywords
  const sentences = trimmed.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 10);
  for (const s of sentences) {
    if (/\b(always|never|from now on|make sure|remember|prefer|avoid|when|if)\b/i.test(s)) {
      return s.slice(0, 200);
    }
  }
  return trimmed.slice(0, 200);
}

export type RunDirectiveExtractOpts = {
  filePaths: string[];
  directiveRegex: RegExp;
};

/**
 * Scan session JSONL files for user messages matching directive signals.
 * Uses the provided regex (from getDirectiveSignalRegex() after setKeywordsPath)
 * so that all languages from .language-keywords.json are included.
 */
export function runDirectiveExtract(opts: RunDirectiveExtractOpts): DirectiveExtractResult {
  const { filePaths, directiveRegex } = opts;
  const incidents: DirectiveIncident[] = [];

  for (const filePath of filePaths) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").split("\n");
    } catch {
      continue;
    }

    const messages: Array<{ role: string; text: string }> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { type?: string; message?: { role?: string; content?: unknown } };
        if (obj.type !== "message" || !obj.message) continue;
        const msg = obj.message;
        const role = msg.role === "user" || msg.role === "assistant" ? msg.role : null;
        if (!role) continue;
        const text = extractMessageText(msg.content);
        messages.push({ role, text });
      } catch {
        // skip malformed lines
      }
    }

    const sessionName = basename(filePath);
    const ts = timestampFromFilename(sessionName);

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "user") continue;
      const userText = messages[i].text;
      // Reset lastIndex to avoid statefulness with global/sticky regexes
      directiveRegex.lastIndex = 0;
      if (!directiveRegex.test(userText)) continue;
      if (shouldSkipUserMessage(userText)) continue;

      const { categories, confidence } = detectDirectiveCategories(userText);
      if (categories.length === 0) continue; // No clear directive

      const precedingAssistant =
        i > 0 && messages[i - 1].role === "assistant" ? messages[i - 1].text : "";
      const extractedRule = extractRule(userText);

      incidents.push({
        userMessage: truncate(userText, MAX_USER_MSG),
        categories,
        extractedRule,
        precedingAssistant: truncate(precedingAssistant, MAX_ASSISTANT_MSG),
        confidence,
        timestamp: ts,
        sessionFile: sessionName,
      });
    }
  }

  return { incidents, sessionsScanned: filePaths.length };
}
