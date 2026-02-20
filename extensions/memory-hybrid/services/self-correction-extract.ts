/**
 * Self-correction extraction: scan session JSONL for user messages
 * that look like corrections/nudges, using multi-language correction signals
 * from .language-keywords.json (after openclaw hybrid-mem build-languages).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { extractMessageText, truncate, timestampFromFilename } from "../utils/text.js";

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
