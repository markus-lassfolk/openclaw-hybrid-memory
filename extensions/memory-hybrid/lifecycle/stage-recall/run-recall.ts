/**
 * Lifecycle stage: Recall (Phase 2.3).
 * Owns the interactive recall path for chat turns.
 * Runs the bounded recall pipeline: degradation check, FTS+vector, ambient, directives,
 * entity lookup, scoring. Returns either degraded/empty prependContext or RecallResult for injection.
 * Config: autoRecall.enabled. Stage wall-clock: INTERACTIVE_RECALL_STAGE_TIMEOUT_MS (abort).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  SessionSeenFacts,
  deduplicateResultsById,
  detectTopicShift,
  generateAmbientQueries,
  searchAmbientIssues,
} from "../../services/ambient-retrieval.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { formatNarrativeRange, recallNarrativeSummaries } from "../../services/narrative-recall.js";
import { type RecallPipelineDeps, runRecallPipelineQuery } from "../../services/recall-pipeline.js";
import { createRecallSpan, createRecallTimingLogger } from "../../services/recall-timing.js";
import { resolveInteractiveRecallPolicy } from "../../services/retrieval-mode-policy.js";
import { RECALLED_CONTEXT_BOUNDARY, sanitizePromptInjection } from "../../services/skill-prompt-injection.js";
import type { ScopeFilter } from "../../types/memory.js";
import type { SearchResult } from "../../types/memory.js";
import { isConsolidatedDerivedFact } from "../../utils/consolidation-controls.js";
import { resolveEntityLookupNames } from "../../utils/entity-lookup-resolve.js";
import { resolveAgentIdFromHookEvent } from "../resolve-agent-id.js";
import { yieldEventLoop } from "../../utils/event-loop-yield.js";
import { isRecallContextSuperseded, suppressStaleLifecycleDbError } from "../../utils/registration-superseded.js";
import { estimateTokens, sanitizeRecallFactText } from "../../utils/text.js";
import type { LifecycleContext, RecallResult, RecallStageResult, SessionState } from "../types.js";

function emptyRecallStage(): RecallStageResult {
  return { kind: "empty", prependContext: undefined };
}

function recallAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function clipNarrativeText(text: string, maxChars = 360): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function trimBlockToBudget(
  block: string,
  maxTokens: number,
): { text: string; sourceTokens: number; usedTokens: number } {
  const sourceTokens = block ? estimateTokens(block) : 0;
  if (!block || sourceTokens === 0 || maxTokens <= 0) {
    return { text: "", sourceTokens, usedTokens: 0 };
  }
  if (sourceTokens <= maxTokens) {
    return { text: block, sourceTokens, usedTokens: sourceTokens };
  }

  const trailingNewlines = block.match(/\n+$/)?.[0] ?? "";
  const core = trailingNewlines.length > 0 ? block.slice(0, -trailingNewlines.length) : block;
  const lines = core.split("\n");
  if (lines.length === 0) return { text: "", sourceTokens, usedTokens: 0 };

  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  const firstTagMatch = first.match(/^<([^>\s/]+)>$/);
  const lastTagMatch = last.match(/^<\/([^>\s]+)>$/);
  if (lines.length >= 3 && firstTagMatch && lastTagMatch && firstTagMatch[1] === lastTagMatch[1]) {
    const middle = lines.slice(1, -1);
    for (let keep = middle.length; keep >= 0; keep--) {
      const candidate = [first, ...middle.slice(0, keep), last].join("\n") + trailingNewlines;
      const candidateTokens = estimateTokens(candidate);
      if (candidateTokens <= maxTokens) {
        return { text: candidate, sourceTokens, usedTokens: candidateTokens };
      }
    }
    return { text: "", sourceTokens, usedTokens: 0 };
  }

  for (let keep = lines.length; keep >= 1; keep--) {
    const candidate = lines.slice(0, keep).join("\n") + trailingNewlines;
    const candidateTokens = estimateTokens(candidate);
    if (candidateTokens <= maxTokens) {
      return { text: candidate, sourceTokens, usedTokens: candidateTokens };
    }
  }
  return { text: "", sourceTokens, usedTokens: 0 };
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

export async function runRecall(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
  signal?: AbortSignal,
): Promise<RecallStageResult> {
  const e = event as { prompt?: string };
  if (!e.prompt || e.prompt.length < 5) {
    return { kind: "empty", prependContext: undefined };
  }
  const promptText = e.prompt;

  if (isRecallContextSuperseded(ctx)) {
    return emptyRecallStage();
  }
  const shouldAbortRecall = (): boolean => recallAborted(signal) || isRecallContextSuperseded(ctx);

  ctx.recallInFlightRef.value++;
  const recallStartMs = Date.now();
  const recallProbeId = `recall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let recallProbePhase = "start";
  let recallProbeWatchdog: ReturnType<typeof setTimeout> | undefined;
  const setRecallProbePhase = (phase: string): void => {
    recallProbePhase = phase;
    scheduleRecallProbeWatchdog();
  };
  const clearRecallProbeWatchdog = (): void => {
    if (recallProbeWatchdog !== undefined) clearTimeout(recallProbeWatchdog);
  };
  const scheduleRecallProbeWatchdog = (): void => {
    clearRecallProbeWatchdog();
    recallProbeWatchdog = setTimeout(() => {
      const elapsedMs = Date.now() - recallStartMs;
      api.logger.warn?.(
        `memory-hybrid: recall-probe id=${recallProbeId} still-running elapsedMs=${elapsedMs} phase=${recallProbePhase} inFlight=${ctx.recallInFlightRef.value} promptChars=${promptText.length}`,
      );
    }, 5_000);
    recallProbeWatchdog.unref?.();
  };
  scheduleRecallProbeWatchdog();
  const recallTiming = createRecallTimingLogger({
    logger: api.logger,
    mode: ctx.cfg.autoRecall.recallTiming ?? "off",
    span: createRecallSpan("recall-stage"),
    op: "auto-recall-stage",
  });
  const recallStageStartedAt = recallTiming.phaseStarted("recall_stage_run", { prompt_chars: e.prompt.length });
  let recallStageCompleted = false;
  let recallStageFields: Record<string, string | number | boolean> | undefined;
  const completeStage = (result: RecallStageResult): RecallStageResult => {
    setRecallProbePhase(`complete:${result.kind}`);
    recallStageFields = {
      result_kind: result.kind,
      candidate_count: result.kind === "full" ? result.result.candidates.length : 0,
      degraded: result.kind === "degraded",
    };
    recallTiming.phaseCompleted("recall_stage_run", recallStageStartedAt, recallStageFields);
    recallStageCompleted = true;
    return result;
  };
  const recallSpan = recallTiming.span;
  try {
    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    const { currentAgentIdRef } = ctx;
    const { resolveSessionKey, ambientSeenFactsMap, ambientLastEmbeddingMap, pruneSessionMaps, sessionStartSeen } =
      sessionState;

    api.logger.debug?.(`memory-hybrid: auto-recall start (prompt length ${e.prompt.length})`);
    api.logger.debug?.(
      `memory-hybrid: recall-probe id=${recallProbeId} enter promptChars=${promptText.length} inFlight=${ctx.recallInFlightRef.value}`,
    );

    if (e.prompt.length >= 5 && ctx.lastAutoRecallPromptRef) {
      ctx.lastAutoRecallPromptRef.value = e.prompt.trim().slice(0, 12_000);
    }

    // Let pending gateway I/O (health RPCs, WebSocket) run before heavy sync work (#931).
    await yieldEventLoop();
    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    const fmt = ctx.cfg.autoRecall.injectionFormat;
    const isProgressive = fmt === "progressive" || fmt === "progressive_hybrid";
    const searchLimit = isProgressive
      ? (ctx.cfg.autoRecall.progressiveMaxCandidates ?? Math.max(ctx.cfg.autoRecall.limit, 15))
      : ctx.cfg.autoRecall.limit;
    const { minScore } = ctx.cfg.autoRecall;
    const limit = searchLimit;
    const tierFilter: "warm" | "all" = ctx.cfg.memoryTiering.enabled ? "warm" : "all";

    let scopeFilter: ScopeFilter | undefined;
    if (currentAgentIdRef.value && currentAgentIdRef.value !== ctx.cfg.multiAgent.orchestratorId) {
      scopeFilter = {
        userId: ctx.cfg.autoRecall.scopeFilter?.userId ?? null,
        agentId: currentAgentIdRef.value,
        sessionId: ctx.cfg.autoRecall.scopeFilter?.sessionId ?? null,
      };
    } else if (
      ctx.cfg.autoRecall.scopeFilter &&
      (ctx.cfg.autoRecall.scopeFilter.userId ||
        ctx.cfg.autoRecall.scopeFilter.agentId ||
        ctx.cfg.autoRecall.scopeFilter.sessionId)
    ) {
      scopeFilter = {
        userId: ctx.cfg.autoRecall.scopeFilter.userId ?? null,
        agentId: ctx.cfg.autoRecall.scopeFilter.agentId ?? null,
        sessionId: ctx.cfg.autoRecall.scopeFilter.sessionId ?? null,
      };
    }

    const interactivePolicy = resolveInteractiveRecallPolicy(
      ctx.cfg.autoRecall,
      ctx.cfg.queryExpansion,
      ctx.cfg.retrieval,
    );
    api.logger.debug?.(
      `memory-hybrid: interactive enrichment=${interactivePolicy.interactiveEnrichment} (HyDE=${interactivePolicy.allowHyde}, ambientMulti=${interactivePolicy.allowAmbientMultiQuery})`,
    );
    const { degradationQueueDepth, degradationMaxLatencyMs } = interactivePolicy;
    const forceDegraded = degradationQueueDepth > 0 && ctx.recallInFlightRef.value > degradationQueueDepth;

    if (forceDegraded) {
      setRecallProbePhase("degraded_fts_only");
      const recallOpts = {
        tierFilter: ctx.cfg.memoryTiering.enabled ? ("warm" as const) : ("all" as const),
        scopeFilter,
        reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
        diversityWeight: ctx.cfg.reinforcement?.diversityWeight ?? 1.0,
        interactiveFtsFastPath: true,
      };
      const degradedLimit = ctx.cfg.autoRecall.limit;
      const trimmed = e.prompt.trim();
      await yieldEventLoop();
      if (shouldAbortRecall()) return completeStage(emptyRecallStage());
      const ftsOnly = ctx.factsDb.search(trimmed, degradedLimit, recallOpts);
      const totalBudget = interactivePolicy.contextBudgetTokens;
      const {
        hotMaxTokens: hotBlockCapCfg,
        narrativeMaxTokens: narrativeBlockCapCfg,
        procedureMaxTokens: procedureBlockCapCfg,
        activeTaskMaxTokens: activeTaskReserveCapCfg,
        staleWarningMaxTokens: staleWarningReserveCapCfg,
      } = ctx.cfg.autoRecall;
      const hasNarrativesDb = ctx.narrativesDb != null || ctx.eventLog != null;
      const narrativeCapTokens =
        narrativeBlockCapCfg ?? (hasNarrativesDb ? Math.max(100, Math.floor(totalBudget * 0.2)) : 0);
      const hotCapTokens = hotBlockCapCfg ?? Math.max(100, Math.floor(totalBudget * 0.25));
      const activeTaskReserveTokens =
        activeTaskReserveCapCfg ??
        (ctx.cfg.activeTask.enabled && ctx.cfg.activeTask.injectionBudget > 0
          ? Math.min(ctx.cfg.activeTask.injectionBudget, Math.max(80, Math.floor(totalBudget * 0.2)))
          : 0);
      const staleWarningReserveTokens =
        staleWarningReserveCapCfg ??
        (ctx.cfg.activeTask.enabled && ctx.cfg.activeTask.staleWarning?.enabled
          ? Math.max(40, Math.floor(totalBudget * 0.08))
          : 0);
      const budgetState: BudgetState = {
        remainingBudget: totalBudget,
        audit: [],
      };
      let narrativePart = "";
      if (ctx.narrativesDb || ctx.eventLog) {
        try {
          const recentNarratives = recallNarrativeSummaries({
            narrativesDb: ctx.narrativesDb,
            eventLog: ctx.eventLog,
            query: e.prompt,
            limit: 1,
          });
          if (recentNarratives.length > 0) {
            const narrative = recentNarratives[0];
            const narrativeBlock = `<recent-history-narratives>\n- [${narrative.source}/${formatNarrativeRange(narrative.periodStart, narrative.periodEnd)}] (sessionKey: ${narrative.sessionId})\n${clipNarrativeText(sanitizePromptInjection(narrative.text))}\n</recent-history-narratives>\n\n`;
            narrativePart = capAndTrackBlock("narrative", narrativeBlock, narrativeCapTokens, budgetState);
          }
        } catch {
          // Non-fatal.
        }
      }
      let hotPart = "";
      if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.hotMaxTokens > 0) {
        const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
        if (hotResults.length > 0) {
          const hotLines = hotResults
            .map((r) => {
              const text = sanitizePromptInjection(sanitizeRecallFactText(r.entry.summary || r.entry.text));
              if (!text) return "";
              const clipped = `${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
              return `- [hot/${r.entry.category}] ${clipped}`;
            })
            .filter(Boolean);
          if (hotLines.length > 0) {
            const hotBlock = `Hot memories:\n${hotLines.join("\n")}\n\n`;
            hotPart = capAndTrackBlock("hot", hotBlock, hotCapTokens, budgetState);
          }
        }
      }
      reserveAndTrackBlock("active-task", activeTaskReserveTokens, ctx.cfg.activeTask.enabled, budgetState);
      reserveAndTrackBlock(
        "stale-warning",
        staleWarningReserveTokens,
        ctx.cfg.activeTask.enabled && (ctx.cfg.activeTask.staleWarning?.enabled ?? false),
        budgetState,
      );
      const memoryLines = ftsOnly
        .slice(0, degradedLimit)
        .map((r) => {
          const text = sanitizePromptInjection(sanitizeRecallFactText(r.entry.summary || r.entry.text));
          if (!text) return "";
          const clipped = `${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
          return `- [${r.backend}/${r.entry.category}] ${clipped}`;
        })
        .filter(Boolean);
      const recallBlock = memoryLines.length ? `Recalled (FTS-only):\n${memoryLines.join("\n")}` : "";
      const { text: recallPart, usedTokens: recallUsedTokens } = trimBlockToBudget(
        recallBlock,
        budgetState.remainingBudget,
      );
      budgetState.remainingBudget = Math.max(0, budgetState.remainingBudget - recallUsedTokens);
      const inner = narrativePart + hotPart + recallPart;
      const block = inner ? `<recalled-context>\n${RECALLED_CONTEXT_BOUNDARY}\n${inner}\n</recalled-context>` : "";
      const degradedMarker = "<!-- recall degraded: queue -->\n";
      const sessionKey = resolveSessionKey(e, api) ?? currentAgentIdRef.value ?? "default";
      const fixedBlocksTokens = totalBudget - budgetState.remainingBudget;
      const blockSummary = budgetState.audit
        .map((b) => `${b.block}:${b.injectedTokens}/${b.capTokens}${b.reserved ? "r" : ""}${b.truncated ? "!" : ""}`)
        .join(", ");
      if (ctx.cfg.autoRecall.recallTiming === "basic" || ctx.cfg.autoRecall.recallTiming === "verbose") {
        api.logger.info?.(
          `memory-hybrid: context-audit (degraded) fixed=${fixedBlocksTokens}/${totalBudget} recall=${budgetState.remainingBudget} blocks=[${blockSummary}]`,
        );
      }
      ctx.auditStore?.append({
        agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? "unknown",
        action: "recall:context-budget",
        outcome: budgetState.remainingBudget === 0 ? "partial" : "success",
        sessionId: sessionKey,
        tokens: fixedBlocksTokens,
        context: {
          totalBudget,
          recallBudget: budgetState.remainingBudget,
          blocks: budgetState.audit,
          degraded: true,
        },
      });
      api.logger.debug?.(
        `memory-hybrid: recall degraded (queue depth ${ctx.recallInFlightRef.value} > ${degradationQueueDepth}), using FTS-only + HOT`,
      );
      if (block) return completeStage({ kind: "degraded", prependContext: `${degradedMarker + block}\n\n` });
      return completeStage({ kind: "degraded", prependContext: `${degradedMarker}\n\n` });
    }

    // Procedural memory (skip expensive FTS when injection budget is zero — issue #863)
    setRecallProbePhase("procedures_block");
    const proceduresStartedAt = recallTiming.phaseStarted("procedures_block");
    let procedureBlock = "";
    const procMaxTokens = ctx.cfg.procedures.maxInjectionTokens ?? 0;
    if (ctx.cfg.procedures.enabled && procMaxTokens > 0) {
      const rankedProcs = ctx.factsDb.searchProceduresRanked(
        e.prompt,
        5,
        ctx.cfg.distill?.reinforcementProcedureBoost ?? 0.1,
        scopeFilter,
      );
      const positiveFiltered = rankedProcs.filter((p) => p.procedureType === "positive" && p.relevanceScore > 0.4);
      const negativeUnfiltered = rankedProcs.filter((p) => p.procedureType === "negative");
      const procLines: string[] = [];
      if (positiveFiltered.length > 0) {
        procLines.push("Last time this worked:");
        for (const p of positiveFiltered.slice(0, 3)) {
          try {
            const steps = (JSON.parse(p.recipeJson) as Array<{ tool?: string }>)
              .map((s) => s.tool)
              .filter(Boolean)
              .join(" → ");
            const emoji = p.relevanceScore >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.relevanceScore * 100);
            procLines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = p.relevanceScore >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.relevanceScore * 100);
            procLines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 70)}…`);
          }
        }
      }
      if (negativeUnfiltered.length > 0) {
        procLines.push("⚠️ Known issue (avoid):");
        for (const n of negativeUnfiltered.slice(0, 2)) {
          try {
            const emoji = n.relevanceScore >= 0.7 ? "❌" : "⚠️";
            const confidence = Math.round(n.relevanceScore * 100);
            const steps = (JSON.parse(n.recipeJson) as Array<{ tool?: string }>)
              .map((s) => s.tool)
              .filter(Boolean)
              .join(" → ");
            procLines.push(`- ${emoji} [${confidence}%] ${n.taskPattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = n.relevanceScore >= 0.7 ? "❌" : "⚠️";
            const confidence = Math.round(n.relevanceScore * 100);
            procLines.push(`- ${emoji} [${confidence}%] ${n.taskPattern.slice(0, 70)}…`);
          }
        }
      }
      if (procLines.length > 0) {
        const wrapper = "<relevant-procedures>\n";
        const wrapperEnd = "\n</relevant-procedures>";
        const maxTokens = ctx.cfg.procedures.maxInjectionTokens;
        const lines = [...procLines];
        let block = wrapper + lines.join("\n") + wrapperEnd;
        while (lines.length > 0 && estimateTokens(block) > maxTokens) {
          lines.pop();
          block = lines.length > 0 ? wrapper + lines.join("\n") + wrapperEnd : "";
        }
        procedureBlock = block;
      }
    }
    recallTiming.phaseCompleted("procedures_block", proceduresStartedAt, { injected: procedureBlock.length > 0 });
    await yieldEventLoop();
    if (shouldAbortRecall()) return completeStage(emptyRecallStage());
    const withProcedures = (s: string) => (procedureBlock ? `${procedureBlock}\n${s}` : s);

    // HOT block
    setRecallProbePhase("hot_facts_block");
    const hotFactsStartedAt = recallTiming.phaseStarted("hot_facts_block");
    let hotBlock = "";
    if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.hotMaxTokens > 0) {
      const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
      if (hotResults.length > 0) {
        const hotLines = hotResults
          .map((r) => {
            const cleaned = sanitizePromptInjection(sanitizeRecallFactText(r.entry.summary || r.entry.text));
            if (!cleaned) return "";
            const clipped = `${cleaned.slice(0, 200)}${cleaned.length > 200 ? "…" : ""}`;
            return `- [hot/${r.entry.category}] ${clipped}`;
          })
          .filter(Boolean);
        if (hotLines.length > 0) {
          hotBlock = `<hot-memories>\n${hotLines.join("\n")}\n</hot-memories>\n\n`;
        }
      }
    }
    recallTiming.phaseCompleted("hot_facts_block", hotFactsStartedAt, { injected: hotBlock.length > 0 });

    await yieldEventLoop();
    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    const recallOpts = {
      tierFilter,
      scopeFilter,
      reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
      diversityWeight: ctx.cfg.reinforcement?.diversityWeight ?? 1.0,
      interactiveFtsFastPath: true,
    };
    const hydeUsedRef = { value: false };
    const pipelineDeps: RecallPipelineDeps = {
      factsDb: ctx.factsDb,
      vectorDb: ctx.vectorDb,
      embeddings: ctx.embeddings,
      openai: ctx.openai,
      cfg: {
        queryExpansion: ctx.cfg.queryExpansion,
        retrievalStrategies: ctx.cfg.retrieval.strategies,
        memoryTieringEnabled: ctx.cfg.memoryTiering.enabled,
        recallTiming: ctx.cfg.autoRecall.recallTiming,
        rawCfg: ctx.cfg,
      },
      recallOpts,
      minScore,
      pendingLLMWarnings: ctx.pendingLLMWarnings,
      logger: api.logger,
      registrationGeneration: ctx.registrationGeneration,
    };

    const ambientCfg = ctx.cfg.ambient;
    const sessionScopeKey = resolveSessionKey(e, api) ?? "default";
    const sessionKey = resolveSessionKey(e, api) ?? currentAgentIdRef.value ?? "default";
    if (!ambientSeenFactsMap.has(sessionScopeKey)) {
      ambientSeenFactsMap.set(sessionScopeKey, new SessionSeenFacts());
      ambientLastEmbeddingMap.set(sessionScopeKey, null);
      pruneSessionMaps();
    } else {
      const seenFacts = ambientSeenFactsMap.get(sessionScopeKey)!;
      const lastEmbedding = ambientLastEmbeddingMap.get(sessionScopeKey) ?? null;
      ambientSeenFactsMap.delete(sessionScopeKey);
      ambientLastEmbeddingMap.delete(sessionScopeKey);
      ambientSeenFactsMap.set(sessionScopeKey, seenFacts);
      ambientLastEmbeddingMap.set(sessionScopeKey, lastEmbedding);
    }
    const ambientSeenFacts = ambientSeenFactsMap.get(sessionScopeKey)!;
    const ambientLastEmbedding = ambientLastEmbeddingMap.get(sessionScopeKey) ?? null;

    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    let promptEmbedding: number[] | null = null;
    setRecallProbePhase("prompt_embedding");
    if (
      interactivePolicy.allowAmbientMultiQuery &&
      ambientCfg.enabled &&
      ambientCfg.multiQuery &&
      ctx.cfg.retrieval.strategies.includes("semantic")
    ) {
      try {
        promptEmbedding = await ctx.embeddings.embed(e.prompt);
      } catch {
        // Non-fatal
      }
    }

    if (shouldAbortRecall()) {
      return completeStage(emptyRecallStage());
    }

    setRecallProbePhase("main_pipeline");
    const mainPipelineStartedAt = recallTiming.phaseStarted("main_pipeline");
    let candidates = await runRecallPipelineQuery(e.prompt, limit, pipelineDeps, hydeUsedRef, {
      probeId: `${recallProbeId}:main`,
      hydeLabel: "HyDE",
      errorPrefix: "auto-recall-",
      precomputedVector: promptEmbedding ?? undefined,
      policy: interactivePolicy,
      timingSpan: recallSpan,
      timingOp: "auto-recall-main",
    });
    recallTiming.phaseCompleted("main_pipeline", mainPipelineStartedAt, { candidates: candidates.length });

    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    if (interactivePolicy.allowAmbientMultiQuery && ambientCfg.enabled && ambientCfg.multiQuery) {
      setRecallProbePhase("ambient_multi_query");
      const ambientStartedAt = recallTiming.phaseStarted("ambient_multi_query");
      let ambientQueriesRun = 0;
      try {
        const isTopicShift =
          ambientLastEmbedding !== null &&
          promptEmbedding !== null &&
          detectTopicShift(ambientLastEmbedding, promptEmbedding, ambientCfg.topicShiftThreshold ?? 0.15);
        if (isTopicShift) api.logger.info?.("memory-hybrid: topic shift detected — re-running ambient retrieval");
        if (promptEmbedding !== null) ambientLastEmbeddingMap.set(sessionScopeKey, promptEmbedding);
        const knownEntities = ctx.factsDb.getKnownEntities ? ctx.factsDb.getKnownEntities() : [];
        const ambientSessionKey = resolveSessionKey(e, api);
        const ambientQueries = generateAmbientQueries(
          e.prompt,
          ambientCfg,
          { userId: api.context?.userId, channelId: ambientSessionKey ?? undefined, nowMs: Date.now() },
          knownEntities,
        );
        const extraQueries = ambientQueries.filter((q) => q.type !== "message");
        if (extraQueries.length > 0) {
          const extraResultSets: SearchResult[][] = [candidates];
          for (const q of extraQueries) {
            if (shouldAbortRecall()) {
              recallTiming.phaseCompleted("ambient_multi_query", ambientStartedAt, {
                status: "aborted",
                queries_run: ambientQueriesRun,
              });
              return completeStage(emptyRecallStage());
            }
            await yieldEventLoop();
            try {
              const qResults = await runRecallPipelineQuery(q.text, Math.ceil(limit / 2), pipelineDeps, hydeUsedRef, {
                probeId: `${recallProbeId}:ambient:${q.type}:${ambientQueriesRun + 1}`,
                entity: q.type === "entity" ? q.entity : undefined,
                hydeLabel: "HyDE",
                errorPrefix: `ambient-${q.type}-`,
                limitHydeOnce: true,
                policy: interactivePolicy,
                timingSpan: recallSpan,
                timingOp: `auto-recall-ambient-${q.type}`,
              });
              ambientQueriesRun += 1;
              extraResultSets.push(qResults);
            } catch (err) {
              if (
                !suppressStaleLifecycleDbError(
                  ctx,
                  err,
                  api.logger,
                  `memory-hybrid: ambient query skipped (registration superseded) type=${q.type}`,
                )
              ) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: `ambient-query-${q.type}`,
                  subsystem: "auto-recall",
                });
              }
            }
          }
          const merged = deduplicateResultsById(extraResultSets, (r) => r.entry.id);
          const filtered = isTopicShift ? merged.filter((r) => !ambientSeenFacts.hasBeenSeen(r.entry.id)) : merged;
          candidates = filtered.slice(0, limit);
        }
        recallTiming.phaseCompleted("ambient_multi_query", ambientStartedAt, {
          status: "ok",
          queries_run: ambientQueriesRun,
          candidates: candidates.length,
        });
      } catch (err) {
        if (
          !suppressStaleLifecycleDbError(
            ctx,
            err,
            api.logger,
            "memory-hybrid: ambient multi-query skipped (registration superseded)",
          )
        ) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "ambient-multi-query",
            subsystem: "auto-recall",
          });
          api.logger.warn?.(`memory-hybrid: ambient multi-query failed, continuing with main recall: ${err}`);
        }
        recallTiming.phaseCompleted("ambient_multi_query", ambientStartedAt, {
          status: "error",
          queries_run: ambientQueriesRun,
        });
      }
    }

    let issueBlock = "";
    let narrativeBlock = "";
    setRecallProbePhase("issues_block");
    const issuesStartedAt = recallTiming.phaseStarted("issues_block");
    if (ambientCfg.enabled && ctx.issueStore) {
      try {
        const issueResults = searchAmbientIssues(e.prompt, ctx.issueStore);
        if (issueResults.openIssues.length > 0 || issueResults.resolvedIssues.length > 0) {
          const issueLines: string[] = [];
          if (issueResults.openIssues.length > 0) {
            issueLines.push("<known-issues>");
            for (const issue of issueResults.openIssues) {
              const sanitizedTitle = sanitizePromptInjection(issue.title);
              issueLines.push(`- [${issue.severity}] ${sanitizedTitle} (status: ${issue.status})`);
            }
            issueLines.push("</known-issues>");
          }
          if (issueResults.resolvedIssues.length > 0) {
            issueLines.push("<resolved-issues>");
            for (const issue of issueResults.resolvedIssues) {
              const sanitizedTitle = sanitizePromptInjection(issue.title);
              const resolution = issue.fix ? ` — Fix: ${sanitizePromptInjection(issue.fix).slice(0, 100)}` : "";
              issueLines.push(`- [${issue.severity}] ${sanitizedTitle}${resolution}`);
            }
            issueLines.push("</resolved-issues>");
          }
          if (issueLines.length > 0) issueBlock = `${issueLines.join("\n")}\n\n`;
        }
      } catch (err) {
        if (
          !suppressStaleLifecycleDbError(
            ctx,
            err,
            api.logger,
            "memory-hybrid: ambient issue retrieval skipped (registration superseded)",
          )
        ) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "ambient-issue-retrieval",
            subsystem: "auto-recall",
          });
        }
      }
    }
    recallTiming.phaseCompleted("issues_block", issuesStartedAt, { injected: issueBlock.length > 0 });

    setRecallProbePhase("narrative_block");
    const narrativeStartedAt = recallTiming.phaseStarted("narrative_block");
    if (ctx.narrativesDb || ctx.eventLog) {
      try {
        const recentNarratives = recallNarrativeSummaries({
          narrativesDb: ctx.narrativesDb,
          eventLog: ctx.eventLog,
          query: e.prompt,
          limit: 2,
        });
        if (recentNarratives.length > 0) {
          const lines = recentNarratives.map((n) => {
            const sanitized = sanitizePromptInjection(n.text);
            const clipped = clipNarrativeText(sanitized);
            return `- [${n.source}/${formatNarrativeRange(n.periodStart, n.periodEnd)}] (sessionKey: ${n.sessionId})\n${clipped}`;
          });
          narrativeBlock = `<recent-history-narratives>\n${lines.join("\n")}\n</recent-history-narratives>\n\n`;
        }
      } catch (err) {
        if (
          !suppressStaleLifecycleDbError(
            ctx,
            err,
            api.logger,
            "memory-hybrid: recent narrative retrieval skipped (registration superseded)",
          )
        ) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "recent-narrative-retrieval",
            subsystem: "auto-recall",
          });
        }
      }
    }
    recallTiming.phaseCompleted("narrative_block", narrativeStartedAt, { injected: narrativeBlock.length > 0 });

    await yieldEventLoop();
    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    const promptLower = e.prompt.toLowerCase();
    const { entityLookup } = ctx.cfg.autoRecall;
    setRecallProbePhase("entity_lookup");
    const entityLookupStartedAt = recallTiming.phaseStarted("entity_lookup");
    let entityLookupHits = 0;
    if (entityLookup.enabled) {
      const entityLookupNames = resolveEntityLookupNames(entityLookup, ctx.factsDb);
      if (entityLookupNames.length > 0) {
        const seenIds = new Set(candidates.map((c) => c.entry.id));
        for (const entity of entityLookupNames) {
          if (!promptLower.includes(entity.toLowerCase())) continue;
          const entityResults = ctx.factsDb
            .lookup(entity, undefined, undefined, { scopeFilter })
            .slice(0, entityLookup.maxFactsPerEntity);
          for (const r of entityResults) {
            if (!seenIds.has(r.entry.id)) {
              seenIds.add(r.entry.id);
              candidates.push(r);
              entityLookupHits += 1;
            }
          }
        }
        candidates.sort((a, b) => {
          const s = b.score - a.score;
          if (s !== 0) return s;
          const da = a.entry.sourceDate ?? a.entry.createdAt;
          const db = b.entry.sourceDate ?? b.entry.createdAt;
          return db - da;
        });
        candidates = candidates.slice(0, limit);
      }
    }
    recallTiming.phaseCompleted("entity_lookup", entityLookupStartedAt, {
      hits: entityLookupHits,
      candidates: candidates.length,
    });

    const directivesCfg = ctx.cfg.autoRecall.retrievalDirectives;
    const directiveLimit = directivesCfg.limit;
    const maxDirectiveCalls = directivesCfg.maxPerPrompt;
    const maxDirectiveCandidates = limit + directiveLimit * maxDirectiveCalls;
    const directiveSeenIds = new Set(candidates.map((c) => c.entry.id));
    const directivePriorityIds = new Set<string>();
    const directiveMatches: string[] = [];
    let directiveCalls = 0;

    function addDirectiveResults(results: SearchResult[], label: string): void {
      let addedAny = false;
      for (const r of results) {
        if (directiveSeenIds.has(r.entry.id)) continue;
        directiveSeenIds.add(r.entry.id);
        directivePriorityIds.add(r.entry.id);
        candidates.push(r);
        addedAny = true;
      }
      if (addedAny) directiveMatches.push(label);
    }
    function canRunDirective(): boolean {
      return directiveCalls < maxDirectiveCalls && candidates.length < maxDirectiveCandidates;
    }

    setRecallProbePhase("directives_loop");
    const directivesStartedAt = recallTiming.phaseStarted("directives_loop");
    const abortDirectives = () => {
      recallTiming.phaseCompleted("directives_loop", directivesStartedAt, {
        enabled: directivesCfg.enabled,
        calls: directiveCalls,
        matches: directiveMatches.length,
        candidates: candidates.length,
        aborted: true,
      });
      return completeStage(emptyRecallStage());
    };
    if (directivesCfg.enabled) {
      try {
        if (recallAborted(signal) || isRecallContextSuperseded(ctx)) {
          return abortDirectives();
        }
        if (directivesCfg.entityMentioned && entityLookup.enabled) {
          const entityLookupNames = resolveEntityLookupNames(entityLookup, ctx.factsDb);
          if (entityLookupNames.length > 0) {
            for (const entity of entityLookupNames) {
              if (recallAborted(signal) || isRecallContextSuperseded(ctx)) {
                return abortDirectives();
              }
              if (!promptLower.includes(entity.toLowerCase())) continue;
              if (!canRunDirective()) break;
              const results = await runRecallPipelineQuery(entity, directiveLimit, pipelineDeps, hydeUsedRef, {
                probeId: `${recallProbeId}:directive:entity:${entity}`,
                entity,
                hydeLabel: "HyDE",
                errorPrefix: "directive-",
                limitHydeOnce: true,
                policy: interactivePolicy,
                timingSpan: recallSpan,
                timingOp: "auto-recall-directive-entity",
              });
              directiveCalls += 1;
              addDirectiveResults(results, `entity:${entity}`);
            }
          }
        }
        if (directivesCfg.keywords.length > 0) {
          for (const keyword of directivesCfg.keywords) {
            if (recallAborted(signal) || isRecallContextSuperseded(ctx)) {
              return abortDirectives();
            }
            if (!promptLower.includes(keyword.toLowerCase())) continue;
            if (!canRunDirective()) break;
            const results = await runRecallPipelineQuery(keyword, directiveLimit, pipelineDeps, hydeUsedRef, {
              probeId: `${recallProbeId}:directive:keyword:${keyword}`,
              hydeLabel: "HyDE",
              errorPrefix: "directive-",
              limitHydeOnce: true,
              policy: interactivePolicy,
              timingSpan: recallSpan,
              timingOp: "auto-recall-directive-keyword",
            });
            directiveCalls += 1;
            addDirectiveResults(results, `keyword:${keyword}`);
          }
        }
        for (const [taskType, triggers] of Object.entries(directivesCfg.taskTypes)) {
          if (recallAborted(signal) || isRecallContextSuperseded(ctx)) {
            return abortDirectives();
          }
          const hit = triggers.some((t) => promptLower.includes(t.toLowerCase()));
          if (!hit || !canRunDirective()) continue;
          const results = await runRecallPipelineQuery(taskType, directiveLimit, pipelineDeps, hydeUsedRef, {
            probeId: `${recallProbeId}:directive:task:${taskType}`,
            hydeLabel: "HyDE",
            errorPrefix: "directive-",
            limitHydeOnce: true,
            policy: interactivePolicy,
            timingSpan: recallSpan,
            timingOp: "auto-recall-directive-task-type",
          });
          directiveCalls += 1;
          addDirectiveResults(results, `taskType:${taskType}`);
        }
        if (directivesCfg.sessionStart) {
          if (recallAborted(signal) || isRecallContextSuperseded(ctx)) {
            return abortDirectives();
          }
          if (!sessionStartSeen.has(sessionKey) && canRunDirective()) {
            const results = await runRecallPipelineQuery("session start", directiveLimit, pipelineDeps, hydeUsedRef, {
              probeId: `${recallProbeId}:directive:session-start`,
              hydeLabel: "HyDE",
              errorPrefix: "directive-",
              limitHydeOnce: true,
              policy: interactivePolicy,
              timingSpan: recallSpan,
              timingOp: "auto-recall-directive-session-start",
            });
            directiveCalls += 1;
            addDirectiveResults(results, "sessionStart");
            sessionStartSeen.add(sessionKey);
          }
        }
      } catch (err) {
        if (
          suppressStaleLifecycleDbError(
            ctx,
            err,
            api.logger,
            "memory-hybrid: directive recall skipped (registration superseded)",
          )
        ) {
          return abortDirectives();
        }
        if (isRecallContextSuperseded(ctx)) {
          api.logger.debug?.("memory-hybrid: directive recall skipped (registration superseded)");
          return abortDirectives();
        }
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "directive-recall",
          subsystem: "auto-recall",
        });
      }
    }
    recallTiming.phaseCompleted("directives_loop", directivesStartedAt, {
      enabled: directivesCfg.enabled,
      calls: directiveCalls,
      matches: directiveMatches.length,
      candidates: candidates.length,
    });

    if (directiveMatches.length > 0) {
      candidates = candidates.map((r) => (directivePriorityIds.has(r.entry.id) ? { ...r, score: r.score * 1.25 } : r));
      candidates.sort((a, b) => {
        const s = b.score - a.score;
        if (s !== 0) return s;
        const da = a.entry.sourceDate ?? a.entry.createdAt;
        const db = b.entry.sourceDate ?? b.entry.createdAt;
        return db - da;
      });
      candidates = candidates.slice(0, limit);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const NINETY_DAYS_SEC = 90 * 24 * 3600;
    const boosted = candidates.map((r) => {
      let s = r.score;
      if (ctx.cfg.autoRecall.preferLongTerm && !isConsolidatedDerivedFact(r.entry)) {
        s *= r.entry.decayClass === "permanent" ? 1.2 : r.entry.decayClass === "stable" ? 1.1 : 1;
      }
      if (ctx.cfg.autoRecall.useImportanceRecency) {
        const importanceFactor = 0.7 + 0.3 * r.entry.importance;
        const recencyFactor =
          r.entry.lastConfirmedAt === 0
            ? 1
            : 0.8 + 0.2 * Math.max(0, 1 - (nowSec - r.entry.lastConfirmedAt) / NINETY_DAYS_SEC);
        s *= importanceFactor * recencyFactor;
      }
      const recallCount = r.entry.recallCount ?? 0;
      if (recallCount > 0) s *= 1 + 0.1 * Math.log(recallCount + 1);
      return { ...r, score: s };
    });
    boosted.sort((a, b) => b.score - a.score);
    candidates = boosted;

    const {
      maxPerMemoryChars,
      useSummaryInInjection,
      summarizeWhenOverBudget,
      summarizeModel,
      progressiveIndexMaxTokens,
      progressiveGroupByCategory,
      progressivePinnedRecallCount,
      hotMaxTokens: hotBlockCapCfg,
      narrativeMaxTokens: narrativeBlockCapCfg,
      procedureMaxTokens: procedureBlockCapCfg,
      activeTaskMaxTokens: activeTaskReserveCapCfg,
      staleWarningMaxTokens: staleWarningReserveCapCfg,
    } = ctx.cfg.autoRecall;
    // Enforce retrieval.ambientBudgetTokens as a hard total-token cap (#581).
    // autoRecall.maxTokens is a user preference; ambientBudgetTokens is the architectural
    // ceiling — the injected context must not exceed either.
    const totalBudget = interactivePolicy.contextBudgetTokens;
    const issueCapTokens = Math.max(80, Math.floor(totalBudget * 0.15));
    const narrativeCapTokens =
      narrativeBlockCapCfg ?? (narrativeBlock.length > 0 ? Math.max(100, Math.floor(totalBudget * 0.2)) : 0);
    const hotCapTokens = hotBlockCapCfg ?? (hotBlock.length > 0 ? Math.max(100, Math.floor(totalBudget * 0.25)) : 0);
    const defaultProcedureCap = procedureBlock.length > 0 ? Math.max(100, Math.floor(totalBudget * 0.2)) : 0;
    const procedureCapTokens =
      procedureBlockCapCfg ??
      (ctx.cfg.procedures.enabled
        ? Math.min(ctx.cfg.procedures.maxInjectionTokens ?? defaultProcedureCap, defaultProcedureCap)
        : 0);
    const defaultActiveTaskReserve =
      ctx.cfg.activeTask.enabled && ctx.cfg.activeTask.injectionBudget > 0
        ? Math.min(ctx.cfg.activeTask.injectionBudget, Math.max(80, Math.floor(totalBudget * 0.2)))
        : 0;
    const activeTaskReserveTokens = activeTaskReserveCapCfg ?? defaultActiveTaskReserve;
    const staleWarningReserveTokens =
      staleWarningReserveCapCfg ??
      (ctx.cfg.activeTask.enabled && ctx.cfg.activeTask.staleWarning?.enabled
        ? Math.max(40, Math.floor(totalBudget * 0.08))
        : 0);

    const budgetState: BudgetState = {
      remainingBudget: totalBudget,
      audit: [],
    };

    issueBlock = capAndTrackBlock("issue", issueBlock, issueCapTokens, budgetState);
    narrativeBlock = capAndTrackBlock("narrative", narrativeBlock, narrativeCapTokens, budgetState);
    hotBlock = capAndTrackBlock("hot", hotBlock, hotCapTokens, budgetState);
    procedureBlock = capAndTrackBlock("procedure", procedureBlock, procedureCapTokens, budgetState);
    reserveAndTrackBlock("active-task", activeTaskReserveTokens, ctx.cfg.activeTask.enabled, budgetState);
    reserveAndTrackBlock(
      "stale-warning",
      staleWarningReserveTokens,
      ctx.cfg.activeTask.enabled && (ctx.cfg.activeTask.staleWarning?.enabled ?? false),
      budgetState,
    );

    const fixedBlocksTokens = totalBudget - budgetState.remainingBudget;
    const maxTokens = Math.max(0, budgetState.remainingBudget);
    const blockSummary = budgetState.audit
      .map((b) => `${b.block}:${b.injectedTokens}/${b.capTokens}${b.reserved ? "r" : ""}${b.truncated ? "!" : ""}`)
      .join(", ");
    if (ctx.cfg.autoRecall.recallTiming === "basic" || ctx.cfg.autoRecall.recallTiming === "verbose") {
      api.logger.info?.(
        `memory-hybrid: context-audit fixed=${fixedBlocksTokens}/${totalBudget} recall=${maxTokens} blocks=[${blockSummary}]`,
      );
    }
    ctx.auditStore?.append({
      agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? "unknown",
      action: "recall:context-budget",
      outcome: maxTokens === 0 ? "partial" : "success",
      sessionId: sessionKey,
      tokens: fixedBlocksTokens,
      context: {
        totalBudget,
        recallBudget: maxTokens,
        blocks: budgetState.audit,
      },
    });

    if (maxTokens === 0) {
      const consumers = budgetState.audit
        .filter((b) => b.injectedTokens > 0)
        .sort((a, b) => b.injectedTokens - a.injectedTokens)
        .slice(0, 4)
        .map((b) => `${b.block}:${b.injectedTokens}`)
        .join(", ");
      api.logger.warn?.(
        `memory-hybrid: fixed blocks exhausted budget (${fixedBlocksTokens}/${totalBudget} tokens); recall suppressed (consumers: ${consumers || "none"})`,
      );
    }

    if (candidates.length === 0) {
      ctx.auditStore?.append({
        agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? "unknown",
        action: "recall:empty",
        outcome: "partial",
        sessionId: sessionKey,
        context: {
          issueBlockInjected: issueBlock.length > 0,
          narrativeBlockInjected: narrativeBlock.length > 0,
          hotBlockInjected: hotBlock.length > 0,
          fixedBlocks: budgetState.audit,
        },
      });
      const combinedContext = issueBlock + narrativeBlock + hotBlock + procedureBlock;
      return completeStage({ kind: "empty", prependContext: combinedContext || undefined });
    }
    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    setRecallProbePhase("finalize");
    const indexCap = Math.min(progressiveIndexMaxTokens ?? maxTokens, maxTokens);
    const groupByCategory = progressiveGroupByCategory === true;
    const pinnedRecallThreshold = progressivePinnedRecallCount ?? 3;

    if (isRecallContextSuperseded(ctx)) {
      return completeStage(emptyRecallStage());
    }

    const result: RecallResult = {
      candidates,
      issueBlock,
      narrativeBlock,
      hotBlock,
      procedureBlock,
      withProcedures,
      recallSpan,
      recallStartMs,
      degradationMaxLatencyMs,
      injectionFormat: fmt,
      maxTokens,
      maxPerMemoryChars,
      useSummaryInInjection,
      indexCap,
      summarizeWhenOverBudget,
      summarizeModel,
      groupByCategory,
      pinnedRecallThreshold,
      lastProgressiveIndexIdsRef: ctx.lastProgressiveIndexIds,
      ambientCfg: { enabled: ambientCfg.enabled, multiQuery: ambientCfg.multiQuery },
      ambientSeenFacts: ambientCfg.enabled && ambientCfg.multiQuery ? ambientSeenFacts : null,
    };
    return completeStage({ kind: "full", result });
  } catch (err) {
    if (isRecallContextSuperseded(ctx)) {
      api.logger.debug?.(
        `memory-hybrid: recall-probe id=${recallProbeId} skipped (registration superseded) elapsedMs=${Date.now() - recallStartMs} phase=${recallProbePhase}`,
      );
      return completeStage(emptyRecallStage());
    }
    if (!recallStageCompleted) {
      recallTiming.phaseCompleted("recall_stage_run", recallStageStartedAt, {
        ...(recallStageFields ?? {}),
        status: "error",
      });
      recallStageCompleted = true;
    }
    api.logger.warn?.(
      `memory-hybrid: recall-probe id=${recallProbeId} error elapsedMs=${Date.now() - recallStartMs} phase=${recallProbePhase} error=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  } finally {
    ctx.recallInFlightRef.value--;
    clearRecallProbeWatchdog();
    api.logger.debug?.(
      `memory-hybrid: recall-probe id=${recallProbeId} exit elapsedMs=${Date.now() - recallStartMs} phase=${recallProbePhase} completed=${recallStageCompleted}`,
    );
  }
}
