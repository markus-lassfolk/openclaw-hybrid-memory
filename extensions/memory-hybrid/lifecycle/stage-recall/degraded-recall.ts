/**
 * Shared FTS-only + HOT recall paths for queue/timeout degradation and short prompts.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { formatNarrativeRange, recallNarrativeSummaries } from "../../services/narrative-recall.js";
import { resolveInteractiveRecallPolicy } from "../../services/retrieval-mode-policy.js";
import { trimBlockToBudget } from "../../services/context-block-trim.js";
import { consumePrependBudget, initPrependBudget } from "../../services/prepend-budget.js";
import {
  assembleRecallPrependContext,
  edictMaxTokensForBudget,
} from "../../services/recalled-context-assembler.js";
import { sanitizePromptInjection } from "../../services/skill-prompt-injection.js";
import type { ScopeFilter } from "../../types/memory.js";
import type { SearchResult } from "../../types/memory.js";
import { estimateTokens, sanitizeRecallFactText } from "../../utils/text.js";
import { resolveAgentIdFromHookEvent } from "../resolve-agent-id.js";
import type { LifecycleContext, RecallStageResult, SessionState } from "../types.js";

export type DegradedRecallReason = "queue" | "timeout";

function clipNarrativeText(text: string, maxChars = 360): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

type FixedBlockAudit = {
  block: string;
  sourceTokens: number;
  capTokens: number;
  injectedTokens: number;
  reserved: boolean;
  truncated: boolean;
  suppressed: boolean;
  reason?: "empty" | "cap" | "budget_exhausted";
};

type BudgetState = {
  remainingBudget: number;
  audit: FixedBlockAudit[];
};

function capAndTrackBlock(name: string, block: string, capTokens: number, state: BudgetState): string {
  const cap = Math.max(0, Math.floor(capTokens));
  const allowed = Math.min(cap, state.remainingBudget);
  const { text, sourceTokens, usedTokens } = trimBlockToBudget(block, allowed);
  const suppressed = sourceTokens > 0 && usedTokens === 0;
  state.audit.push({
    block: name,
    sourceTokens,
    capTokens: cap,
    injectedTokens: usedTokens,
    reserved: false,
    truncated: sourceTokens > usedTokens,
    suppressed,
    reason:
      sourceTokens === 0
        ? "empty"
        : usedTokens === 0
          ? "budget_exhausted"
          : sourceTokens > usedTokens
            ? allowed < cap
              ? "budget_exhausted"
              : "cap"
            : undefined,
  });
  state.remainingBudget = Math.max(0, state.remainingBudget - usedTokens);
  return text;
}

function reserveAndTrackBlock(name: string, reserveTokens: number, enabled: boolean, state: BudgetState): void {
  const cap = enabled ? Math.max(0, Math.floor(reserveTokens)) : 0;
  const reserved = Math.min(cap, state.remainingBudget);
  state.audit.push({
    block: name,
    sourceTokens: cap,
    capTokens: cap,
    injectedTokens: reserved,
    reserved: true,
    truncated: cap > reserved,
    suppressed: cap > 0 && reserved === 0,
    reason: cap === 0 ? "empty" : reserved === 0 ? "budget_exhausted" : cap > reserved ? "budget_exhausted" : undefined,
  });
  state.remainingBudget = Math.max(0, state.remainingBudget - reserved);
}

export function resolveRecallScopeFilter(ctx: LifecycleContext): ScopeFilter | undefined {
  const { currentAgentIdRef } = ctx;
  if (currentAgentIdRef.value && currentAgentIdRef.value !== ctx.cfg.multiAgent.orchestratorId) {
    return {
      userId: ctx.cfg.autoRecall.scopeFilter?.userId ?? null,
      agentId: currentAgentIdRef.value,
      sessionId: ctx.cfg.autoRecall.scopeFilter?.sessionId ?? null,
    };
  }
  if (
    ctx.cfg.autoRecall.scopeFilter &&
    (ctx.cfg.autoRecall.scopeFilter.userId ||
      ctx.cfg.autoRecall.scopeFilter.agentId ||
      ctx.cfg.autoRecall.scopeFilter.sessionId)
  ) {
    return {
      userId: ctx.cfg.autoRecall.scopeFilter.userId ?? null,
      agentId: ctx.cfg.autoRecall.scopeFilter.agentId ?? null,
      sessionId: ctx.cfg.autoRecall.scopeFilter.sessionId ?? null,
    };
  }
  return undefined;
}

function degradedMarkerForReason(reason: DegradedRecallReason): string {
  return reason === "timeout" ? "<!-- recall degraded: timeout -->\n" : "<!-- recall degraded: queue -->\n";
}

function formatRecallLines(results: SearchResult[], maxItems: number): string[] {
  return results
    .slice(0, maxItems)
    .map((r) => {
      const text = sanitizePromptInjection(sanitizeRecallFactText(r.entry.summary || r.entry.text));
      if (!text) return "";
      const clipped = `${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
      return `- [${r.backend}/${r.entry.category}] ${clipped}`;
    })
    .filter(Boolean);
}

function buildHotPart(
  ctx: LifecycleContext,
  scopeFilter: ScopeFilter | undefined,
  hotCapTokens: number,
  budgetState: BudgetState,
): string {
  if (!ctx.cfg.memoryTiering.enabled || ctx.cfg.memoryTiering.hotMaxTokens <= 0) return "";
  const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
  if (hotResults.length === 0) return "";
  const hotLines = hotResults
    .map((r) => {
      const text = sanitizePromptInjection(sanitizeRecallFactText(r.entry.summary || r.entry.text));
      if (!text) return "";
      const clipped = `${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
      return `- [hot/${r.entry.category}] ${clipped}`;
    })
    .filter(Boolean);
  if (hotLines.length === 0) return "";
  const hotBlock = `Hot memories:\n${hotLines.join("\n")}\n\n`;
  return capAndTrackBlock("hot", hotBlock, hotCapTokens, budgetState);
}

function buildNarrativePart(
  ctx: LifecycleContext,
  prompt: string,
  narrativeCapTokens: number,
  budgetState: BudgetState,
  sessionId?: string | null,
): string {
  if (!ctx.narrativesDb && !ctx.eventLog) return "";
  try {
    const recentNarratives = recallNarrativeSummaries({
      narrativesDb: ctx.narrativesDb,
      eventLog: ctx.eventLog,
      query: prompt,
      sessionId: sessionId ?? undefined,
      limit: 1,
    });
    if (recentNarratives.length === 0) return "";
    const narrative = recentNarratives[0];
    const source = sanitizePromptInjection(narrative.source);
    const sessionId = sanitizePromptInjection(narrative.sessionId);
    const narrativeBlock = `<recent-history-narratives>\n- [${source}/${formatNarrativeRange(narrative.periodStart, narrative.periodEnd)}] (sessionKey: ${sessionId})\n${clipNarrativeText(sanitizePromptInjection(narrative.text))}\n</recent-history-narratives>\n\n`;
    return capAndTrackBlock("narrative", narrativeBlock, narrativeCapTokens, budgetState);
  } catch {
    return "";
  }
}

export async function buildDegradedFtsHotRecallStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
  reason: DegradedRecallReason,
  options?: { runFts?: boolean },
): Promise<RecallStageResult> {
  const e = event as { prompt?: string };
  const prompt = e.prompt ?? "";
  const scopeFilter = resolveRecallScopeFilter(ctx);
  const interactivePolicy = resolveInteractiveRecallPolicy(
    ctx.cfg.autoRecall,
    ctx.cfg.queryExpansion,
    ctx.cfg.retrieval,
  );
  const totalBudget = interactivePolicy.contextBudgetTokens;
  const {
    hotMaxTokens: hotBlockCapCfg,
    narrativeMaxTokens: narrativeBlockCapCfg,
  } = ctx.cfg.autoRecall;
  const hasNarrativesDb = ctx.narrativesDb != null || ctx.eventLog != null;
  const narrativeCapTokens =
    narrativeBlockCapCfg ?? (hasNarrativesDb ? Math.max(100, Math.floor(totalBudget * 0.2)) : 0);
  const hotCapTokens = hotBlockCapCfg ?? Math.max(100, Math.floor(totalBudget * 0.25));
  const sessionKey = sessionState.resolveSessionKey(event, api) ?? ctx.currentAgentIdRef.value ?? "default";
  const edictReserve = edictMaxTokensForBudget(totalBudget);
  const budgetState: BudgetState = {
    remainingBudget: Math.max(0, totalBudget - edictReserve),
    audit: [],
  };
  const narrativePart = buildNarrativePart(ctx, prompt, narrativeCapTokens, budgetState, sessionKey);
  const hotPart = buildHotPart(ctx, scopeFilter, hotCapTokens, budgetState);

  let recallPart = "";
  const runFts = options?.runFts !== false && prompt.trim().length >= 5;
  if (runFts) {
    const recallOpts = {
      tierFilter: ctx.cfg.memoryTiering.enabled ? ("warm" as const) : ("all" as const),
      scopeFilter,
      reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
      diversityWeight: ctx.cfg.reinforcement?.diversityWeight ?? 1.0,
      interactiveFtsFastPath: true,
      deferAccessRefresh: true,
    };
    const ftsOnly = ctx.factsDb.search(prompt.trim(), ctx.cfg.autoRecall.limit, recallOpts);
    const memoryLines = formatRecallLines(ftsOnly, ctx.cfg.autoRecall.limit);
    const recallBlock = memoryLines.length ? `Recalled (FTS-only):\n${memoryLines.join("\n")}` : "";
    const trimmed = trimBlockToBudget(recallBlock, budgetState.remainingBudget);
    recallPart = trimmed.text;
    budgetState.remainingBudget = Math.max(0, budgetState.remainingBudget - trimmed.usedTokens);
  }

  const inner = narrativePart + hotPart + recallPart;
  const marker = degradedMarkerForReason(reason);
  if (ctx.prependBudgetRef && !ctx.prependBudgetRef.value) {
    initPrependBudget(ctx.prependBudgetRef, totalBudget, sessionKey);
  }

  if (ctx.cfg.autoRecall.recallTiming === "basic" || ctx.cfg.autoRecall.recallTiming === "verbose") {
    const fixedBlocksTokens = totalBudget - budgetState.remainingBudget;
    const blockSummary = budgetState.audit
      .map((b) => `${b.block}:${b.injectedTokens}/${b.capTokens}${b.reserved ? "r" : ""}${b.truncated ? "!" : ""}`)
      .join(", ");
    api.logger.info?.(
      `memory-hybrid: context-audit (degraded:${reason}) fixed=${fixedBlocksTokens}/${totalBudget} recall=${budgetState.remainingBudget} blocks=[${blockSummary}]`,
    );
  }

  ctx.auditStore?.append({
    agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? "unknown",
    action: "recall:context-budget",
    outcome: budgetState.remainingBudget === 0 ? "partial" : "success",
    sessionId: sessionKey,
    tokens: totalBudget - budgetState.remainingBudget,
    context: {
      totalBudget,
      recallBudget: budgetState.remainingBudget,
      blocks: budgetState.audit,
      degraded: true,
      degradedReason: reason,
    },
  });

  if (reason === "timeout") {
    api.logger.warn?.(
      `memory-hybrid: recall stage timed out — returning FTS-only + HOT fallback (${inner.trim() ? "with context" : "empty"})`,
    );
  }

  const prepend =
    assembleRecallPrependContext(ctx, inner, {
      prefix: marker.trim(),
      edictMaxTokens: edictReserve,
    }) ??
    (marker.trim() ? `${marker}\n\n` : undefined);
  if (prepend) consumePrependBudget(ctx.prependBudgetRef, prepend);
  if (prepend) return { kind: "degraded", prependContext: prepend };
  const markerOnly =
    assembleRecallPrependContext(ctx, "", { prefix: marker.trim(), edictMaxTokens: edictReserve }) ??
    `${marker}\n\n`;
  return { kind: "degraded", prependContext: markerOnly };
}

/** Fixed blocks (HOT, narrative) for prompts too short to search. */
export async function buildFixedBlocksRecallStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<RecallStageResult> {
  const result = await buildDegradedFtsHotRecallStage(event, api, ctx, sessionState, "queue", { runFts: false });
  if (result.kind !== "degraded") return result;
  const prependContext = result.prependContext.replace(
    "<!-- recall degraded: queue -->\n",
    "<!-- recall: short prompt (fixed blocks only) -->\n",
  );
  return { kind: "empty", prependContext: prependContext.trim() ? prependContext : undefined };
}
