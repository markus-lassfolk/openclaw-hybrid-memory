/**
 * Active-task prompt injection: projection filters, relevance ordering, unified char budget.
 */

import type { ActiveTaskProjectionConfig } from "../config.js";
import type { ActiveTaskEntry, ActiveTaskStatus } from "./active-task.js";
import {
  buildActiveTaskInjection,
  buildStaleWarningInjection,
  type ActiveTaskInjectionBuildResult,
} from "./active-task.js";
import { buildHeartbeatTaskHygieneBlock } from "./task-hygiene.js";
import { applyActiveTaskProjectionFilters } from "./task-ledger-facts.js";
import { estimateTokens } from "../utils/text.js";

const ACTIVE_STATUSES = new Set<ActiveTaskStatus>(["In progress", "Waiting", "Stalled", "Failed"]);
const LABEL_LIST_CAP = 15;

function parseUpdatedMs(updated: string): number {
  if (!updated || updated === "Unknown") return 0;
  const ms = Date.parse(updated);
  return Number.isNaN(ms) ? 0 : ms;
}

function taskRelevanceScore(task: ActiveTaskEntry, userText?: string, sessionKey?: string): number {
  let score = 0;
  const sk = sessionKey?.trim();
  if (sk && task.subagent?.includes(sk)) score += 4;
  const ut = userText?.trim().toLowerCase();
  if (ut) {
    const label = task.label.trim().toLowerCase();
    const desc = task.description.trim().toLowerCase();
    if (label && ut.includes(label)) score += 3;
    if (desc.length >= 8 && ut.includes(desc.slice(0, Math.min(desc.length, 48)))) score += 2;
    for (const token of label.split(/[-_]+/)) {
      if (token.length >= 4 && ut.includes(token)) score += 1;
    }
  }
  return score;
}

function compareTasksForInjection(
  a: ActiveTaskEntry,
  b: ActiveTaskEntry,
  userText?: string,
  sessionKey?: string,
): number {
  if (a.stale !== b.stale) return a.stale ? 1 : -1;
  const rel = taskRelevanceScore(b, userText, sessionKey) - taskRelevanceScore(a, userText, sessionKey);
  if (rel !== 0) return rel;
  return parseUpdatedMs(b.updated) - parseUpdatedMs(a.updated);
}

/** Cap comma-separated task labels for heartbeat hygiene lines. */
export function formatCappedTaskLabelList(labels: string[], maxShown = LABEL_LIST_CAP): string {
  if (labels.length <= maxShown) {
    return labels.map((l) => `[${l}]`).join(", ");
  }
  const shown = labels
    .slice(0, maxShown)
    .map((l) => `[${l}]`)
    .join(", ");
  return `${shown}, …and ${labels.length - maxShown} more`;
}

/**
 * Filter, dedupe (projection), sort for injection, and apply optional row caps.
 */
export function prepareActiveTasksForInjection(
  ledgerTasks: ActiveTaskEntry[],
  opts: {
    projection: ActiveTaskProjectionConfig;
    injectionMaxTasks?: number;
    userText?: string;
    sessionKey?: string;
  },
): { prepared: ActiveTaskEntry[]; ledgerActiveCount: number; filteredActiveCount: number } {
  const ledgerActiveCount = ledgerTasks.filter((t) => ACTIVE_STATUSES.has(t.status)).length;
  let prepared = ledgerTasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  prepared = applyActiveTaskProjectionFilters(prepared, opts.projection);
  prepared.sort((a, b) => compareTasksForInjection(a, b, opts.userText, opts.sessionKey));

  const rowCap = opts.injectionMaxTasks ?? opts.projection.maxRowsPerSection;
  if (typeof rowCap === "number" && rowCap > 0 && prepared.length > rowCap) {
    prepared = prepared.slice(0, rowCap);
  }

  return { prepared, ledgerActiveCount, filteredActiveCount: prepared.length };
}

export type ActiveTaskContextBundleResult = {
  parts: string[];
  ledgerActiveCount: number;
  filteredActiveCount: number;
  injectedTaskCount: number;
  injectedTokens: number;
};

export type ActiveTaskContextBundleInput = {
  ledgerTasks: ActiveTaskEntry[];
  injectionBudgetTokens: number;
  staleMinutes: number;
  staleWarningEnabled: boolean;
  projection: ActiveTaskProjectionConfig;
  injectionMaxTasks?: number;
  userText?: string;
  sessionKey?: string;
  heartbeatHygiene?: { maxChars: number; suggestGoalAfterTaskAgeDays: number };
  goalEscalationBlock?: string;
};

/**
 * Build all budgeted active-task prepend blocks from one shared char pool (`injectionBudget * 4`).
 */
export function buildActiveTaskContextBundle(input: ActiveTaskContextBundleInput): ActiveTaskContextBundleResult {
  const { prepared, ledgerActiveCount, filteredActiveCount } = prepareActiveTasksForInjection(input.ledgerTasks, {
    projection: input.projection,
    injectionMaxTasks: input.injectionMaxTasks,
    userText: input.userText,
    sessionKey: input.sessionKey,
  });

  const parts: string[] = [];
  let injectedTaskCount = 0;
  const totalChars = Math.max(0, input.injectionBudgetTokens * 4);
  const hygieneReserve =
    input.heartbeatHygiene != null
      ? Math.min(input.heartbeatHygiene.maxChars, Math.max(200, Math.floor(totalChars * 0.25)))
      : 0;
  let remainingChars = Math.max(0, totalChars - hygieneReserve);

  if (prepared.length > 0 && remainingChars > 80) {
    const main: ActiveTaskInjectionBuildResult = buildActiveTaskInjection(prepared, input.injectionBudgetTokens, {
      maxChars: remainingChars,
    });
    if (main.text) {
      parts.push(main.text);
      injectedTaskCount = main.injectedCount;
      remainingChars = Math.max(0, remainingChars - main.text.length - 2);
    }
  }

  if (input.staleWarningEnabled && remainingChars > 40) {
    const staleResult = buildStaleWarningInjection(prepared, input.staleMinutes, remainingChars);
    if (staleResult.text) {
      parts.push(staleResult.text);
      injectedTaskCount += staleResult.renderedCount;
      remainingChars = Math.max(0, remainingChars - staleResult.text.length - 2);
    }
  }

  if (input.heartbeatHygiene) {
    const hygieneCap = Math.min(input.heartbeatHygiene.maxChars, hygieneReserve + remainingChars);
    if (hygieneCap > 60) {
      const hygiene = buildHeartbeatTaskHygieneBlock(prepared, {
        maxChars: hygieneCap,
        suggestGoalAfterTaskAgeDays: input.heartbeatHygiene.suggestGoalAfterTaskAgeDays,
        formatLabelList: formatCappedTaskLabelList,
      });
      if (hygiene) {
        parts.push(hygiene);
      }
    }
  }

  const usedChars = parts.reduce((sum, p) => sum + p.length + 2, 0);
  const leftAfterBlocks = Math.max(0, totalChars - usedChars);
  if (input.goalEscalationBlock && leftAfterBlocks > 40) {
    const block =
      input.goalEscalationBlock.length <= leftAfterBlocks
        ? input.goalEscalationBlock
        : `${input.goalEscalationBlock.slice(0, Math.max(0, leftAfterBlocks - 24))}\n…(truncated)\n`;
    if (block.trim()) {
      parts.push(block);
    }
  }

  const combined = parts.filter(Boolean).join("\n\n");
  return {
    parts,
    ledgerActiveCount,
    filteredActiveCount,
    injectedTaskCount,
    injectedTokens: combined ? estimateTokens(combined) : 0,
  };
}
