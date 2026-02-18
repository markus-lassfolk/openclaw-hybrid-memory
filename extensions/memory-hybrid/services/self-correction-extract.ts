/**
 * Self-correction extraction (issue #34): scan session JSONL for user messages
 * that look like corrections/nudges, using multi-language correction signals
 * from .language-keywords.json (after openclaw hybrid-mem build-languages).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

export type CorrectionIncident = {
  userMessage: string;
  precedingAssistant: string;
  followingAssistant: string;
  timestamp?: string;
  sessionFile: string;
};

export type SelfCorrectionExtractResult = {
  incidents: CorrectionIncident[];
  sessionsScanned: number;
};

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

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "...";
}

/** Extract timestamp from session filename if it looks like YYYY-MM-DD-*.jsonl. */
function timestampFromFilename(name: string): string | undefined {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

export type RunSelfCorrectionExtractOpts = {
  filePaths: string[];
  correctionRegex: RegExp;
};

/**
 * Scan session JSONL files for user messages matching correction signals.
 * Uses the provided regex (from getCorrectionSignalRegex() after setKeywordsPath)
 * so that all languages from .language-keywords.json are included.
 */
export function runSelfCorrectionExtract(opts: RunSelfCorrectionExtractOpts): SelfCorrectionExtractResult {
  const { filePaths, correctionRegex } = opts;
  const incidents: CorrectionIncident[] = [];

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
      if (!correctionRegex.test(userText)) continue;
      if (shouldSkipUserMessage(userText)) continue;

      const precedingAssistant =
        i > 0 && messages[i - 1].role === "assistant" ? messages[i - 1].text : "";
      const followingAssistant =
        i + 1 < messages.length && messages[i + 1].role === "assistant" ? messages[i + 1].text : "";

      incidents.push({
        userMessage: truncate(userText, MAX_USER_MSG),
        precedingAssistant: truncate(precedingAssistant, MAX_ASSISTANT_MSG),
        followingAssistant: truncate(followingAssistant, MAX_ASSISTANT_MSG),
        timestamp: ts,
        sessionFile: sessionName,
      });
    }
  }

  return { incidents, sessionsScanned: filePaths.length };
}
