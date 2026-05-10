/**
 * Pre-finalization guard for unfinished external workflows (#1271).
 *
 * Evaluates the current turn right before finalization and decides whether to:
 * - allow finalization,
 * - warn (non-blocking), or
 * - block finalization until checkpoint requirements are met.
 */

import type { MemoryEntry } from "../types/memory.js";
import { TASK_LEDGER_CATEGORY, groupProjectFactsByEntity } from "./task-ledger-facts.js";

export class PreFinalizationGuardBlockingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreFinalizationGuardBlockingError";
  }
}

const WAITING_OR_PENDING_RE =
  /\b(wait(?:ing)?|pending|recheck|check back|continue (?:later|after|tomorrow)|follow up(?: later)?|await(?:ing)?)\b/i;
const CRON_WAKE_RE =
  /\b(?:cron wake|scheduled?\s+(?:a\s+)?(?:wake|wake-?up|recheck)|wake(?:\s|-)?at|resume(?:\s+at|\s+on)|next\s+(?:wake|check))\b/i;
const BACKGROUND_TEXT_RE =
  /\b(?:in the background|background process|still running in background|running in the background|daemonized)\b/i;
const UNRESOLVED_EXTERNAL_RE =
  /\b(?:ci|checks?|workflow|mergeabilit(?:y|ies)|review|approval|deploy(?:ment)?|job|pipeline)\b[^\n.]{0,80}\b(?:pending|running|in progress|queued|awaiting|blocked|not (?:done|complete)|still running)\b/i;
const BACKGROUND_COMMAND_RE = /(?:\s&\s*$)|(?:\s&$)|\b(?:nohup|disown|bg|screen\s+-dm|tmux\s+new-session\s+-d)\b/i;
const GIT_MUTATION_RE =
  /\bgit\s+(?:add|commit|push|merge|rebase|cherry-pick|revert|tag|branch|switch|checkout|stash|pull|mv|rm|reset\s+--soft)\b/i;
const GH_MUTATION_RE =
  /\bgh\s+(?:pr\s+(?:create|merge|ready|review|edit)|issue\s+(?:create|edit)|workflow\s+run|api\s+repos\/[^\s]+\/pulls\/\d+)\b/i;

const WAITING_WAKE_FIELDS = [
  "wake",
  "wake_at",
  "wakeat",
  "next_wake",
  "next_check",
  "next_check_at",
  "resume_at",
  "resumeat",
  "cron_wake",
  "scheduled_wake",
  "wake_link",
] as const;

const ACTIVE_PROJECT_STATUSES = new Set(["in_progress", "waiting", "blocked"]);

export const CHECKPOINT_GUARD_BYPASS_PREFIX = "CHECKPOINT_GUARD_BYPASS:";
const BYPASS_REASON_RE = /(?:CHECKPOINT_GUARD_BYPASS:|checkpoint[-_ ]guard[-_ ]bypass\s*:)\s*([^\n]{3,160})/i;

const DEFAULT_TASK_UPDATED_FRESHNESS_MS = 2 * 60 * 60 * 1000;

interface ToolCallSnapshot {
  name: string;
  rawArguments: string;
  parsedArgs: Record<string, unknown> | null;
}

interface ProjectCheckpointEvaluation {
  satisfied: boolean;
  candidateEntity?: string;
  missingFields: string[];
}

export interface PreFinalizationGuardSignals {
  waitingOrPending: boolean;
  cronWakeScheduled: boolean;
  backgroundProcessRunning: boolean;
  gitOrGithubMutation: boolean;
  unresolvedExternalMention: boolean;
}

export interface PreFinalizationGuardCheckpointEvidence {
  activeTaskCheckpointCalled: boolean;
  goalAssessCalled: boolean;
  projectFactsSatisfied: boolean;
  projectCheckpointEntity?: string;
  missingFields: string[];
}

export interface PreFinalizationGuardResult {
  action: "allow" | "warn" | "block";
  reason:
    | "no_external_signal"
    | "checkpoint_present"
    | "explicit_bypass"
    | "missing_checkpoint_block"
    | "missing_checkpoint_warn";
  signals: PreFinalizationGuardSignals;
  checkpoint: PreFinalizationGuardCheckpointEvidence;
  bypassReason: string | null;
}

export interface EvaluatePreFinalizationGuardOptions {
  projectFacts?: MemoryEntry[];
  nowMs?: number;
  taskUpdatedFreshnessMs?: number;
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      texts.push(b.text);
    }
  }
  return texts;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collectToolCalls(messages: unknown[]): ToolCallSnapshot[] {
  const out: ToolCallSnapshot[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;

    const toolCalls = m.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = (tc as { function?: unknown }).function;
        if (!fn || typeof fn !== "object") continue;
        const name = (fn as { name?: unknown }).name;
        if (typeof name !== "string" || !name.trim()) continue;
        const argsRaw = (fn as { arguments?: unknown }).arguments;
        const rawArguments = typeof argsRaw === "string" ? argsRaw : "";
        out.push({
          name: name.trim(),
          rawArguments,
          parsedArgs: parseJsonRecord(rawArguments),
        });
      }
    }

    const content = m.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;
        const name = b.name;
        if (typeof name !== "string" || !name.trim()) continue;
        const input = b.input;
        let rawArguments = "";
        let parsedArgs: Record<string, unknown> | null = null;
        if (typeof input === "string") {
          rawArguments = input;
          parsedArgs = parseJsonRecord(input);
        } else if (input && typeof input === "object" && !Array.isArray(input)) {
          parsedArgs = input as Record<string, unknown>;
          try {
            rawArguments = JSON.stringify(input);
          } catch {
            rawArguments = "";
          }
        }
        out.push({ name: name.trim(), rawArguments, parsedArgs });
      }
    }

    const legacyToolCalls = m.toolCalls;
    if (Array.isArray(legacyToolCalls)) {
      for (const name of legacyToolCalls) {
        if (typeof name !== "string" || !name.trim()) continue;
        out.push({ name: name.trim(), rawArguments: "", parsedArgs: null });
      }
    }
  }

  return out;
}

function currentTurnSlice(messages: unknown[]): unknown[] {
  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role === "user") {
      lastUserIndex = i;
    }
  }
  if (lastUserIndex < 0) return messages;
  return messages.slice(lastUserIndex);
}

function collectAssistantTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    texts.push(...extractTextBlocks(m.content));
  }
  return texts;
}

function extractCommandCandidates(call: ToolCallSnapshot): string[] {
  const candidates: string[] = [];
  if (call.rawArguments.trim()) candidates.push(call.rawArguments);

  const parsed = call.parsedArgs;
  if (!parsed) return candidates;

  const preferredKeys = ["cmd", "command", "script", "bash", "input", "query", "args"];
  for (const key of preferredKeys) {
    const v = parsed[key];
    if (typeof v === "string" && v.trim()) {
      candidates.push(v);
    }
  }

  for (const value of Object.values(parsed)) {
    if (typeof value === "string" && value.trim()) {
      candidates.push(value);
    }
  }

  return candidates;
}

function normalizeProjectStatus(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim().toLowerCase();
  if (s === "open" || s === "in progress" || s === "in_progress") return "in_progress";
  if (s === "pending" || s === "waiting") return "waiting";
  if (s === "blocked" || s === "stalled" || s.startsWith("blocked")) return "blocked";
  return null;
}

function chooseLatestText(entry: MemoryEntry | undefined): string {
  if (!entry) return "";
  return (entry.value ?? entry.text ?? "").trim();
}

function evaluateProjectCheckpoint(
  projectFacts: MemoryEntry[],
  nowMs: number,
  taskUpdatedFreshnessMs: number,
  goalAssessCalled: boolean,
  cronWakeScheduled: boolean,
): ProjectCheckpointEvaluation {
  if (projectFacts.length === 0) return { satisfied: false, missingFields: ["status"] };

  const grouped = groupProjectFactsByEntity(projectFacts);
  let bestUnsatisfied: { entity: string; updatedMs: number; missingFields: string[] } | null = null;

  for (const [entity, keyMap] of grouped.entries()) {
    const status = normalizeProjectStatus(chooseLatestText(keyMap.get("status")));
    if (!status || !ACTIVE_PROJECT_STATUSES.has(status)) continue;

    const next = chooseLatestText(keyMap.get("next"));
    const relatedSession = chooseLatestText(keyMap.get("related_session"));
    const relatedGoal = chooseLatestText(keyMap.get("related_goal")) || chooseLatestText(keyMap.get("goal_id"));
    const updatedRaw =
      chooseLatestText(keyMap.get("task_updated")) ||
      chooseLatestText(keyMap.get("updated")) ||
      chooseLatestText(keyMap.get("updated_at"));
    const updatedMs = updatedRaw ? Date.parse(updatedRaw) : Number.NaN;
    const updatedFresh = Number.isFinite(updatedMs) && nowMs - updatedMs <= taskUpdatedFreshnessMs;

    const wakeLinked =
      status !== "waiting" ||
      cronWakeScheduled ||
      WAITING_WAKE_FIELDS.some((k) => {
        const raw = chooseLatestText(keyMap.get(k));
        return raw.length > 0;
      });

    const missingFields: string[] = [];
    if (!next) missingFields.push("next");
    if (!updatedFresh) missingFields.push("task_updated");
    if (!relatedSession) missingFields.push("related_session");
    if (!wakeLinked) missingFields.push("wake_link");
    if (relatedGoal && !goalAssessCalled) missingFields.push("goal_assess");

    if (missingFields.length === 0) {
      return { satisfied: true, candidateEntity: entity, missingFields: [] };
    }

    const rankMs = Number.isFinite(updatedMs) ? updatedMs : 0;
    if (!bestUnsatisfied || rankMs > bestUnsatisfied.updatedMs) {
      bestUnsatisfied = { entity, updatedMs: rankMs, missingFields };
    }
  }

  if (bestUnsatisfied) {
    return {
      satisfied: false,
      candidateEntity: bestUnsatisfied.entity,
      missingFields: bestUnsatisfied.missingFields,
    };
  }

  return { satisfied: false, missingFields: ["status"] };
}

function extractBypassReason(text: string): string | null {
  const match = text.match(BYPASS_REASON_RE);
  if (!match) return null;
  const reason = match[1]?.trim() ?? "";
  return reason.length >= 3 && reason.length <= 160 ? reason : null;
}

function detectSignals(finalAssistantText: string, toolCalls: ToolCallSnapshot[]): PreFinalizationGuardSignals {
  let gitOrGithubMutation = false;
  let backgroundProcessRunning = BACKGROUND_TEXT_RE.test(finalAssistantText);
  let cronWakeScheduled = CRON_WAKE_RE.test(finalAssistantText);

  for (const call of toolCalls) {
    const commands = extractCommandCandidates(call);
    const nameLower = call.name.toLowerCase();
    if (nameLower.includes("active_task_checkpoint")) {
      continue;
    }
    for (const cmd of commands) {
      if (GIT_MUTATION_RE.test(cmd) || GH_MUTATION_RE.test(cmd)) {
        gitOrGithubMutation = true;
      }
      if (BACKGROUND_COMMAND_RE.test(cmd)) {
        backgroundProcessRunning = true;
      }
      if (CRON_WAKE_RE.test(cmd)) {
        cronWakeScheduled = true;
      }
    }
  }

  return {
    waitingOrPending: WAITING_OR_PENDING_RE.test(finalAssistantText),
    cronWakeScheduled,
    backgroundProcessRunning,
    gitOrGithubMutation,
    unresolvedExternalMention: UNRESOLVED_EXTERNAL_RE.test(finalAssistantText),
  };
}

export function evaluatePreFinalizationGuard(
  messages: unknown[],
  options: EvaluatePreFinalizationGuardOptions = {},
): PreFinalizationGuardResult {
  const nowMs = options.nowMs ?? Date.now();
  const taskUpdatedFreshnessMs = options.taskUpdatedFreshnessMs ?? DEFAULT_TASK_UPDATED_FRESHNESS_MS;
  const turnMessages = currentTurnSlice(messages);
  const assistantTexts = collectAssistantTexts(turnMessages);
  const finalAssistantText = assistantTexts[assistantTexts.length - 1] ?? "";
  const toolCalls = collectToolCalls(turnMessages);
  const bypassReason = extractBypassReason(finalAssistantText);

  const activeTaskCheckpointCalled = toolCalls.some((c) => c.name.toLowerCase() === "active_task_checkpoint");
  const goalAssessCalled = toolCalls.some((c) => c.name.toLowerCase() === "goal_assess");
  const signals = detectSignals(finalAssistantText, toolCalls);
  const strongSignals =
    signals.waitingOrPending ||
    signals.cronWakeScheduled ||
    signals.backgroundProcessRunning ||
    signals.unresolvedExternalMention;
  const weakSignals = signals.gitOrGithubMutation;
  const shouldGuard = strongSignals || weakSignals;

  if (!shouldGuard) {
    return {
      action: "allow",
      reason: "no_external_signal",
      signals,
      checkpoint: {
        activeTaskCheckpointCalled,
        goalAssessCalled,
        projectFactsSatisfied: false,
        missingFields: [],
      },
      bypassReason: null,
    };
  }

  const allProjectFacts = (options.projectFacts ?? []).filter((f) => f.category === TASK_LEDGER_CATEGORY);
  const projectCheckpoint = evaluateProjectCheckpoint(
    allProjectFacts,
    nowMs,
    taskUpdatedFreshnessMs,
    goalAssessCalled,
    signals.cronWakeScheduled,
  );
  const checkpointSatisfied = activeTaskCheckpointCalled || projectCheckpoint.satisfied;

  if (bypassReason) {
    return {
      action: "allow",
      reason: "explicit_bypass",
      signals,
      checkpoint: {
        activeTaskCheckpointCalled,
        goalAssessCalled,
        projectFactsSatisfied: projectCheckpoint.satisfied,
        projectCheckpointEntity: projectCheckpoint.candidateEntity,
        missingFields: projectCheckpoint.missingFields,
      },
      bypassReason,
    };
  }

  if (checkpointSatisfied) {
    return {
      action: "allow",
      reason: "checkpoint_present",
      signals,
      checkpoint: {
        activeTaskCheckpointCalled,
        goalAssessCalled,
        projectFactsSatisfied: projectCheckpoint.satisfied,
        projectCheckpointEntity: projectCheckpoint.candidateEntity,
        missingFields: projectCheckpoint.missingFields,
      },
      bypassReason: null,
    };
  }

  return {
    action: strongSignals ? "block" : "warn",
    reason: strongSignals ? "missing_checkpoint_block" : "missing_checkpoint_warn",
    signals,
    checkpoint: {
      activeTaskCheckpointCalled,
      goalAssessCalled,
      projectFactsSatisfied: false,
      projectCheckpointEntity: projectCheckpoint.candidateEntity,
      missingFields: projectCheckpoint.missingFields,
    },
    bypassReason: null,
  };
}

export function formatPreFinalizationGuardMessage(result: PreFinalizationGuardResult): string {
  if (result.reason === "no_external_signal") {
    return "pre-finalization guard: no unfinished external-workflow signals detected.";
  }
  if (result.reason === "checkpoint_present") {
    const source = result.checkpoint.activeTaskCheckpointCalled ? "active_task_checkpoint tool call" : "project facts";
    return `pre-finalization guard: checkpoint satisfied via ${source}.`;
  }
  if (result.reason === "explicit_bypass") {
    return `pre-finalization guard: bypass accepted (${result.bypassReason ?? "no reason"}).`;
  }

  const missing =
    result.checkpoint.missingFields.length > 0 ? result.checkpoint.missingFields.join(", ") : "project checkpoint";
  const mode = result.action === "block" ? "blocking" : "warning";
  return [
    `pre-finalization guard: ${mode} finalization due to unfinished external workflow and missing checkpoint fields: ${missing}.`,
    "Satisfy with active_task_checkpoint (if available) or project facts keys [status(in_progress|waiting|blocked), next, task_updated, related_session].",
    `False positive override: include '${CHECKPOINT_GUARD_BYPASS_PREFIX} <short reason>' in the final assistant message.`,
  ].join(" ");
}
