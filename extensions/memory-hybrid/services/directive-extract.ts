/**
 * Directive extraction: scan session JSONL for user messages
 * that contain directive phrases (10 categories: explicit memory requests,
 * future behavior changes, absolute rules, corrections, preferences, warnings,
 * procedural, implicit corrections, emotional emphasis, conditional rules).
 * Uses multi-language directive signals from .language-keywords.json.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getDirectiveCategoryRegexes } from "../utils/language-keywords.js";
import { extractMessageText, timestampFromFilename, truncate } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";

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
  rejected?: number;
};

export const DIRECTIVE_EXTRACTION_METHOD = "directive-extract:regex-heuristic-v2";

const MAX_USER_MSG = 800;
const MAX_ASSISTANT_MSG = 500;

/**
 * Patterns that indicate a user message should be skipped (heartbeat, cron, system, etc.).
 *
 * NOTE (Issue #282 — heartbeat quiet mode): The plugin skips CAPTURE from heartbeat
 * messages here, but does NOT generate heartbeat output itself. The "HEARTBEAT_OK"
 * response and any health-report text are produced entirely by OpenClaw core (the agent
 * session runner), which is outside this plugin's scope. Verbosity-aware suppression of
 * "all clear" heartbeat output must therefore be implemented in OpenClaw core.
 *
 * What this plugin's `verbosity` config DOES control:
 *   - Tool response text (memory_recall, memory_store, etc.)
 *   - CLI command output (hybrid-mem status, backup, etc.)
 *   - Pre-compaction flush log messages
 */
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

type DirectiveRejectionReason =
  | "untrusted_metadata"
  | "json_envelope"
  | "chat_fragment"
  | "one_off_command"
  | "missing_durable_signal";

const UNTRUSTED_METADATA_MARKERS = [/conversation info\s*\(untrusted metadata\)/i, /sender\s*\(untrusted metadata\)/i];
const UNTRUSTED_METADATA_KEYS_RE = /\b(chat_id|message_id|sender_id|timestamp|inbound_event_kind|conversation_id)\b/i;
const UNTRUSTED_METADATA_ENVELOPE_BLOCK_RE =
  /(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:\s*```(?:json)?[\s\S]*?```/gi;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const GITHUB_LINK_RE = /https?:\/\/github\.com\/[^\s)]+/gi;
const GITHUB_ISSUE_PR_RE = /(?:^|\s)#\d+(?:\s|$)|\b(?:issue|issues|pr|pull request)\b/i;
const SELECTED_CONTEXT_RE = /(?:^|\s)#\d+\s+(?:mon|tue|wed|thu|fri|sat|sun)\b/i;
const QUESTION_MARK_RE = /\?/;
const ONE_OFF_COMMAND_RE = /\b(file|open|create|submit)\s+(?:a\s+)?(?:detailed\s+)?(?:issue|pr|pull request)\b/i;
const DURABLE_RULE_SIGNAL_RE =
  /\b(always|never|from now on|remember|make sure|must|should|prefer|avoid|do not|don't|when|if|first check|first)\b/i;

function sanitizeDirectiveCandidate(rawRule: string): string {
  return rawRule
    .replace(UNTRUSTED_METADATA_ENVELOPE_BLOCK_RE, " ")
    .replace(CODE_FENCE_RE, " ")
    .replace(/(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyDirectiveCandidate(
  rawRule: string,
  userText: string,
): { accepted: true; sanitizedRule: string } | { accepted: false; reason: DirectiveRejectionReason } {
  if (!rawRule.trim()) return { accepted: false, reason: "missing_durable_signal" };
  if (
    UNTRUSTED_METADATA_MARKERS.some((re) => re.test(rawRule) || re.test(userText)) ||
    UNTRUSTED_METADATA_KEYS_RE.test(rawRule) ||
    UNTRUSTED_METADATA_KEYS_RE.test(userText)
  ) {
    return { accepted: false, reason: "untrusted_metadata" };
  }

  const sanitizedRule = sanitizeDirectiveCandidate(rawRule);
  if (!sanitizedRule) return { accepted: false, reason: "missing_durable_signal" };
  if (UNTRUSTED_METADATA_KEYS_RE.test(sanitizedRule)) return { accepted: false, reason: "untrusted_metadata" };
  const looksLikeRawJsonEnvelope = /^\s*```(?:json)?/i.test(rawRule);
  const looksLikeJsonDocument = /^\s*[{[][\s\S]*[}\]]\s*$/m.test(sanitizedRule);
  if (looksLikeRawJsonEnvelope || looksLikeJsonDocument) {
    return { accepted: false, reason: "json_envelope" };
  }

  const githubLinks = sanitizedRule.match(GITHUB_LINK_RE) ?? [];
  const looksLikeUrlList = githubLinks.length >= 2;
  if (looksLikeUrlList || SELECTED_CONTEXT_RE.test(sanitizedRule) || QUESTION_MARK_RE.test(sanitizedRule)) {
    return { accepted: false, reason: "chat_fragment" };
  }
  if (ONE_OFF_COMMAND_RE.test(sanitizedRule) && GITHUB_ISSUE_PR_RE.test(sanitizedRule)) {
    return { accepted: false, reason: "one_off_command" };
  }
  if (!DURABLE_RULE_SIGNAL_RE.test(sanitizedRule) && !DURABLE_RULE_SIGNAL_RE.test(userText)) {
    return { accepted: false, reason: "missing_durable_signal" };
  }

  return { accepted: true, sanitizedRule };
}

let categoryRegexCache: Map<DirectiveCategory, RegExp> | null = null;

/**
 * Clear the category regex cache (e.g., after keyword rebuild).
 */
export function clearDirectiveCategoryCache(): void {
  categoryRegexCache = null;
}

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
  const hasFrustratedEmoji = /[🤬😤😡]/u.test(text);
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
  if (text.length < 25) confidence *= 0.8; // Reduced threshold from 40 to 25

  return { categories, confidence };
}

/**
 * Common URL/URI scheme names (IANA and common usage). Colons after these words
 * must not be treated as directive separators (e.g. "Remember: ...").
 */
const URI_SCHEMES = new Set([
  "http",
  "https",
  "ftp",
  "file",
  "mailto",
  "tel",
  "ssh",
  "data",
  "ws",
  "wss",
  "irc",
  "imap",
  "nntp",
  "ldap",
  "sftp",
  "git",
  "svn",
  "jdbc",
  "redis",
  "mongodb",
]);

/**
 * Extract a concise rule/instruction from the user message.
 * This is a simple heuristic; LLM-based extraction would be more accurate.
 * Improved: if colon exists ("Remember: ..."), take text after it.
 * Skips colons that are part of URL schemes, time formats, numbered lists, etc.
 */
function extractRule(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");

  // Heuristic: If a colon exists after a word boundary (directive pattern), extract text after it.
  // This regex matches colons that follow a word, but excludes:
  // - URL/URI schemes (http:, https:, ftp:, mailto:, file:, ssh:, data:, etc.) via URI_SCHEMES set
  // - Time formats (14:30) - digit before colon (not matched by \b[a-zA-Z]+)
  // - Numbered lists (Step 1:) - digit before colon
  // - Port numbers - negative lookahead (?!\d) and (?!\/\/)
  const colonRegex = /\b([a-zA-Z]+)\s*:\s*(?!\/\/)(?!\d)(.+)/g;
  let colonMatch;
  while ((colonMatch = colonRegex.exec(trimmed)) !== null) {
    const wordBeforeColon = colonMatch[1].toLowerCase();
    if (URI_SCHEMES.has(wordBeforeColon)) {
      // Skip past the URI by finding the next whitespace after the colon
      // This prevents the greedy .+ from consuming directive colons that come after URIs
      const uriStart = colonMatch.index;
      const afterScheme = trimmed.substring(uriStart + colonMatch[1].length + 1);
      const nextSpace = afterScheme.search(/\s/);
      if (nextSpace !== -1) {
        colonRegex.lastIndex = uriStart + colonMatch[1].length + 1 + nextSpace + 1;
      } else {
        colonRegex.lastIndex = trimmed.length;
      }
      continue;
    }
    const afterColon = colonMatch[2].trim();
    if (afterColon.length >= 10 && !afterColon.startsWith("//")) {
      return afterColon.slice(0, 200);
    }
  }
  return fallbackExtract(trimmed);
}

function fallbackExtract(trimmed: string): string {
  if (trimmed.length <= 200) return trimmed;

  // Try to find a sentence with directive keywords
  const sentences = trimmed
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  for (const s of sentences) {
    if (/\b(always|never|from now on|make sure|remember|prefer|avoid|when|if)\b/i.test(s)) {
      return s.slice(0, 200);
    }
  }
  return trimmed.slice(0, 200);
}

type RunDirectiveExtractOpts = {
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
  let rejected = 0;

  for (const filePath of filePaths) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").split("\n");
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "read-session-file",
        severity: "info",
        subsystem: "directive-extract",
      });
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
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "parse-session-line",
          severity: "info",
          subsystem: "directive-extract",
        });
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

      const precedingAssistant = i > 0 && messages[i - 1].role === "assistant" ? messages[i - 1].text : "";
      const extractedRule = extractRule(userText);
      const candidate = classifyDirectiveCandidate(extractedRule, userText);
      if (!candidate.accepted) {
        rejected++;
        continue;
      }

      incidents.push({
        userMessage: truncate(userText, MAX_USER_MSG),
        categories,
        extractedRule: candidate.sanitizedRule,
        precedingAssistant: truncate(precedingAssistant, MAX_ASSISTANT_MSG),
        confidence,
        timestamp: ts,
        sessionFile: sessionName,
      });
    }
  }

  return { incidents, sessionsScanned: filePaths.length, rejected };
}
