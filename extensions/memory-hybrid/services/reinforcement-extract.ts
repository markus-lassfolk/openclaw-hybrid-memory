/**
 * Reinforcement extraction (issue #40): scan session JSONL for user messages
 * that contain positive reinforcement/praise, correlate with agent's preceding response,
 * and identify which memories or actions were being praised.
 * Uses multi-language reinforcement signals from .language-keywords.json.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getReinforcementCategoryRegexes } from "../utils/language-keywords.js";
import { extractMessageText, truncate, timestampFromFilename } from "../utils/text.js";

export type ReinforcementIncident = {
  userMessage: string;
  /** What the agent did that was praised. */
  agentBehavior: string;
  /** Recalled memory IDs visible in tool calls (if any). */
  recalledMemoryIds: string[];
  /** Phase 2: Tool call sequence from agent's response (for procedure matching). */
  toolCallSequence: string[];
  /** Confidence score 0-1 (how certain this is genuine praise vs polite acknowledgment). */
  confidence: number;
  timestamp?: string;
  sessionFile: string;
};

export type ReinforcementExtractResult = {
  incidents: ReinforcementIncident[];
  sessionsScanned: number;
};

const MAX_USER_MSG = 300;
const MAX_AGENT_BEHAVIOR = 600;

/** Patterns that indicate a user message should be skipped. */
const SKIP_PATTERNS = [
  /heartbeat/i,
  /cron\s+job|cronjob/i,
  /compact|pre-compaction/i,
  /sub-?agent|subagent\s+announce/i,
  /NO_REPLY/i,
];

function shouldSkipUserMessage(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  for (const re of SKIP_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

/**
 * Extract memory_recall tool calls from assistant message content to identify which memories were used.
 */
function extractRecalledMemoryIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const type = (block as { type?: string }).type;
      if (type === "tool_result" || type === "result") {
        // Look for memory IDs in tool result content
        const resultContent = (block as { content?: unknown }).content;
        if (typeof resultContent === "string") {
          // Match UUIDs (memory IDs)
          const uuidMatches = resultContent.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
          for (const match of uuidMatches) {
            ids.push(match[0]);
          }
        }
      }
    }
  }
  return [...new Set(ids)]; // dedupe
}

/**
 * Phase 2: Extract tool call sequence from assistant message content (for procedure matching).
 * Returns array of tool names in order (e.g. ["memory_recall", "exec", "write"]).
 */
function extractToolCallSequence(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const tools: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const type = (block as { type?: string }).type;
      if (type === "tool_use") {
        const name = (block as { name?: string }).name;
        if (typeof name === "string" && name.trim()) {
          tools.push(name.trim());
        }
      }
    }
  }
  return tools;
}


let reinforcementRegexCache: {
  strongPraise: RegExp;
  methodConfirmation: RegExp;
  relief: RegExp;
  comparativePraise: RegExp;
  sharingSignals: RegExp;
  genericPoliteness: RegExp;
} | null = null;

/**
 * Clear the reinforcement regex cache (e.g., after keyword rebuild).
 */
export function clearReinforcementRegexCache(): void {
  reinforcementRegexCache = null;
}

/**
 * Calculate confidence for reinforcement detection.
 * High confidence: explicit praise words + substantial agent response
 * Low confidence: generic "thanks" or very short agent response
 * Now uses multilingual keywords from language-keywords.ts.
 */
function calculateReinforcementConfidence(userText: string, agentText: string): number {
  if (!reinforcementRegexCache) {
    const regexes = getReinforcementCategoryRegexes();
    reinforcementRegexCache = {
      strongPraise: regexes.strongPraise,
      methodConfirmation: regexes.methodConfirmation,
      relief: regexes.relief,
      comparativePraise: regexes.comparativePraise,
      sharingSignals: regexes.sharingSignals,
      genericPoliteness: regexes.genericPoliteness,
    };
  }

  const regexes = reinforcementRegexCache;
  let confidence = 0.5;

  // Explicit praise words boost confidence
  if (regexes.strongPraise.test(userText)) confidence = 0.8;

  // Method confirmation
  if (regexes.methodConfirmation.test(userText)) confidence = Math.max(confidence, 0.75);

  // Relief/finally
  if (regexes.relief.test(userText)) confidence = Math.max(confidence, 0.8);

  // Comparative praise
  if (regexes.comparativePraise.test(userText)) confidence = Math.max(confidence, 0.75);

  // Sharing signals (strong indicator of genuine value)
  if (regexes.sharingSignals.test(userText)) confidence = Math.max(confidence, 0.85);

  // Reduce confidence for generic politeness
  if (regexes.genericPoliteness.test(userText.trim())) confidence *= 0.5;

  // Reduce confidence if agent response is very short (< 25 chars) — might be a simple acknowledgment
  if (agentText.length < 25) confidence *= 0.7;

  // Boost confidence if agent response is substantial (> 200 chars)
  if (agentText.length > 200) confidence = Math.min(1.0, confidence + 0.1);

  return Math.max(0, Math.min(1.0, confidence));
}

export type RunReinforcementExtractOpts = {
  filePaths: string[];
  reinforcementRegex: RegExp;
};

/**
 * Scan session JSONL files for user messages matching reinforcement signals.
 * Correlates with preceding agent response to identify what was being praised.
 * Uses the provided regex (from getReinforcementSignalRegex() after setKeywordsPath)
 * so that all languages from .language-keywords.json are included.
 */
export function runReinforcementExtract(opts: RunReinforcementExtractOpts): ReinforcementExtractResult {
  const { filePaths, reinforcementRegex } = opts;
  const incidents: ReinforcementIncident[] = [];

  for (const filePath of filePaths) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").split("\n");
    } catch {
      continue;
    }

    const messages: Array<{ role: string; text: string; content: unknown }> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { type?: string; message?: { role?: string; content?: unknown } };
        if (obj.type !== "message" || !obj.message) continue;
        const msg = obj.message;
        const role = msg.role === "user" || msg.role === "assistant" || msg.role === "tool" ? msg.role : null;
        if (!role) continue;
        const text = extractMessageText(msg.content);
        messages.push({ role, text, content: msg.content });
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
      reinforcementRegex.lastIndex = 0;
      if (!reinforcementRegex.test(userText)) continue;
      if (shouldSkipUserMessage(userText)) continue;

      // Look back for the most recent assistant message (expanded window to handle tool messages)
      let precedingAssistant = "";
      let recalledMemoryIds: string[] = [];
      let toolCallSequence: string[] = [];
      for (let j = i - 1; j >= 0 && j >= Math.max(0, i - 20); j--) {
        if (messages[j].role === "assistant") {
          precedingAssistant = messages[j].text;
          recalledMemoryIds = extractRecalledMemoryIds(messages[j].content);
          toolCallSequence = extractToolCallSequence(messages[j].content);
          break;
        }
      }

      if (!precedingAssistant || precedingAssistant.length < 20) continue; // No substantial agent behavior to reinforce

      const confidence = calculateReinforcementConfidence(userText, precedingAssistant);
      if (confidence < 0.4) continue; // Filter out low-confidence noise

      incidents.push({
        userMessage: truncate(userText, MAX_USER_MSG),
        agentBehavior: truncate(precedingAssistant, MAX_AGENT_BEHAVIOR),
        recalledMemoryIds,
        toolCallSequence,
        confidence,
        timestamp: ts,
        sessionFile: sessionName,
      });
    }
  }

  return { incidents, sessionsScanned: filePaths.length };
}
