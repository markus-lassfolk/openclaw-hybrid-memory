/**
 * Self-correction extraction: scan session JSONL for user messages
 * that look like corrections/nudges, using multi-language correction signals
 * from .language-keywords.json (after openclaw hybrid-mem build-languages).
 */

import { basename } from "node:path";
import { timestampFromFilename, truncate } from "../utils/text.js";
import {
  buildSignalContext,
  parseSessionMessagesSync,
  testSignalRegex,
} from "./session-signal-context.js";

export type CorrectionIncident = {
  userMessage: string;
  precedingAssistant: string;
  followingAssistant: string;
  /** User message that prompted the corrected assistant turn (when available). */
  precedingUserMessage?: string;
  /** Tool calls from assistant turns before the correction (for procedure / recall context). */
  toolCallSequence?: string[];
  /** Memory IDs visible in preceding assistant tool results (when available). */
  recalledMemoryIds?: string[];
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
  /^\s*\{.*"schedule"/m,
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

type RunSelfCorrectionExtractOpts = {
  filePaths: string[];
  correctionRegex: RegExp;
};

/**
 * Scan session JSONL files for user messages matching correction signals.
 */
export function runSelfCorrectionExtract(opts: RunSelfCorrectionExtractOpts): SelfCorrectionExtractResult {
  const { filePaths, correctionRegex } = opts;
  const incidents: CorrectionIncident[] = [];

  for (const filePath of filePaths) {
    const messages = parseSessionMessagesSync(filePath, "self-correction-extract");
    if (messages.length === 0) continue;

    const sessionName = basename(filePath);
    const ts = timestampFromFilename(sessionName);

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "user") continue;
      const userText = messages[i].text;
      if (!testSignalRegex(correctionRegex, userText)) continue;
      if (shouldSkipUserMessage(userText)) continue;

      const ctx = buildSignalContext(messages, i, { lookback: 20 });

      incidents.push({
        userMessage: truncate(userText, MAX_USER_MSG),
        precedingAssistant: truncate(ctx.precedingAssistant, MAX_ASSISTANT_MSG),
        followingAssistant: truncate(ctx.followingAssistant, MAX_ASSISTANT_MSG),
        precedingUserMessage: ctx.precedingUserMessage
          ? truncate(ctx.precedingUserMessage, MAX_ASSISTANT_MSG)
          : undefined,
        toolCallSequence: ctx.toolCallSequence.length > 0 ? ctx.toolCallSequence : undefined,
        recalledMemoryIds: ctx.recalledMemoryIds.length > 0 ? ctx.recalledMemoryIds : undefined,
        timestamp: ts,
        sessionFile: sessionName,
      });
    }
  }

  return { incidents, sessionsScanned: filePaths.length };
}
