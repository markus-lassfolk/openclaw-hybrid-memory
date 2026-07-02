/**
 * Reinforcement extraction: scan session JSONL for user messages
 * that contain positive reinforcement/praise, correlate with agent's preceding response,
 * and identify which memories or actions were being praised.
 * Uses multi-language reinforcement signals from .language-keywords.json.
 */

import { open } from "node:fs/promises";
import { basename } from "node:path";
import { getReinforcementCategoryRegexes } from "../utils/language-keywords.js";
import { timestampFromFilename, truncate } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";
import { buildSignalContext, parseSessionMessagesFromLines, testSignalRegex } from "./session-signal-context.js";

export type ReinforcementIncident = {
  userMessage: string;
  /** What the agent did that was praised. */
  agentBehavior: string;
  /** The user message that preceded the praised agent response (context for LLM analysis). */
  precedingUserMessage: string;
  /** Recalled memory IDs visible in tool calls (if any). */
  recalledMemoryIds: string[];
  /** Phase 2: Tool call sequence from agent's response (for procedure matching). */
  toolCallSequence: string[];
  /** Confidence score 0-1 (how certain this is genuine praise vs polite acknowledgment). */
  confidence: number;
  timestamp?: string;
  sessionFile: string;
};

export type AnnotationReasons = {
  /** Incidents where the agent made no memory_recall calls (no IDs to reinforce) */
  noRecalledIds: number;
  /** Incidents where at least one fact was successfully reinforced */
  reinforced: number;
  /** Incidents had recalled IDs but none could be reinforced (e.g., stale/non-existent IDs) */
  recalledIdsNoMatch: number;
  /** Incidents where annotation threw an error */
  errors: number;
};

/**
 * Semantic status for the case where incidentsFound > 0 && annotated == 0.
 * - `partial_no_matches`: all incidents had no recalled memory IDs — agent did not use
 *   memory_recall in the praised sessions, so no facts could be linked. Benign.
 * - `failed_annotation`: some incidents had recalled IDs but reinforceFact() calls all failed.
 * - `degraded_model_or_parser`: LLM analysis failed or produced unparseable output and
 *   no facts were reinforced.
 */
export type ReinforcementAnnotationStatus = "partial_no_matches" | "failed_annotation" | "degraded_model_or_parser";

export type ReinforcementAnnotationDiagnosticKind =
  | "expected_sparse_data"
  | "missing_recall_metadata"
  | "stale_recalled_ids"
  | "annotation_errors"
  | "model_or_parser_degraded"
  | "mixed_failure";

export type ReinforcementAnnotationDiagnostic = {
  kind: ReinforcementAnnotationDiagnosticKind;
  summary: string;
  recommendedActions: string[];
};

export type ReinforcementExtractResult = {
  incidents: ReinforcementIncident[];
  sessionsScanned: number;
  /** Total number of facts annotated with reinforcement data (set after annotation pass) */
  annotated?: number;
  /** Reason breakdown per incident (set after annotation pass) */
  annotationReasons?: AnnotationReasons;
  /**
   * Semantic status when incidentsFound > 0 && annotated == 0.
   * Undefined when annotated > 0 or incidentsFound == 0.
   */
  annotationStatus?: ReinforcementAnnotationStatus;
  /**
   * Operator-actionable diagnostics for zero-annotation outcomes.
   * Undefined when incidentsFound == 0, annotated > 0, or dry-run.
   */
  annotationDiagnostic?: ReinforcementAnnotationDiagnostic;
  /**
   * True when some but not all LLM analysis batches failed.
   * Set by CLI; used to determine exit code 2.
   */
  partialBatchFailure?: boolean;
  /** Maintenance JobRun id when JobRun framework is active (#1877). */
  jobRunId?: string;
  semanticOutcome?: string;
  /**
   * Names of session files that exceeded MAX_JSONL_BYTES_PER_RUN and were read from the tail
   * only (oldest content in the file was not scanned this run). Unlike passive-observer, this
   * extractor has no byte-offset resume cursor — a session file above the cap will hit this same
   * truncation on every future run, so callers should surface this rather than let it pass silently.
   */
  truncatedSessions?: string[];
  /** Count of session files that failed to read, or lines that failed to parse, this run. */
  failures?: number;
};

/** Hard cap on bytes read per file per run to avoid unbounded JSONL reads (matches passive observer). */
const MAX_JSONL_BYTES_PER_RUN = 2_000_000;

const MAX_USER_MSG = 800;
const MAX_AGENT_BEHAVIOR = 1200;
const MAX_PRECEDING_USER_MSG = 500;

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

type RunReinforcementExtractOpts = {
  filePaths: string[];
  reinforcementRegex: RegExp;
};

/**
 * Scan session JSONL files for user messages matching reinforcement signals.
 * Correlates with preceding agent response to identify what was being praised.
 * Uses the provided regex (from getReinforcementSignalRegex() after setKeywordsPath)
 * so that all languages from .language-keywords.json are included.
 *
 * Reads files asynchronously with a 2MB byte cap per file to avoid blocking the
 * event loop and prevent OOM on large session files (matching passive observer pattern).
 *
 * Unlike passive-observer, this extractor has no persistent byte-offset resume cursor (the
 * caller's scan cursor operates at the whole-session-file level, via mtime watermarking) — so a
 * session file above the cap would, if always read from byte 0, have its post-cap content
 * silently and *permanently* unreachable across every future run. Instead, a file above the cap
 * is read from its tail (the most recent MAX_JSONL_BYTES_PER_RUN bytes), and its name is recorded
 * in the returned `truncatedSessions` so callers can surface that older content was skipped.
 */
export async function runReinforcementExtract(opts: RunReinforcementExtractOpts): Promise<ReinforcementExtractResult> {
  const { filePaths, reinforcementRegex } = opts;
  const incidents: ReinforcementIncident[] = [];
  const truncatedSessions: string[] = [];
  let failures = 0;

  for (const filePath of filePaths) {
    let lines: string[];
    try {
      const handle = await open(filePath, "r");
      let rawBuf: Buffer;
      let fileBytelen: number;
      let readFromTail = false;
      try {
        const stats = await handle.stat();
        fileBytelen = stats.size;
        const length = Math.min(fileBytelen, MAX_JSONL_BYTES_PER_RUN);
        if (length <= 0) {
          continue;
        }
        readFromTail = fileBytelen > MAX_JSONL_BYTES_PER_RUN;
        const startOffset = readFromTail ? fileBytelen - MAX_JSONL_BYTES_PER_RUN : 0;
        rawBuf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(rawBuf, 0, length, startOffset);
        if (bytesRead < length) {
          rawBuf = rawBuf.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
      if (readFromTail) {
        // The read started mid-file, so the first line is very likely a partial JSONL record —
        // drop everything up to and including the first newline.
        const firstNewlineIdx = rawBuf.indexOf(0x0a);
        rawBuf = firstNewlineIdx === -1 ? rawBuf.subarray(0, 0) : rawBuf.subarray(firstNewlineIdx + 1);
        truncatedSessions.push(basename(filePath));
      } else if (rawBuf.length >= MAX_JSONL_BYTES_PER_RUN && rawBuf.length < fileBytelen) {
        // Race: the file grew past the cap between stat() and read() completing. The read
        // still started at byte 0 here, so trim to the last complete newline as before.
        const lastNewlineIdx = rawBuf.lastIndexOf(0x0a);
        if (lastNewlineIdx !== -1) {
          rawBuf = rawBuf.subarray(0, lastNewlineIdx + 1);
        }
      }
      lines = rawBuf.toString("utf-8").split("\n");
    } catch (err) {
      failures++;
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "read-session-file",
        severity: "info",
        subsystem: "reinforcement-extract",
      });
      continue;
    }

    const messages = parseSessionMessagesFromLines(lines, "reinforcement-extract", () => {
      failures++;
    });

    const sessionName = basename(filePath);
    const ts = timestampFromFilename(sessionName);

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "user") continue;
      const userText = messages[i].text;
      if (!testSignalRegex(reinforcementRegex, userText)) continue;
      if (shouldSkipUserMessage(userText)) continue;

      const ctx = buildSignalContext(messages, i, { lookback: 20 });
      const precedingAssistant = ctx.precedingAssistant;

      if (!precedingAssistant || precedingAssistant.length < 20) continue;

      const confidence = calculateReinforcementConfidence(userText, precedingAssistant);
      if (confidence < 0.4) continue; // Filter out low-confidence noise

      incidents.push({
        userMessage: truncate(userText, MAX_USER_MSG),
        agentBehavior: truncate(precedingAssistant, MAX_AGENT_BEHAVIOR),
        precedingUserMessage: ctx.precedingUserMessage
          ? truncate(ctx.precedingUserMessage, MAX_PRECEDING_USER_MSG)
          : "",
        recalledMemoryIds: ctx.recalledMemoryIds.length > 0 ? ctx.recalledMemoryIds : [],
        toolCallSequence: ctx.toolCallSequence.length > 0 ? ctx.toolCallSequence : [],
        confidence,
        timestamp: ts,
        sessionFile: sessionName,
      });
    }
  }

  return {
    incidents,
    sessionsScanned: filePaths.length,
    ...(truncatedSessions.length > 0 ? { truncatedSessions } : {}),
    ...(failures > 0 ? { failures } : {}),
  };
}
