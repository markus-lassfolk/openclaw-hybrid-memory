/**
 * Trajectory learning: detect and analyze multi-turn task sequences,
 * classify outcomes, find pivot points, and extract heuristic lessons.
 * Issue #262 — Phase 2.
 */

import { randomUUID } from "node:crypto";
import { capturePluginError } from "./error-reporter.js";
import { computeSimpleSimilarity } from "./implicit-feedback-extract.js";
import type { ConversationTurn } from "./implicit-feedback-extract.js";

export interface TrajectoryTurn {
  role: "user" | "assistant";
  summary: string; // first 200 chars
  sentiment: "positive" | "negative" | "neutral";
  wasCorrection: boolean;
  wasRephrase: boolean;
  toolsUsed?: string[];
}

export interface FeedbackTrajectory {
  id: string;
  sessionFile: string;
  turns: TrajectoryTurn[];
  outcome: "success" | "partial" | "failure";
  outcomeSignal: string;
  keyPivot?: number;
  lessonsExtracted: string[];
  topic: string;
  toolsUsed: string[];
  turnCount: number;
}

export interface TrajectoryBoundary {
  startIndex: number;
  endIndex: number;
}

// Patterns indicating positive sentiment in user messages
const POSITIVE_RE = /\b(thanks|thank you|cheers|perfect|great|awesome|brilliant|excellent|wonderful|worked|done|fixed|solved|got it|success|that'?s it|exactly|correct|yes|nice|good)\b/i;
// Patterns indicating correction
const CORRECTION_RE = /\b(no|nope|wrong|incorrect|not what i (said|meant|asked)|that'?s not|i said|not right|you misunderstood|not quite|wait|actually|hmm|but)\b/i;

/**
 * Classify sentiment of a user message.
 */
function classifySentiment(content: string): "positive" | "negative" | "neutral" {
  if (POSITIVE_RE.test(content)) return "positive";
  if (CORRECTION_RE.test(content)) return "negative";
  return "neutral";
}

/**
 * Detect boundaries of multi-turn task sequences.
 * Start: user message that leads to agent action (tool call or substantial response).
 * End: topic change, grateful_close, or 3+ turns gap.
 */
export function detectTrajectoryBoundaries(turns: ConversationTurn[]): TrajectoryBoundary[] {
  const boundaries: TrajectoryBoundary[] = [];
  if (turns.length < 3) return boundaries;

  let trajectoryStart = -1;
  let lastTopicContent = "";

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];

    if (turn.role === "user") {
      if (trajectoryStart < 0) {
        // A user message starting a potential trajectory
        if (turn.content.length > 20) {
          trajectoryStart = i;
          lastTopicContent = turn.content;
        }
        continue;
      }

      // Check if topic changed significantly
      const sim = computeSimpleSimilarity(turn.content, lastTopicContent);
      const isGrateful = /\b(thanks|thank you|cheers|perfect|great|awesome)\b/i.test(turn.content) && turn.content.length < 60;

      if (isGrateful || sim < 0.2) {
        // End current trajectory (include this turn)
        if (i - trajectoryStart >= 2) {
          boundaries.push({ startIndex: trajectoryStart, endIndex: i });
        }
        // Start new trajectory on next substantial message
        trajectoryStart = -1;
        lastTopicContent = "";
      } else {
        // Update last topic (rolling average of similarity)
        if (sim > 0.3) lastTopicContent = turn.content;
      }
    }
  }

  // Close any open trajectory at the end
  if (trajectoryStart >= 0 && turns.length - trajectoryStart >= 3) {
    boundaries.push({ startIndex: trajectoryStart, endIndex: turns.length - 1 });
  }

  return boundaries;
}

/**
 * Build TrajectoryTurn array from raw ConversationTurns in a boundary.
 */
function buildTrajectoryTurns(
  turns: ConversationTurn[],
  boundary: TrajectoryBoundary,
): TrajectoryTurn[] {
  const slice = turns.slice(boundary.startIndex, boundary.endIndex + 1);
  return slice.map((t, idx) => {
    const wasCorrection = t.role === "user" && CORRECTION_RE.test(t.content);
    // Rephrase: high similarity to previous user message but not identical
    let wasRephrase = false;
    if (t.role === "user" && idx > 0) {
      const prevUser = slice.slice(0, idx).reverse().find((x) => x.role === "user");
      if (prevUser) {
        const sim = computeSimpleSimilarity(t.content, prevUser.content);
        wasRephrase = sim > 0.6 && t.content.trim() !== prevUser.content.trim();
      }
    }
    return {
      role: t.role,
      summary: t.content.slice(0, 200),
      sentiment: t.role === "user" ? classifySentiment(t.content) : "neutral",
      wasCorrection,
      wasRephrase,
      toolsUsed: t.toolCalls,
    };
  });
}

/**
 * Classify a trajectory's outcome and find the pivot point.
 */
export function classifyTrajectoryOutcome(trajectoryTurns: TrajectoryTurn[]): {
  outcome: "success" | "partial" | "failure";
  signal: string;
  keyPivot?: number;
} {
  const userTurns = trajectoryTurns.filter((t) => t.role === "user");
  if (userTurns.length === 0) {
    return { outcome: "failure", signal: "no_user_turns" };
  }

  const lastUserTurn = userTurns[userTurns.length - 1];
  const hasCorrections = trajectoryTurns.some((t) => t.wasCorrection);
  const hasRephrases = trajectoryTurns.some((t) => t.wasRephrase);

  // Detect self-service / escalation (negative)
  const SELF_SERVICE_RE = /\b(i'?ll (do|handle|fix) it (myself)?|never mind|forget it|i'?ll figure it out)\b/i;
  const ESCALATION_RE = /\b(i'?ll ask (someone|my|the|a)|going to ask|ask (someone else|my colleague|gpt|chatgpt))\b/i;

  if (SELF_SERVICE_RE.test(lastUserTurn.summary) || ESCALATION_RE.test(lastUserTurn.summary)) {
    return { outcome: "failure", signal: "self_service_or_escalation" };
  }

  // Last user turn is positive → success or partial
  if (lastUserTurn.sentiment === "positive") {
    if (hasCorrections || hasRephrases) {
      // Found the turn where things changed for the better
      let keyPivot: number | undefined;
      for (let i = 0; i < trajectoryTurns.length; i++) {
        const t = trajectoryTurns[i];
        if (t.role === "user" && t.sentiment === "positive" && !t.wasCorrection) {
          keyPivot = i;
          break;
        }
      }
      return {
        outcome: "partial",
        signal: "corrections_then_success",
        keyPivot,
      };
    }
    return { outcome: "success", signal: "positive_close" };
  }

  // Last turn negative → failure
  if (lastUserTurn.sentiment === "negative") {
    return { outcome: "failure", signal: "ended_with_correction" };
  }

  // Neutral last turn — check if there were any positives anywhere
  const anyPositive = userTurns.some((t) => t.sentiment === "positive");
  if (anyPositive && !hasCorrections) {
    return { outcome: "success", signal: "neutral_close_after_praise" };
  }

  return { outcome: "partial", signal: "neutral_close" };
}

/**
 * Extract heuristic lessons from a trajectory without LLM.
 */
export function extractTrajectoryLessons(trajectory: FeedbackTrajectory): string[] {
  const lessons: string[] = [];
  const { outcome, turns, keyPivot, toolsUsed, turnCount, topic } = trajectory;

  const topicStr = topic ? `on "${topic}"` : "in this conversation";

  if (outcome === "success") {
    if (turnCount <= 3) {
      const tools = toolsUsed.length > 0 ? ` using ${toolsUsed.join(", ")}` : "";
      lessons.push(`Direct approach${tools} worked immediately${topicStr} — no corrections needed.`);
    } else {
      lessons.push(`After ${turnCount} turns, user was satisfied${topicStr}.`);
    }
  } else if (outcome === "partial") {
    if (keyPivot !== undefined) {
      const pivotTurn = turns[keyPivot];
      const before = turns.slice(0, keyPivot).filter((t) => t.wasCorrection).length;
      const pivotSummary = pivotTurn ? pivotTurn.summary.slice(0, 100) : "unknown";
      lessons.push(
        `Approach changed at turn ${keyPivot} (after ${before} correction(s)) which resolved the issue${topicStr}: "${pivotSummary}"`,
      );
    } else {
      lessons.push(`User had corrections then eventual success${topicStr} after ${turnCount} turns.`);
    }
  } else {
    // failure
    const corrections = turns.filter((t) => t.wasCorrection).length;
    const rephrases = turns.filter((t) => t.wasRephrase).length;
    if (corrections > 0 || rephrases > 0) {
      lessons.push(
        `User had to self-service or escalate after ${corrections} correction(s) and ${rephrases} rephrase(s)${topicStr} across ${turnCount} turns.`,
      );
    } else {
      lessons.push(`Interaction did not reach resolution${topicStr} after ${turnCount} turns.`);
    }
  }

  return lessons;
}

/**
 * Extract the dominant topic from trajectory turns.
 */
function extractTopic(turns: ConversationTurn[], boundary: TrajectoryBoundary): string {
  const firstUserMsg = turns
    .slice(boundary.startIndex, boundary.endIndex + 1)
    .find((t) => t.role === "user");
  if (!firstUserMsg) return "";
  // Take first 60 chars as topic proxy
  return firstUserMsg.content.slice(0, 60).trim();
}

/**
 * Extract all tools used in a trajectory.
 */
function extractToolsUsed(turns: ConversationTurn[], boundary: TrajectoryBoundary): string[] {
  const tools = new Set<string>();
  for (let i = boundary.startIndex; i <= boundary.endIndex; i++) {
    for (const tool of turns[i].toolCalls ?? []) {
      tools.add(tool);
    }
  }
  return [...tools];
}

/**
 * Build FeedbackTrajectory objects from raw conversation turns.
 */
export function buildTrajectories(
  turns: ConversationTurn[],
  sessionFile: string,
): FeedbackTrajectory[] {
  const trajectories: FeedbackTrajectory[] = [];
  try {
    const boundaries = detectTrajectoryBoundaries(turns);
    for (const boundary of boundaries) {
      const tTurns = buildTrajectoryTurns(turns, boundary);
      const { outcome, signal, keyPivot } = classifyTrajectoryOutcome(tTurns);
      const topic = extractTopic(turns, boundary);
      const toolsUsed = extractToolsUsed(turns, boundary);

      const trajectory: FeedbackTrajectory = {
        id: randomUUID(),
        sessionFile,
        turns: tTurns,
        outcome,
        outcomeSignal: signal,
        keyPivot,
        lessonsExtracted: [],
        topic,
        toolsUsed,
        turnCount: tTurns.length,
      };
      trajectory.lessonsExtracted = extractTrajectoryLessons(trajectory);
      trajectories.push(trajectory);
    }
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "buildTrajectories",
      severity: "warning",
      subsystem: "trajectory-tracker",
    });
  }
  return trajectories;
}

/**
 * Serialize a FeedbackTrajectory for DB storage.
 */
export function serializeTrajectory(t: FeedbackTrajectory): {
  id: string;
  session_file: string;
  turns_json: string;
  outcome: string;
  outcome_signal: string;
  key_pivot: number | null;
  lessons_json: string;
  topic: string;
  tools_used: string;
  turn_count: number;
} {
  return {
    id: t.id,
    session_file: t.sessionFile,
    turns_json: JSON.stringify(t.turns),
    outcome: t.outcome,
    outcome_signal: t.outcomeSignal,
    key_pivot: t.keyPivot ?? null,
    lessons_json: JSON.stringify(t.lessonsExtracted),
    topic: t.topic,
    tools_used: JSON.stringify(t.toolsUsed),
    turn_count: t.turnCount,
  };
}
