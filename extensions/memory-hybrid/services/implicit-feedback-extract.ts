/**
 * Implicit feedback extraction: analyze conversation turns for behavioral
 * signals that indicate positive or negative user experience without explicit praise/correction.
 * Issue #262 — Phase 1.
 */

import { capturePluginError } from "./error-reporter.js";

export type ImplicitSignalType =
  | "rephrase"
  | "immediate_action"
  | "topic_change"
  | "grateful_close"
  | "self_service"
  | "escalation"
  | "terse_response"
  | "extended_engagement"
  | "copy_paste"
  | "correction_cascade"
  | "silence_after_action";

export interface ImplicitSignal {
  type: ImplicitSignalType;
  confidence: number; // 0-1
  polarity: "positive" | "negative" | "neutral";
  context: {
    userMessage: string; // truncated to 500 chars
    agentMessage: string; // truncated to 500 chars
    precedingTurns: number;
    sessionFile: string;
    timestamp: number;
  };
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
  toolCalls?: string[];
}

export interface ImplicitFeedbackConfig {
  enabled?: boolean; // default: true
  minConfidence?: number; // default: 0.5
  signalTypes?: ImplicitSignalType[]; // default: all
  rephraseThreshold?: number; // default: 0.8
  topicChangeThreshold?: number; // default: 0.3
  terseResponseRatio?: number; // default: 0.4
  feedToReinforcement?: boolean; // default: true
  feedToSelfCorrection?: boolean; // default: true
}

// Common English stop words to exclude from similarity computation
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "need",
  "it", "its", "this", "that", "these", "those", "i", "you", "he", "she",
  "we", "they", "me", "him", "her", "us", "them", "my", "your", "his",
  "our", "their", "what", "which", "who", "how", "when", "where", "why",
  "if", "then", "so", "not", "no", "up", "out", "about", "just", "also",
  "more", "very", "well", "get", "got", "going", "there", "here",
]);

/**
 * Simple bag-of-words cosine similarity.
 * Tokenizes by whitespace, lowercases, removes stop words, computes TF vectors, returns cosine.
 */
export function computeSimpleSimilarity(a: string, b: string): number {
  const tokenize = (text: string): Map<string, number> => {
    const tokens = text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    const freq = new Map<string, number>();
    for (const t of tokens) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    return freq;
  };

  const vecA = tokenize(a);
  const vecB = tokenize(b);

  if (vecA.size === 0 || vecB.size === 0) return 0;

  // Dot product
  let dot = 0;
  for (const [term, countA] of vecA) {
    const countB = vecB.get(term) ?? 0;
    dot += countA * countB;
  }

  // Magnitudes
  let magA = 0;
  for (const v of vecA.values()) magA += v * v;
  let magB = 0;
  for (const v of vecB.values()) magB += v * v;

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Truncate a string to maxLen chars */
function trunc(s: string, maxLen = 500): string {
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** Get user turns from a list of conversation turns */
function userTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.filter((t) => t.role === "user");
}

/** Compute average user message length in a session */
function avgUserMessageLength(turns: ConversationTurn[]): number {
  const msgs = userTurns(turns);
  if (msgs.length === 0) return 0;
  return msgs.reduce((sum, t) => sum + t.content.length, 0) / msgs.length;
}

/**
 * Detect rephrase: user re-asked the same question with different wording.
 * Similarity > rephraseThreshold (0.8) but wording differs > 30%.
 * Polarity: negative (first answer failed).
 */
export function detectRephrase(
  turns: ConversationTurn[],
  config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const threshold = config.rephraseThreshold ?? 0.8;
  if (turnIndex < 2) return null;
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  // Find the previous user message (could be more than 1 turn back due to agent turns)
  let prevUserIdx = -1;
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 4); i--) {
    if (turns[i].role === "user") {
      prevUserIdx = i;
      break;
    }
  }
  if (prevUserIdx < 0) return null;

  const prev = turns[prevUserIdx];
  const sim = computeSimpleSimilarity(current.content, prev.content);

  // High similarity (topic the same) but not identical (wording changed)
  const identical = current.content.trim() === prev.content.trim();
  if (!identical && sim >= threshold) {
    // Find most recent agent message for context
    let agentMsg = "";
    for (let i = turnIndex - 1; i >= 0; i--) {
      if (turns[i].role === "assistant") {
        agentMsg = turns[i].content;
        break;
      }
    }
    return {
      type: "rephrase",
      confidence: 0.6 + (sim - threshold) * 2, // scales 0.6-0.8
      polarity: "negative",
      context: {
        userMessage: trunc(current.content),
        agentMessage: trunc(agentMsg),
        precedingTurns: turnIndex,
        sessionFile: "",
        timestamp: current.timestamp ?? Date.now(),
      },
    };
  }
  return null;
}

/**
 * Detect immediate action: user's next message after agent suggestion contains
 * action words indicating they acted on the suggestion.
 * Polarity: positive.
 */
export function detectImmediateAction(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  // Find preceding agent message
  let agentIdx = -1;
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
    if (turns[i].role === "assistant") {
      agentIdx = i;
      break;
    }
  }
  if (agentIdx < 0) return null;

  const ACTION_WORDS = /\b(done|worked|working|running|deployed|fixed|installed|completed|success|succeeded|ran|built|created|started|launched|got it working|it works|solved|resolved)\b/i;
  if (ACTION_WORDS.test(current.content)) {
    return {
      type: "immediate_action",
      confidence: 0.7,
      polarity: "positive",
      context: {
        userMessage: trunc(current.content),
        agentMessage: trunc(turns[agentIdx].content),
        precedingTurns: turnIndex,
        sessionFile: "",
        timestamp: current.timestamp ?? Date.now(),
      },
    };
  }
  return null;
}

/**
 * Detect topic change: semantic similarity < topicChangeThreshold between
 * agent's response and user's next message.
 * Polarity: negative (user moved on because agent's output wasn't useful).
 */
export function detectTopicChange(
  turns: ConversationTurn[],
  config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const threshold = config.topicChangeThreshold ?? 0.3;
  const current = turns[turnIndex];
  if (current.role !== "user") return null;
  if (current.content.length < 10) return null;

  // Find preceding agent message
  let agentMsg = "";
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
    if (turns[i].role === "assistant") {
      agentMsg = turns[i].content;
      break;
    }
  }
  if (!agentMsg || agentMsg.length < 10) return null;

  const sim = computeSimpleSimilarity(agentMsg, current.content);
  if (sim < threshold) {
    // Check it's not just a very short message or grateful_close (those have their own detector)
    const GRATEFUL = /\b(thanks|thank you|cheers|perfect|great|awesome|got it|got it!)\b/i;
    if (GRATEFUL.test(current.content.trim()) && current.content.length < 50) return null;

    return {
      type: "topic_change",
      confidence: 0.4 + (threshold - sim) * 0.5, // scales 0.4-0.55
      polarity: "negative",
      context: {
        userMessage: trunc(current.content),
        agentMessage: trunc(agentMsg),
        precedingTurns: turnIndex,
        sessionFile: "",
        timestamp: current.timestamp ?? Date.now(),
      },
    };
  }
  return null;
}

/**
 * Detect grateful close: user thanks the agent, possibly followed by topic change.
 * Polarity: positive.
 */
export function detectGratefulClose(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  const GRATEFUL = /\b(thanks|thank you|cheers|perfect|great|awesome|brilliant|excellent|wonderful|magnificent)\b/i;
  if (!GRATEFUL.test(current.content)) return null;

  // Find preceding agent message
  let agentMsg = "";
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
    if (turns[i].role === "assistant") {
      agentMsg = turns[i].content;
      break;
    }
  }

  return {
    type: "grateful_close",
    confidence: 0.8,
    polarity: "positive",
    context: {
      userMessage: trunc(current.content),
      agentMessage: trunc(agentMsg),
      precedingTurns: turnIndex,
      sessionFile: "",
      timestamp: current.timestamp ?? Date.now(),
    },
  };
}

/**
 * Detect terse response: user message length drops > 60% vs session average.
 * Polarity: negative (frustration building).
 */
export function detectTerseResponse(
  turns: ConversationTurn[],
  config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const ratio = config.terseResponseRatio ?? 0.4; // below this fraction of average = terse
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  // Need at least 3 user turns before to have a meaningful average
  const prevUserTurns = turns.slice(0, turnIndex).filter((t) => t.role === "user");
  if (prevUserTurns.length < 3) return null;

  const avg = prevUserTurns.reduce((sum, t) => sum + t.content.length, 0) / prevUserTurns.length;
  if (avg < 20) return null; // average too short to be meaningful

  const currentLen = current.content.length;
  if (currentLen < avg * ratio) {
    let agentMsg = "";
    for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
      if (turns[i].role === "assistant") {
        agentMsg = turns[i].content;
        break;
      }
    }
    return {
      type: "terse_response",
      confidence: 0.5,
      polarity: "negative",
      context: {
        userMessage: trunc(current.content),
        agentMessage: trunc(agentMsg),
        precedingTurns: turnIndex,
        sessionFile: "",
        timestamp: current.timestamp ?? Date.now(),
      },
    };
  }
  return null;
}

/**
 * Detect extended engagement: 3+ follow-up questions on same topic (keyword overlap > 0.5).
 * Polarity: positive.
 */
export function detectExtendedEngagement(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  // Look back at last 8 turns to find follow-up questions on same topic
  const window = turns.slice(Math.max(0, turnIndex - 8), turnIndex);
  const userMsgs = window.filter((t) => t.role === "user");
  if (userMsgs.length < 3) return null;

  // Count messages with high similarity to current
  let relatedCount = 0;
  for (const msg of userMsgs) {
    if (computeSimpleSimilarity(current.content, msg.content) > 0.5) {
      relatedCount++;
    }
  }

  if (relatedCount >= 2) {
    let agentMsg = "";
    for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
      if (turns[i].role === "assistant") {
        agentMsg = turns[i].content;
        break;
      }
    }
    return {
      type: "extended_engagement",
      confidence: 0.7,
      polarity: "positive",
      context: {
        userMessage: trunc(current.content),
        agentMessage: trunc(agentMsg),
        precedingTurns: turnIndex,
        sessionFile: "",
        timestamp: current.timestamp ?? Date.now(),
      },
    };
  }
  return null;
}

/**
 * Detect correction cascade: 2+ correction patterns within 5 turns.
 * Polarity: negative.
 */
export function detectCorrectionCascade(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  const CORRECTION_RE = /\b(no|nope|wrong|incorrect|not what i (said|meant|asked)|that'?s not|i said|not right|you misunderstood|not quite)\b/i;

  // Count corrections in the last 5 turns
  const window = turns.slice(Math.max(0, turnIndex - 4), turnIndex + 1);
  const correctionMsgs = window.filter((t) => t.role === "user" && CORRECTION_RE.test(t.content));

  if (correctionMsgs.length >= 2) {
    let agentMsg = "";
    for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
      if (turns[i].role === "assistant") {
        agentMsg = turns[i].content;
        break;
      }
    }
    return {
      type: "correction_cascade",
      confidence: 0.9,
      polarity: "negative",
      context: {
        userMessage: trunc(current.content),
        agentMessage: trunc(agentMsg),
        precedingTurns: turnIndex,
        sessionFile: "",
        timestamp: current.timestamp ?? Date.now(),
      },
    };
  }
  return null;
}

/**
 * Detect copy paste: user's subsequent message contains > 80% of agent's output text.
 * Polarity: positive.
 */
export function detectCopyPaste(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "user") return null;
  if (current.content.length < 50) return null;

  // Find preceding agent message
  let agentMsg = "";
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
    if (turns[i].role === "assistant") {
      agentMsg = turns[i].content;
      break;
    }
  }
  if (!agentMsg || agentMsg.length < 50) return null;

  // Simple check: compute overlap of words
  const sim = computeSimpleSimilarity(current.content, agentMsg);
  if (sim > 0.8) {
    return {
      type: "copy_paste",
      confidence: 0.6,
      polarity: "positive",
      context: {
        userMessage: trunc(current.content),
        agentMessage: trunc(agentMsg),
        precedingTurns: turnIndex,
        sessionFile: "",
        timestamp: current.timestamp ?? Date.now(),
      },
    };
  }
  return null;
}

/**
 * Detect self-service: after agent offers to help, user says they'll do it themselves.
 * Polarity: negative.
 */
export function detectSelfService(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  const SELF_SERVICE_RE = /\b(i'?ll (do|handle|take care of|fix|try) it (myself|myself)?|never mind|never mind|forget it|i got it|i will do it|don'?t (bother|worry)|i'?ll figure it out|i can do it)\b/i;
  if (!SELF_SERVICE_RE.test(current.content)) return null;

  let agentMsg = "";
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
    if (turns[i].role === "assistant") {
      agentMsg = turns[i].content;
      break;
    }
  }

  return {
    type: "self_service",
    confidence: 0.6,
    polarity: "negative",
    context: {
      userMessage: trunc(current.content),
      agentMessage: trunc(agentMsg),
      precedingTurns: turnIndex,
      sessionFile: "",
      timestamp: current.timestamp ?? Date.now(),
    },
  };
}

/**
 * Detect escalation: user mentions asking someone else or another source.
 * Polarity: negative.
 */
export function detectEscalation(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "user") return null;

  const ESCALATION_RE = /\b(i'?ll ask (someone|my|the|a)|going to ask|ask (my colleague|my boss|a human|the team|gpt|chatgpt|another|someone else)|i'?ll check with|let me ask|i asked|asked (someone|my|the|a))\b/i;
  if (!ESCALATION_RE.test(current.content)) return null;

  let agentMsg = "";
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 3); i--) {
    if (turns[i].role === "assistant") {
      agentMsg = turns[i].content;
      break;
    }
  }

  return {
    type: "escalation",
    confidence: 0.5,
    polarity: "negative",
    context: {
      userMessage: trunc(current.content),
      agentMessage: trunc(agentMsg),
      precedingTurns: turnIndex,
      sessionFile: "",
      timestamp: current.timestamp ?? Date.now(),
    },
  };
}

/**
 * Detect silence after action: agent performed a tool call, user didn't acknowledge.
 * This fires on the *next* agent turn if it exists and follows without user acknowledgment.
 * Polarity: negative (weak).
 */
export function detectSilenceAfterAction(
  turns: ConversationTurn[],
  _config: ImplicitFeedbackConfig,
  turnIndex: number,
): ImplicitSignal | null {
  const current = turns[turnIndex];
  if (current.role !== "assistant") return null;

  // Check if previous agent turn had tool calls
  let prevAgentWithToolsIdx = -1;
  let prevUserIdx = -1;
  for (let i = turnIndex - 1; i >= Math.max(0, turnIndex - 6); i--) {
    if (turns[i].role === "assistant" && (turns[i].toolCalls?.length ?? 0) > 0) {
      prevAgentWithToolsIdx = i;
      break;
    }
    if (turns[i].role === "user") {
      prevUserIdx = i;
    }
  }

  // If there was an agent turn with tools before the last user turn, and the user's
  // reply was very short (< 20 chars) or absent
  if (prevAgentWithToolsIdx < 0) return null;

  // Check if user acknowledged — look for any user turn between prevAgentWithToolsIdx and turnIndex
  const intervening = turns.slice(prevAgentWithToolsIdx + 1, turnIndex);
  const userAcknowledged = intervening.some((t) => t.role === "user" && t.content.length > 5);
  if (userAcknowledged) return null;

  const agentMsg = turns[prevAgentWithToolsIdx].content;
  return {
    type: "silence_after_action",
    confidence: 0.3,
    polarity: "negative",
    context: {
      userMessage: prevUserIdx >= 0 ? trunc(turns[prevUserIdx].content) : "",
      agentMessage: trunc(agentMsg),
      precedingTurns: turnIndex,
      sessionFile: "",
      timestamp: current.timestamp ?? Date.now(),
    },
  };
}

const ALL_SIGNAL_TYPES: ImplicitSignalType[] = [
  "rephrase",
  "immediate_action",
  "topic_change",
  "grateful_close",
  "self_service",
  "escalation",
  "terse_response",
  "extended_engagement",
  "copy_paste",
  "correction_cascade",
  "silence_after_action",
];

/**
 * Extract all implicit signals from a conversation turn sequence.
 */
export function extractImplicitSignals(
  turns: ConversationTurn[],
  config: ImplicitFeedbackConfig,
  sessionFile = "",
): ImplicitSignal[] {
  if (config.enabled === false) return [];

  const minConfidence = config.minConfidence ?? 0.5;
  const enabledTypes = new Set<string>(config.signalTypes ?? ALL_SIGNAL_TYPES);

  const results: ImplicitSignal[] = [];

  // Track which (turnIndex, signalType) pairs we've already emitted to avoid duplicates
  const emitted = new Set<string>();

  const tryAdd = (signal: ImplicitSignal | null, turnIndex: number) => {
    if (!signal) return;
    if (!enabledTypes.has(signal.type)) return;
    if (signal.confidence < minConfidence) return;
    const key = `${turnIndex}:${signal.type}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    // Attach session file
    results.push({
      ...signal,
      context: { ...signal.context, sessionFile },
    });
  };

  try {
    for (let i = 0; i < turns.length; i++) {
      if (enabledTypes.has("rephrase")) tryAdd(detectRephrase(turns, config, i), i);
      if (enabledTypes.has("immediate_action")) tryAdd(detectImmediateAction(turns, config, i), i);
      if (enabledTypes.has("topic_change")) tryAdd(detectTopicChange(turns, config, i), i);
      if (enabledTypes.has("grateful_close")) tryAdd(detectGratefulClose(turns, config, i), i);
      if (enabledTypes.has("terse_response")) tryAdd(detectTerseResponse(turns, config, i), i);
      if (enabledTypes.has("extended_engagement")) tryAdd(detectExtendedEngagement(turns, config, i), i);
      if (enabledTypes.has("correction_cascade")) tryAdd(detectCorrectionCascade(turns, config, i), i);
      if (enabledTypes.has("copy_paste")) tryAdd(detectCopyPaste(turns, config, i), i);
      if (enabledTypes.has("self_service")) tryAdd(detectSelfService(turns, config, i), i);
      if (enabledTypes.has("escalation")) tryAdd(detectEscalation(turns, config, i), i);
      if (enabledTypes.has("silence_after_action")) tryAdd(detectSilenceAfterAction(turns, config, i), i);
    }
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "extractImplicitSignals",
      severity: "warning",
      subsystem: "implicit-feedback-extract",
    });
  }

  return results;
}

/**
 * Parse a session JSONL file into ConversationTurns.
 */
export function parseSessionTurns(lines: string[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (obj.type !== "message" || !obj.message) continue;
      const role = obj.message.role;
      if (role !== "user" && role !== "assistant") continue;

      // Extract text content
      const content = obj.message.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object") {
            const b = block as { type?: string; text?: string; name?: string };
            if (b.type === "text" && typeof b.text === "string") {
              text += (text ? " " : "") + b.text;
            }
          }
        }
      }

      // Extract tool calls if assistant
      const toolCalls: string[] = [];
      if (role === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object") {
            const b = block as { type?: string; name?: string };
            if (b.type === "tool_use" && typeof b.name === "string") {
              toolCalls.push(b.name);
            }
          }
        }
      }

      turns.push({ role, content: text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
    } catch {
      // skip malformed lines
    }
  }
  return turns;
}
