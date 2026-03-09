/**
 * Frustration Detector — Real-time sliding-window frustration detection from conversation signals.
 * Issue #263 — Phase 1.
 *
 * Algorithm:
 *   frustrationLevel = Σ(signal.weight × recency_factor) / normalizer
 *   recency_factor = 1.0 for current turn, decays decayRate^turnsAgo (default 0.9)
 *   normalizer = number of turns in window
 *
 * Supports 9 signal types: short_reply, imperative_tone, repeated_instruction,
 * caps_or_emphasis, explicit_frustration, correction_frequency, question_to_command,
 * reduced_context, emoji_shift
 */

import type { FrustrationDetectionConfig } from "../config/types/features.js";
export type { FrustrationDetectionConfig };

// ---------------------------------------------------------------------------
// Signal type definitions
// ---------------------------------------------------------------------------

export type FrustrationSignalType =
  | "short_reply"
  | "imperative_tone"
  | "repeated_instruction"
  | "caps_or_emphasis"
  | "explicit_frustration"
  | "correction_frequency"
  | "question_to_command"
  | "reduced_context"
  | "emoji_shift";

export interface FrustrationTrigger {
  /** Turn index (0-based within window) at which the signal fired. */
  turn: number;
  /** The signal type that triggered. */
  type: FrustrationSignalType;
  /** Effective weight after any config override. */
  weight: number;
  /** Short text excerpt that triggered the signal. */
  text: string;
}

export interface StyleAdaptation {
  action: "none" | "simplify" | "be_direct" | "acknowledge_struggle" | "ask_clarification";
  reasoning: string;
  priority: number; // 0-3; 0 = no action
}

export interface FrustrationState {
  /** Frustration level 0-1. */
  level: number;
  /** Whether level is rising, falling, or stable vs previous calculation. */
  trend: "rising" | "falling" | "stable";
  /** All signals that contributed to the current level. */
  triggers: FrustrationTrigger[];
  /** How many turns since any signal was last detected (for decay). */
  turnsSinceLastReset: number;
  /** Recommended style adaptation for the agent. */
  suggestedAdaptation: StyleAdaptation;
}

// ---------------------------------------------------------------------------
// Conversation turn structure (shared with implicit-feedback-extract)
// ---------------------------------------------------------------------------

export interface FrustrationConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Default signal weights
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS: Record<FrustrationSignalType, number> = {
  explicit_frustration: 0.9,
  repeated_instruction: 0.8,
  correction_frequency: 0.7,
  caps_or_emphasis: 0.6,
  imperative_tone: 0.5,
  question_to_command: 0.5,
  short_reply: 0.4,
  emoji_shift: 0.3,
  reduced_context: 0.3,
};

// ---------------------------------------------------------------------------
// Keyword lists
// ---------------------------------------------------------------------------

const EXPLICIT_FRUSTRATION_KEYWORDS = [
  "frustrating",
  "annoying",
  "why can't you",
  "i already said",
  "you already",
  "i told you",
  "stop",
  "ugh",
  "ridiculous",
  "useless",
  "doesn't work",
  "still wrong",
  "again!",
  "seriously",
  "wtf",
  "ffs",
];

const POSITIVE_EMOJI_PATTERN = /[\u{1F600}-\u{1F64F}\u{1F44D}\u{2764}\u{1F44F}\u{1F600}😊😀😁😃😄😆😊🙂👍❤️🙌]/u;
const NEGATIVE_EMOJI_PATTERN = /[\u{1F621}\u{1F620}\u{1F92C}\u{1F624}😡😠🤬😤🙄🤦😒😑]/u;

// ---------------------------------------------------------------------------
// Signal detection helpers
// ---------------------------------------------------------------------------

/** Detect explicit frustration keywords in user message. */
function detectExplicitFrustration(text: string): boolean {
  const lower = text.toLowerCase();
  return EXPLICIT_FRUSTRATION_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Detect imperative tone: starts with a verb, <10 words, no polite words. */
function detectImperativeTone(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length >= 10) return false;
  const lower = trimmed.toLowerCase();
  // Must not contain polite softeners
  if (/\b(please|thanks|thank you|could you|would you|can you)\b/i.test(lower)) return false;
  // Common English imperative starters (verbs)
  const imperativeStarters = [
    "show", "get", "tell", "give", "make", "do", "fix", "list", "find", "run",
    "stop", "change", "update", "delete", "remove", "add", "create", "set",
    "explain", "use", "try", "check", "look", "put", "send", "write", "read",
    "open", "close", "go", "restart", "reset", "rebuild", "rewrite", "rerun",
  ];
  const firstWord = words[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return imperativeStarters.includes(firstWord);
}

/** Simple bag-of-words similarity (reused from implicit-feedback logic). */
function simpleWordOverlap(a: string, b: string): number {
  const tokenize = (t: string): Set<string> =>
    new Set(
      t
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const w of setA) {
    if (setB.has(w)) overlap++;
  }
  return (2 * overlap) / (setA.size + setB.size);
}

/** Detect repeated instruction: semantic similarity >0.85 with a message <5 turns ago. */
function detectRepeatedInstruction(
  currentMsg: string,
  previousUserMsgs: Array<{ content: string; turnsAgo: number }>,
  threshold = 0.85,
): boolean {
  for (const prev of previousUserMsgs) {
    if (prev.turnsAgo >= 5) continue;
    if (simpleWordOverlap(currentMsg, prev.content) >= threshold) return true;
  }
  return false;
}

/** Detect correction frequency: >2 correction signals in last 5 turns. */
const CORRECTION_PATTERNS = /\b(no,?\s|not quite|wrong|incorrect|that'?s not|that is not|you missed|again,?\s|still wrong|still not|please fix|try again|that's wrong|nope|not what i)\b/i;

function detectCorrectionFrequency(recentUserMsgs: string[]): boolean {
  let count = 0;
  for (const msg of recentUserMsgs.slice(0, 5)) {
    if (CORRECTION_PATTERNS.test(msg)) count++;
  }
  return count > 2;
}

/** Detect CAPS or emphasis: >30% caps words or >3 bold/exclamation sequences. */
function detectCapsOrEmphasis(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  const capsCount = words.filter((w) => w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  if (capsCount / words.length > 0.3) return true;
  // >3 bold markers or exclamation
  const boldCount = (text.match(/\*\*[^*]+\*\*/g) ?? []).length;
  const exclCount = (text.match(/!/g) ?? []).length;
  return boldCount > 3 || exclCount > 3;
}

/** Detect question-to-command shift: previous messages were questions, current is not. */
function detectQuestionToCommand(currentMsg: string, recentUserMsgs: string[]): boolean {
  if (recentUserMsgs.length === 0) return false;
  const currentIsQuestion = /\?/.test(currentMsg);
  if (currentIsQuestion) return false; // current is still a question
  const currentIsImperative = detectImperativeTone(currentMsg);
  if (!currentIsImperative) return false;
  // Check if at least one of the last 3 messages was a question
  return recentUserMsgs.slice(0, 3).some((m) => /\?/.test(m));
}

/** Detect short reply: length <30% of session average. */
function detectShortReply(currentLen: number, averageLen: number): boolean {
  if (averageLen <= 0) return false;
  return currentLen < averageLen * 0.3;
}

/** Detect emoji shift: positive emoji disappeared, negative appeared. */
function detectEmojiShift(currentMsg: string, recentUserMsgs: string[]): boolean {
  if (recentUserMsgs.length === 0) return false;
  const currentHasNegative = NEGATIVE_EMOJI_PATTERN.test(currentMsg);
  const currentHasPositive = POSITIVE_EMOJI_PATTERN.test(currentMsg);
  if (!currentHasNegative && !currentHasPositive) return false;
  const prevHadPositive = recentUserMsgs.some((m) => POSITIVE_EMOJI_PATTERN.test(m));
  const prevHadNegative = recentUserMsgs.some((m) => NEGATIVE_EMOJI_PATTERN.test(m));
  // Positive disappeared and negative appeared
  if (prevHadPositive && !currentHasPositive && currentHasNegative) return true;
  // Negative appeared where none existed before
  if (!prevHadNegative && currentHasNegative) return true;
  return false;
}

/** Detect reduced context: message is significantly shorter than previous user messages (alternative short detection). */
function detectReducedContext(currentMsg: string, recentUserMsgs: string[]): boolean {
  if (recentUserMsgs.length < 2) return false;
  const avgPrevLen = recentUserMsgs.reduce((s, m) => s + m.length, 0) / recentUserMsgs.length;
  // Reduced context = notably less detail than before (less than 20% of average AND very short)
  return currentMsg.length < avgPrevLen * 0.2 && currentMsg.length < 30;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Analyse a conversation window and return a FrustrationState.
 *
 * @param turns   Conversation turns in chronological order (oldest first).
 * @param cfg     Frustration detection config (optional; uses defaults when absent).
 * @param prevLevel Previous frustration level (for trend calculation and decay).
 */
export function detectFrustration(
  turns: FrustrationConversationTurn[],
  cfg?: FrustrationDetectionConfig,
  prevLevel = 0,
): FrustrationState {
  const windowSize = cfg?.windowSize ?? 8;
  const decayRate = cfg?.decayRate ?? 0.85;
  const weights: Record<FrustrationSignalType, number> = {
    ...DEFAULT_WEIGHTS,
    ...(cfg?.signalWeights ?? {}),
  };

  // Take last N turns
  const window = turns.slice(-windowSize);

  // Extract user turns only (for analysis)
  const userTurns = window.filter((t) => t.role === "user");
  const allUserContents = turns.filter((t) => t.role === "user").map((t) => t.content);

  if (userTurns.length === 0) {
    return buildState(0, [], prevLevel, 0, cfg);
  }

  // Compute average user message length across whole session
  const avgUserLen = allUserContents.reduce((s, c) => s + c.length, 0) / Math.max(1, allUserContents.length);

  // Previous user messages for context (up to last 5)
  const previousUserMsgs = allUserContents.slice(0, -1).reverse(); // reverse so index 0 = most recent previous

  const triggers: FrustrationTrigger[] = [];

  // Analyse each user turn in the window
  for (let i = 0; i < userTurns.length; i++) {
    const turn = userTurns[i]!;
    const turnsAgo = userTurns.length - 1 - i; // 0 = most recent
    const recency = Math.pow(decayRate, turnsAgo);

    // Previous user messages relative to this turn
    const prevUserMsgsForTurn = allUserContents
      .slice(0, allUserContents.indexOf(turn.content))
      .reverse()
      .map((content, idx) => ({ content, turnsAgo: idx + 1 }));

    const recentPrevContents = prevUserMsgsForTurn.slice(0, 5).map((m) => m.content);

    const addTrigger = (type: FrustrationSignalType, text: string) => {
      triggers.push({
        turn: i,
        type,
        weight: weights[type] * recency,
        text: text.slice(0, 120),
      });
    };

    if (detectExplicitFrustration(turn.content)) {
      addTrigger("explicit_frustration", turn.content);
    }

    if (detectImperativeTone(turn.content)) {
      addTrigger("imperative_tone", turn.content);
    }

    if (detectRepeatedInstruction(turn.content, prevUserMsgsForTurn)) {
      addTrigger("repeated_instruction", turn.content);
    }

    if (detectCapsOrEmphasis(turn.content)) {
      addTrigger("caps_or_emphasis", turn.content);
    }

    if (detectCorrectionFrequency([turn.content, ...recentPrevContents])) {
      addTrigger("correction_frequency", turn.content);
    }

    if (detectQuestionToCommand(turn.content, recentPrevContents)) {
      addTrigger("question_to_command", turn.content);
    }

    if (detectShortReply(turn.content.length, avgUserLen)) {
      addTrigger("short_reply", turn.content);
    }

    if (detectEmojiShift(turn.content, recentPrevContents)) {
      addTrigger("emoji_shift", turn.content);
    }

    if (detectReducedContext(turn.content, recentPrevContents)) {
      addTrigger("reduced_context", turn.content);
    }
  }

  // Aggregate: sum of (weight × recency) / normalizer
  const normalizer = Math.max(1, userTurns.length);
  const rawScore = triggers.reduce((s, t) => s + t.weight, 0) / normalizer;

  // Clamp to [0, 1] and apply turn-based decay if no triggers
  const lastTriggerTurn = triggers.length > 0
    ? Math.max(...triggers.map((t) => t.turn))
    : -1;
  const turnsSinceLastReset = lastTriggerTurn >= 0
    ? userTurns.length - 1 - lastTriggerTurn
    : userTurns.length;

  // Apply decay to previous level if no fresh signals
  let level: number;
  if (triggers.length === 0) {
    level = prevLevel * Math.pow(decayRate, turnsSinceLastReset);
  } else {
    // Blend new score with decayed previous (max of the two, with decay dampening)
    const decayed = prevLevel * Math.pow(decayRate, 1);
    level = Math.max(rawScore, decayed * 0.5 + rawScore * 0.5);
  }
  level = Math.min(1, Math.max(0, level));

  return buildState(level, triggers, prevLevel, turnsSinceLastReset, cfg);
}

function buildState(
  level: number,
  triggers: FrustrationTrigger[],
  prevLevel: number,
  turnsSinceLastReset: number,
  cfg?: FrustrationDetectionConfig,
): FrustrationState {
  const mediumThreshold = cfg?.adaptationThresholds?.medium ?? 0.3;
  const highThreshold = cfg?.adaptationThresholds?.high ?? 0.5;
  const criticalThreshold = cfg?.adaptationThresholds?.critical ?? 0.7;

  const trend: "rising" | "falling" | "stable" =
    level > prevLevel + 0.05 ? "rising"
    : level < prevLevel - 0.05 ? "falling"
    : "stable";

  const adaptation = resolveAdaptation(level, mediumThreshold, highThreshold, criticalThreshold, triggers);

  return {
    level,
    trend,
    triggers,
    turnsSinceLastReset,
    suggestedAdaptation: adaptation,
  };
}

function resolveAdaptation(
  level: number,
  medium: number,
  high: number,
  critical: number,
  triggers: FrustrationTrigger[],
): StyleAdaptation {
  if (level >= critical) {
    return {
      action: "acknowledge_struggle",
      reasoning: `Frustration level ${level.toFixed(2)} exceeds critical threshold ${critical}. User likely needs acknowledgment before continuing.`,
      priority: 3,
    };
  }
  if (level >= high) {
    const hasRepeated = triggers.some((t) => t.type === "repeated_instruction" || t.type === "correction_frequency");
    return {
      action: hasRepeated ? "ask_clarification" : "be_direct",
      reasoning: `Frustration level ${level.toFixed(2)} is high. ${hasRepeated ? "Repeated corrections suggest misalignment — clarify intent." : "Use direct, concise language."}`,
      priority: 2,
    };
  }
  if (level >= medium) {
    return {
      action: "simplify",
      reasoning: `Frustration level ${level.toFixed(2)} is moderate. Simplify response structure and reduce verbosity.`,
      priority: 1,
    };
  }
  return {
    action: "none",
    reasoning: `Frustration level ${level.toFixed(2)} is below threshold ${medium}.`,
    priority: 0,
  };
}

// ---------------------------------------------------------------------------
// Hint string generation
// ---------------------------------------------------------------------------

/**
 * Generate a one-line hint string for injection into system context.
 * Returns undefined when level is below the injection threshold.
 */
export function buildFrustrationHint(
  state: FrustrationState,
  cfg?: FrustrationDetectionConfig,
): string | undefined {
  const threshold = cfg?.injectionThreshold ?? 0.3;
  if (state.level < threshold) return undefined;

  const topSignals = [...state.triggers]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((t) => t.type.replace(/_/g, " "))
    .join(", ");

  const trendStr = state.trend !== "stable" ? `/${state.trend}` : "";
  return `[frustration: ${state.level.toFixed(2)}${trendStr} — ${topSignals || "signals detected"}]`;
}

// ---------------------------------------------------------------------------
// Implicit signal export (feeds into #262 implicit feedback pipeline)
// ---------------------------------------------------------------------------

export interface FrustrationAsImplicitSignal {
  type: FrustrationSignalType;
  confidence: number;
  polarity: "negative";
  text: string;
}

/**
 * Export frustration triggers as implicit signal candidates for the #262 pipeline.
 * Only returns signals above the implicit confidence floor (0.3).
 */
export function exportAsImplicitSignals(state: FrustrationState): FrustrationAsImplicitSignal[] {
  if (state.triggers.length === 0) return [];
  // Normalise weights to confidence: max weight is 0.9 → confidence 1.0
  return state.triggers
    .filter((t) => t.weight >= 0.2)
    .map((t) => ({
      type: t.type,
      confidence: Math.min(1, t.weight / 0.9),
      polarity: "negative" as const,
      text: t.text,
    }));
}
