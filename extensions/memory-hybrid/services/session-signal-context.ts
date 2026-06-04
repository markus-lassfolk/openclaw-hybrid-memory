/**
 * Shared session JSONL parsing and signal context extraction for
 * self-correction and reinforcement pipelines.
 */

import { readFileSync } from "node:fs";
import { extractMessageText } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";
import { normalizeSessionRole } from "./session-v3-parser.js";

export type SessionMessage = {
  role: "user" | "assistant" | "tool";
  text: string;
  content: unknown;
  /** v3 toolResult: tool name (e.g. memory_recall, exec). */
  toolName?: string;
  /** v3 toolResult: links back to assistant toolCall id. */
  toolCallId?: string;
  /** v3 toolResult: structured payload (e.g. details.memories). */
  details?: unknown;
};

export type SignalContext = {
  precedingAssistant: string;
  precedingUserMessage: string;
  followingAssistant: string;
  toolCallSequence: string[];
  recalledMemoryIds: string[];
};

const DEFAULT_LOOKBACK = 20;

/** Reset lastIndex before test (safe for global/sticky regexes). */
export function testSignalRegex(regex: RegExp, text: string): boolean {
  regex.lastIndex = 0;
  return regex.test(text);
}

/**
 * Parse session JSONL lines into role/text/content messages.
 */
export function parseSessionMessagesFromLines(lines: string[], subsystem: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: string; message?: { role?: string; content?: unknown } };
      if (obj.type !== "message" || !obj.message) continue;
      const msg = obj.message;
      const role = normalizeSessionRole(msg.role);
      if (!role) continue;
      messages.push({
        role,
        text: extractMessageText(msg.content),
        content: msg.content,
        toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
        toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
        details: msg.details,
      });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "parse-session-line",
        severity: "info",
        subsystem,
      });
    }
  }
  return messages;
}

export function parseSessionMessagesSync(filePath: string, subsystem: string): SessionMessage[] {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    return parseSessionMessagesFromLines(lines, subsystem);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "read-session-file",
      severity: "info",
      subsystem,
    });
    return [];
  }
}

export function extractRecalledMemoryIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const type = (block as { type?: string }).type;
      if (type === "tool_result" || type === "result") {
        const resultContent = (block as { content?: unknown }).content;
        if (typeof resultContent === "string") {
          const uuidMatches = resultContent.matchAll(
            /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
          );
          for (const match of uuidMatches) {
            ids.push(match[0]);
          }
        }
      }
    }
  }
  return [...new Set(ids)];
}

export function extractToolCallSequence(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const tools: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const type = (block as { type?: string }).type;
      if (type === "tool_use" || type === "toolCall") {
        const name = (block as { name?: string }).name;
        if (typeof name === "string" && name.trim()) {
          tools.push(name.trim());
        }
      }
    }
  }
  return tools;
}

/**
 * Build conversation context around a user message index (looks backward for assistant/tool turns).
 */
export function buildSignalContext(
  messages: SessionMessage[],
  userIndex: number,
  opts?: { lookback?: number },
): SignalContext {
  const lookback = opts?.lookback ?? DEFAULT_LOOKBACK;
  const scanStart = Math.max(0, userIndex - lookback);

  let precedingUserIndex = -1;
  let precedingUserMessage = "";
  for (let j = userIndex - 1; j >= scanStart; j--) {
    if (messages[j].role === "user") {
      precedingUserIndex = j;
      precedingUserMessage = messages[j].text;
      break;
    }
  }

  let precedingAssistant = "";
  const toolCallSequence: string[] = [];
  let recalledMemoryIds: string[] = [];
  const assistantScanStart = precedingUserIndex >= 0 ? precedingUserIndex + 1 : scanStart;

  for (let j = userIndex - 1; j >= assistantScanStart; j--) {
    const m = messages[j];
    if (m.role !== "assistant") continue;
    if (!precedingAssistant) {
      precedingAssistant = m.text;
      recalledMemoryIds = extractRecalledMemoryIds(m.content);
    }
    toolCallSequence.unshift(...extractToolCallSequence(m.content));
  }

  let followingAssistant = "";
  if (userIndex + 1 < messages.length && messages[userIndex + 1].role === "assistant") {
    followingAssistant = messages[userIndex + 1].text;
  }

  return {
    precedingAssistant,
    precedingUserMessage,
    followingAssistant,
    toolCallSequence,
    recalledMemoryIds,
  };
}
