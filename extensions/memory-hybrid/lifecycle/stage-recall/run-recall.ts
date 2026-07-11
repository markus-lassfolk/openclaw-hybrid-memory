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
import { loadKnownEntitySurfaces, matchEntitySurfacesInText } from "../../services/entity-retrieval.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { expandGraph } from "../../services/graph-retrieval.js";
import { formatNarrativeRange, recallNarrativeSummaries } from "../../services/narrative-recall.js";
import { type RecallPipelineDeps, runRecallPipelineQuery } from "../../services/recall-pipeline.js";
import { mergeSearchResultsByBestScore } from "../../services/merge-results.js";
import { createRecallSpan, createRecallTimingLogger } from "../../services/recall-timing.js";
import { filterCandidatesByInteractiveGrading } from "../../services/interactive-recall-grader.js";
import {
  consumePrependBudget,
  getRemainingPrependTokens,
  initPrependBudgetWithInjectorReserve,
} from "../../services/prepend-budget.js";
import {
  assembleRecallPrependContext,
  edictMaxTokensForBudget,
  edictMaxTokensFromPrependBudget,
  promptMentionsEntity,
  sanitizeProcedureText,
} from "../../services/recalled-context-assembler.js";
import { resolveInteractiveRecallPolicy } from "../../services/retrieval-mode-policy.js";
import { applyRetrievalV2, DEFAULT_RETRIEVAL_V2_CONFIG } from "../../services/retrieval-v2.js";
import { applyFragmentRecallPostProcess } from "../../services/fragment-recall.js";
import { recordIntentDistribution } from "../../services/recall-timing-stats.js";
import { getFocusTopic } from "../../services/focus-topic.js";
import { sanitizePromptInjection } from "../../services/skill-prompt-injection.js";
import type { ScopeFilter } from "../../types/memory.js";
import type { SearchResult } from "../../types/memory.js";
import { isConsolidatedDerivedFact } from "../../utils/consolidation-controls.js";
import { isTierAllowedForWarmSearch } from "../../utils/tier-filter.js";
import { resolveEntityLookupNames } from "../../utils/entity-lookup-resolve.js";
import { resolveAgentIdFromHookEvent } from "../resolve-agent-id.js";
import { raceWithAbortSignal } from "../../utils/signal-race.js";
import { yieldEventLoop } from "../../utils/event-loop-yield.js";
import { isRecallContextSuperseded, suppressStaleLifecycleDbError } from "../../utils/registration-superseded.js";
import { estimateTokens, sanitizeRecallFactText } from "../../utils/text.js";
import type { LifecycleContext, RecallResult, RecallStageResult, SessionState } from "../types.js";
import { isStaleLifecycleGeneration } from "../../utils/lifecycle-generation.js";
import {
  buildDegradedFtsHotRecallStage,
  buildFixedBlocksRecallStage,
  resolveRecallScopeFilter,
} from "./degraded-recall.js";

function finishEmptyRecallPrepend(ctx: LifecycleContext, combinedContext: string): RecallStageResult {
  const trimmed = combinedContext.trim();
  if (!trimmed) return { kind: "empty", prependContext: undefined };
  const total = ctx.prependBudgetRef?.value?.totalTokens ?? 0;
  const remaining = getRemainingPrependTokens(ctx.prependBudgetRef);
  const edictCap =
    remaining !== undefined
      ? Math.min(edictMaxTokensForBudget(total), remaining)
      : (edictMaxTokensFromPrependBudget(ctx) ?? 0);
  const innerCap = remaining !== undefined ? Math.max(0, remaining - edictCap) : undefined;
  const inner = innerCap !== undefined ? trimBlockToBudget(trimmed, innerCap).text : trimmed;
  const prepend = assembleRecallPrependContext(ctx, inner, {
    edictMaxTokens: edictCap,
  });
  if (prepend) consumePrependBudget(ctx.prependBudgetRef, prepend);
  return { kind: "empty", prependContext: prepend ?? undefined };
}

function finishPartialFixedBlocksRecall(
  ctx: LifecycleContext,
  issueBlock: string,
  narrativeBlock: string,
  hotBlock: string,
  procedureBlock: string,
): RecallStageResult {
  return finishEmptyRecallPrepend(ctx, issueBlock + narrativeBlock + hotBlock + procedureBlock);
}

function emptyRecallStage(): RecallStageResult {
  return { kind: "empty", prependContext: undefined };
}

function recallAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isLifecycleSqliteShutdownError(err: unknown, ctx: LifecycleContext): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!/not open|connection is not open|database is not open/i.test(message)) {
    return false;
  }
  // Only suppress if the database is closed AND the generation is stale
  // If the generation is current but the DB is closed, it's a real error that should be reported
  if (typeof ctx.factsDb.isOpen === "function" && !ctx.factsDb.isOpen()) {
    return isStaleLifecycleGeneration(ctx);
  }
  return isStaleLifecycleGeneration(ctx);
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
  if (!e.prompt) {
    return { kind: "empty", prependContext: undefined };
  }
  if (e.prompt.length < 5) {
    ctx.recallInFlightRef.value++;
    try {
      return await buildFixedBlocksRecallStage(event, api, ctx, sessionState);
    } finally {
      ctx.recallInFlightRef.value--;
    }
  }
  const promptText = e.prompt;

  if (isRecallContextSuperseded(ctx)) {
    return emptyRecallStage();
  }
  const shouldAbortRecall = (): boolean => recallAborted(signal) || isRecallContextSuperseded(ctx);
  const suppressSupersededRecallError = (err: unknown, debugMessage: string): boolean => {
    if (isRecallContextSuperseded(ctx) || isLifecycleSqliteShutdownError(err, ctx)) {
      api.logger.debug?.(debugMessage);
      return true;
    }
    return suppressStaleLifecycleDbError(ctx, err, api.logger, debugMessage);
  };

  // Global ref supports plugin drain/shutdown; per-session recallInFlightBySession drives degradation.
  const trackedSessionScopeKey = sessionState.resolveSessionKey(event, api) ?? ctx.currentAgentIdRef.value ?? "default";
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
    // Increment as the first statements inside the try that decrements them in `finally` below —
    // if any of this function's own setup above (createRecallTimingLogger, phaseStarted, watchdog
    // scheduling) throws, neither counter should have incremented in the first place, since a
    // leaked increment here permanently forces every future hot-reload drain to wait the full
    // RECALL_DRAIN_MS and can permanently degrade this session's recall via forceDegraded's
    // sessionInFlight comparison.
    ctx.recallInFlightRef.value++;
    sessionState.recallInFlightBySession.set(
      trackedSessionScopeKey,
      (sessionState.recallInFlightBySession.get(trackedSessionScopeKey) ?? 0) + 1,
    );

    if (shouldAbortRecall()) return completeStage(emptyRecallStage());

    const { currentAgentIdRef } = ctx;
    const {
      resolveSessionKey,
      ambientSeenFactsMap,
      ambientLastEmbeddingMap,
      pruneSessionMaps,
      sessionStartSeen,
      recallInFlightBySession,
    } = sessionState;
    const sessionScopeKey = trackedSessionScopeKey;

    api.logger.debug?.(`memory-hybrid: auto-recall start (prompt length ${e.prompt.length})`);
    api.logger.debug?.(
      `memory-hybrid: recall-probe id=${recallProbeId} enter promptChars=${promptText.length} inFlight=${ctx.recallInFlightRef.value} sessionInFlight=${recallInFlightBySession.get(sessionScopeKey) ?? 0}`,
    );

    if (e.prompt.length >= 5) {
      const trimmedPrompt = e.prompt.trim().slice(0, 12_000);
      ctx.lastAutoRecallPromptBySession?.set(sessionScopeKey, trimmedPrompt);
      if (ctx.lastAutoRecallPromptRef) ctx.lastAutoRecallPromptRef.value = trimmedPrompt;
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

    let scopeFilter: ScopeFilter | undefined = resolveRecallScopeFilter(ctx);

    const interactivePolicy = resolveInteractiveRecallPolicy(
      ctx.cfg.autoRecall,
      ctx.cfg.queryExpansion,
      ctx.cfg.retrieval,
    );
    api.logger.debug?.(
      `memory-hybrid: interactive enrichment=${interactivePolicy.interactiveEnrichment} (HyDE=${interactivePolicy.allowHyde}, ambientMulti=${interactivePolicy.allowAmbientMultiQuery})`,
    );
    const { degradationQueueDepth, degradationMaxLatencyMs } = interactivePolicy;
    const sessionKeyForBudget = sessionScopeKey;
    if (ctx.prependBudgetRef) {
      initPrependBudgetWithInjectorReserve(
        ctx.prependBudgetRef,
        interactivePolicy.contextBudgetTokens,
        sessionKeyForBudget,
      );
    }
    const sessionInFlight = recallInFlightBySession.get(sessionScopeKey) ?? 0;
    const forceDegraded = degradationQueueDepth > 0 && sessionInFlight > degradationQueueDepth;

    if (forceDegraded) {
      setRecallProbePhase("degraded_fts_only");
      await yieldEventLoop();
      if (shouldAbortRecall()) return completeStage(emptyRecallStage());
      api.logger.debug?.(
        `memory-hybrid: recall degraded (session queue depth ${sessionInFlight} > ${degradationQueueDepth}), using FTS-only + HOT`,
      );
      return completeStage(await buildDegradedFtsHotRecallStage(event, api, ctx, sessionState, "queue"));
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
              .map((s) => sanitizeProcedureText(String(s.tool ?? "")))
              .filter(Boolean)
              .join(" → ");
            const emoji = p.relevanceScore >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.relevanceScore * 100);
            const pattern = sanitizeProcedureText(p.taskPattern);
            procLines.push(`- ${emoji} [${confidence}%] ${pattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = p.relevanceScore >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.relevanceScore * 100);
            const pattern = sanitizeProcedureText(p.taskPattern);
            procLines.push(`- ${emoji} [${confidence}%] ${pattern.slice(0, 70)}…`);
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
              .map((s) => sanitizeProcedureText(String(s.tool ?? "")))
              .filter(Boolean)
              .join(" → ");
            const pattern = sanitizeProcedureText(n.taskPattern);
            procLines.push(`- ${emoji} [${confidence}%] ${pattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = n.relevanceScore >= 0.7 ? "❌" : "⚠️";
            const confidence = Math.round(n.relevanceScore * 100);
            const pattern = sanitizeProcedureText(n.taskPattern);
            procLines.push(`- ${emoji} [${confidence}%] ${pattern.slice(0, 70)}…`);
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
    const hotFactIds = new Set<string>();
    if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.hotMaxTokens > 0) {
      const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
      for (const r of hotResults) hotFactIds.add(r.entry.id);
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
      deferAccessRefresh: true,
    };
    const hydeUsedRef = { value: false };
    const bm25BypassedRef = { value: false };
    const bypassCfg = ctx.cfg.retrieval.bypass ?? DEFAULT_RETRIEVAL_V2_CONFIG.bypass;
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
    const vaultHandles =
      ctx.cfg.retrieval.multiVaultFanOut === true && ctx.resolveAllVaults ? ctx.resolveAllVaults() : [];
    const fanOutAutoRecall = vaultHandles.length > 1;
    const recallPipeline = async (
      query: string,
      limitNum: number,
      extra?: Omit<NonNullable<Parameters<typeof runRecallPipelineQuery>[4]>, "stageSignal">,
    ) => {
      if (!fanOutAutoRecall) {
        return runRecallPipelineQuery(query, limitNum, pipelineDeps, hydeUsedRef, { ...extra, stageSignal: signal });
      }
      const perVault = await Promise.all(
        vaultHandles.map((handle) =>
          runRecallPipelineQuery(
            query,
            limitNum,
            {
              ...pipelineDeps,
              factsDb: handle.factsDb,
              vectorDb: handle.vectorDb,
            },
            hydeUsedRef,
            { ...extra, stageSignal: signal },
          ),
        ),
      );
      return mergeSearchResultsByBestScore(perVault.flat()).slice(0, limitNum);
    };

    const ambientCfg = ctx.cfg.ambient;
    const sessionKey = sessionScopeKey;
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
        promptEmbedding = await raceWithAbortSignal(ctx.embeddings.embed(e.prompt), signal, null);
      } catch {
        // Non-fatal
      }
    }

    if (shouldAbortRecall()) {
      return completeStage(emptyRecallStage());
    }

    setRecallProbePhase("main_pipeline");
    const mainPipelineStartedAt = recallTiming.phaseStarted("main_pipeline");
    const pipelineStatusRef = { semanticDegraded: false };
    let skipPostMainRecallEnrichment = false;
    let candidates = await recallPipeline(e.prompt, limit, {
      probeId: `${recallProbeId}:main`,
      hydeLabel: "HyDE",
      errorPrefix: "auto-recall-",
      precomputedVector: promptEmbedding ?? undefined,
      policy: interactivePolicy,
      timingSpan: recallSpan,
      timingOp: "auto-recall-main",
      pipelineStatusRef,
      bypass: bypassCfg,
      bypassedRef: bm25BypassedRef,
    });
    recallTiming.phaseCompleted("main_pipeline", mainPipelineStartedAt, { candidates: candidates.length });

    if (shouldAbortRecall()) {
      if (isRecallContextSuperseded(ctx)) {
        return completeStage(finishPartialFixedBlocksRecall(ctx, "", "", hotBlock, procedureBlock));
      }
      if (candidates.length > 0) {
        skipPostMainRecallEnrichment = true;
      }
    }

    // Associative recall on the hot path (living-memory P3.1): pull 1-hop graph neighbors of the
    // strongest matches into the candidate set (hop-decayed scores), so injected context includes
    // what the memory ASSOCIATES with the topic — not just what embeds like the prompt. Pure
    // SQLite hops, bounded by maxAdds + hubDegreeCap; failures never affect the recall.
    const autoExpandCfg = ctx.cfg.graphRetrieval?.autoRecallExpand;
    if (
      !skipPostMainRecallEnrichment &&
      candidates.length > 0 &&
      ctx.cfg.graph.enabled &&
      ctx.cfg.graphRetrieval?.enabled !== false &&
      autoExpandCfg?.enabled !== false
    ) {
      try {
        const seenIds = new Set(candidates.map((c) => c.entry.id));
        const seeds = candidates.slice(0, 3).map((c) => ({ factId: c.entry.id, score: c.score, entry: c.entry }));
        const { results: expanded } = expandGraph(ctx.factsDb, seeds, {
          maxDepth: 1,
          maxExpandedResults: autoExpandCfg?.maxAdds ?? 5,
          scopeFilter,
          hubDegreeCap: ctx.cfg.graph.hubDegreeCap,
          hubScorePenalty: ctx.cfg.graph.hubScorePenalty,
        });
        for (const ex of expanded) {
          if (ex.expansionSource !== "graph" || seenIds.has(ex.entry.id)) continue;
          // Ambient association follows STRONG meaning-edges only: temporal adjacency
          // (PRECEDED_BY) and weak bonds (< 0.4, e.g. 0.3 session co-occurrence links) would
          // inject whatever happened nearby, not what the memory associates with the topic.
          if (ex.linkPath.some((step) => step.linkType === "PRECEDED_BY" || step.strength < 0.4)) continue;
          seenIds.add(ex.entry.id);
          candidates.push({ entry: ex.entry, score: ex.score, backend: "sqlite" });
        }
      } catch (err) {
        api.logger.warn(`memory-hybrid: auto-recall graph expansion failed: ${err}`);
      }
    }
    if (
      !skipPostMainRecallEnrichment &&
      !bm25BypassedRef.value &&
      interactivePolicy.allowAmbientMultiQuery &&
      ambientCfg.enabled &&
      ambientCfg.multiQuery
    ) {
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
        let mergedKnownEntities = knownEntities;
        if (ctx.cfg.autoRecall.entityLookup?.enabled && typeof ctx.factsDb.getRawDb === "function") {
          try {
            const surfaces = loadKnownEntitySurfaces(ctx.factsDb.getRawDb(), 200);
            const matched = matchEntitySurfacesInText(e.prompt, surfaces);
            if (matched.length > 0) {
              mergedKnownEntities = [...new Set([...knownEntities, ...matched.map((s) => s.key)])];
            }
          } catch {
            /* non-fatal */
          }
        }
        const ambientSessionKey = resolveSessionKey(e, api);
        const ambientQueries = generateAmbientQueries(
          e.prompt,
          ambientCfg,
          { userId: api.context?.userId, channelId: ambientSessionKey ?? undefined, nowMs: Date.now() },
          mergedKnownEntities,
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
              if (isRecallContextSuperseded(ctx)) {
                return completeStage(finishPartialFixedBlocksRecall(ctx, "", "", hotBlock, procedureBlock));
              }
              break;
            }
            await yieldEventLoop();
            try {
              const qResults = await recallPipeline(q.text, Math.ceil(limit / 2), {
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
              const suppressed = suppressSupersededRecallError(
                err,
                `memory-hybrid: ambient query skipped (registration superseded) type=${q.type}`,
              );
              if (suppressed) {
                recallTiming.phaseCompleted("ambient_multi_query", ambientStartedAt, {
                  status: "aborted",
                  queries_run: ambientQueriesRun,
                });
                if (isRecallContextSuperseded(ctx)) {
                  return completeStage(finishPartialFixedBlocksRecall(ctx, "", "", hotBlock, procedureBlock));
                }
                break;
              }
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: `ambient-query-${q.type}`,
                subsystem: "auto-recall",
              });
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
        const suppressed = suppressSupersededRecallError(
          err,
          "memory-hybrid: ambient multi-query skipped (registration superseded)",
        );
        if (suppressed) {
          recallTiming.phaseCompleted("ambient_multi_query", ambientStartedAt, {
            status: "aborted",
            queries_run: ambientQueriesRun,
          });
          if (isRecallContextSuperseded(ctx)) {
            return completeStage(finishPartialFixedBlocksRecall(ctx, "", "", hotBlock, procedureBlock));
          }
        } else {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "ambient-multi-query",
            subsystem: "auto-recall",
          });
          api.logger.warn?.(`memory-hybrid: ambient multi-query failed, continuing with main recall: ${err}`);
          recallTiming.phaseCompleted("ambient_multi_query", ambientStartedAt, {
            status: "error",
            queries_run: ambientQueriesRun,
          });
        }
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
              const severity = sanitizePromptInjection(issue.severity);
              const status = sanitizePromptInjection(issue.status);
              issueLines.push(`- [${severity}] ${sanitizedTitle} (status: ${status})`);
            }
            issueLines.push("</known-issues>");
          }
          if (issueResults.resolvedIssues.length > 0) {
            issueLines.push("<resolved-issues>");
            for (const issue of issueResults.resolvedIssues) {
              const sanitizedTitle = sanitizePromptInjection(issue.title);
              const resolution = issue.fix ? ` — Fix: ${sanitizePromptInjection(issue.fix).slice(0, 100)}` : "";
              const severity = sanitizePromptInjection(issue.severity);
              issueLines.push(`- [${severity}] ${sanitizedTitle}${resolution}`);
            }
            issueLines.push("</resolved-issues>");
          }
          if (issueLines.length > 0) issueBlock = `${issueLines.join("\n")}\n\n`;
        }
      } catch (err) {
        if (
          !suppressSupersededRecallError(
            err,
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
          sessionId: sessionKey,
          limit: 2,
        });
        if (recentNarratives.length > 0) {
          const lines = recentNarratives.map((n) => {
            const sanitized = sanitizePromptInjection(n.text);
            const clipped = clipNarrativeText(sanitized);
            const source = sanitizePromptInjection(n.source);
            const sessionId = sanitizePromptInjection(n.sessionId);
            return `- [${source}/${formatNarrativeRange(n.periodStart, n.periodEnd)}] (sessionKey: ${sessionId})\n${clipped}`;
          });
          narrativeBlock = `<recent-history-narratives>\n${lines.join("\n")}\n</recent-history-narratives>\n\n`;
        }
      } catch (err) {
        if (
          !suppressSupersededRecallError(
            err,
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
    if (isRecallContextSuperseded(ctx)) {
      return completeStage(finishPartialFixedBlocksRecall(ctx, issueBlock, narrativeBlock, hotBlock, procedureBlock));
    }

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
          if (!promptMentionsEntity(e.prompt, entity)) continue;
          const entityResults = ctx.factsDb
            .lookup(entity, undefined, undefined, { scopeFilter, deferAccessRefresh: true })
            .slice(0, entityLookup.maxFactsPerEntity);
          for (const r of entityResults) {
            if (ctx.cfg.memoryTiering.enabled && !isTierAllowedForWarmSearch(r.entry.tier)) continue;
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
      // Preserve fixed blocks that were already built
      const combinedContext = issueBlock + narrativeBlock + hotBlock + procedureBlock;
      return completeStage(finishEmptyRecallPrepend(ctx, combinedContext));
    };
    if (directivesCfg.enabled && !skipPostMainRecallEnrichment) {
      try {
        if (isRecallContextSuperseded(ctx)) {
          return abortDirectives();
        }
        if (directivesCfg.entityMentioned && entityLookup.enabled) {
          const entityLookupNames = resolveEntityLookupNames(entityLookup, ctx.factsDb);
          if (entityLookupNames.length > 0) {
            for (const entity of entityLookupNames) {
              if (isRecallContextSuperseded(ctx)) {
                return abortDirectives();
              }
              if (recallAborted(signal)) break;
              if (!promptMentionsEntity(e.prompt, entity)) continue;
              if (!canRunDirective()) break;
              const results = await recallPipeline(entity, directiveLimit, {
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
            if (isRecallContextSuperseded(ctx)) {
              return abortDirectives();
            }
            if (recallAborted(signal)) break;
            if (!promptLower.includes(keyword.toLowerCase())) continue;
            if (!canRunDirective()) break;
            const results = await recallPipeline(keyword, directiveLimit, {
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
          if (isRecallContextSuperseded(ctx)) {
            return abortDirectives();
          }
          if (recallAborted(signal)) break;
          const hit = triggers.some((t) => promptLower.includes(t.toLowerCase()));
          if (!hit || !canRunDirective()) continue;
          const results = await recallPipeline(taskType, directiveLimit, {
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
          if (isRecallContextSuperseded(ctx)) {
            return abortDirectives();
          }
          if (recallAborted(signal)) {
            // skip session-start directive on stage timeout
          } else if (!sessionStartSeen.has(sessionKey) && canRunDirective()) {
            const results = await recallPipeline("session start", directiveLimit, {
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
            // Living-memory P3.4: the session-start briefing also resurfaces stale-important
            // memories — high-importance facts nothing has touched in 30+ days — so what matters
            // doesn't silently fade just because no prompt happened to embed near it.
            try {
              const staleCutoff = Math.floor(Date.now() / 1000) - 30 * 86_400;
              const staleRows = ctx.factsDb
                .getRawDb()
                .prepare(
                  `SELECT id FROM facts
                    WHERE importance >= 0.7 AND superseded_at IS NULL
                      AND COALESCE(last_accessed, created_at) < ?
                    ORDER BY importance DESC LIMIT 3`,
                )
                .all(staleCutoff) as Array<{ id: string }>;
              const staleResults = staleRows
                .map((row) => ctx.factsDb.getById(row.id, { scopeFilter }))
                .filter((entry): entry is NonNullable<typeof entry> => entry != null)
                .map((entry) => ({ entry, score: 0.5, backend: "sqlite" as const }));
              if (staleResults.length > 0) addDirectiveResults(staleResults, "sessionStart:stale-important");
            } catch {
              /* briefing extras are best-effort */
            }
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
    if (hotFactIds.size > 0) {
      candidates = candidates.filter((r) => !hotFactIds.has(r.entry.id));
    }

    if (!shouldAbortRecall()) {
      candidates = await raceWithAbortSignal(
        filterCandidatesByInteractiveGrading(e.prompt, candidates, ctx.cfg.documentGrading, ctx.openai, { signal }),
        signal,
        candidates,
      );
    }

    // Retrieval v2 post-processing on interactive hot path (#1910).
    if (!shouldAbortRecall() && candidates.length > 0) {
      const retrievalCfg = ctx.cfg.retrieval;
      const v2Config = {
        intentRouter: retrievalCfg.intentRouter ?? DEFAULT_RETRIEVAL_V2_CONFIG.intentRouter,
        compositeScore: {
          version: (retrievalCfg.compositeScore?.v ?? 1) as 1 | 2,
          pinBoostDefault: retrievalCfg.compositeScore?.pinBoostDefault ?? 0.3,
          pinBoostCap: retrievalCfg.compositeScore?.pinBoostCap ?? 1.0,
        },
        diversity: retrievalCfg.diversity ?? DEFAULT_RETRIEVAL_V2_CONFIG.diversity,
        bypass: { enabled: false, bm25MinScore: 0, bm25MinGap: 0 },
      };
      const focusState = getFocusTopic(sessionKey);
      try {
        const getEntry = fanOutAutoRecall
          ? (id: string) => {
              for (const handle of vaultHandles) {
                const entry = handle.factsDb.getById(id);
                if (entry) return entry;
              }
              return ctx.factsDb.getById(id);
            }
          : (id: string) => ctx.factsDb.getById(id);
        const v2 = await applyRetrievalV2({
          query: e.prompt,
          results: candidates,
          ftsResults: candidates,
          getEntry,
          config: v2Config,
          recallId: recallSpan,
          sessionId: sessionKey,
          openai: ctx.openai,
          focusTopic: focusState?.topic,
          factsDb: fanOutAutoRecall ? undefined : ctx.factsDb,
          recordBypassTelemetry: false,
        });
        candidates = v2.results;
        recordIntentDistribution(v2.intent.intent);
        candidates = applyFragmentRecallPostProcess(candidates);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "auto-recall",
          operation: "retrieval-v2",
        });
        api.logger.debug?.(`memory-hybrid: retrieval v2 post-process skipped: ${String(err)}`);
      }
    }

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
      activeTaskMaxTokens: activeTaskBlockCapCfg,
      staleWarningMaxTokens: staleWarningBlockCapCfg,
    } = ctx.cfg.autoRecall;
    // Enforce retrieval.ambientBudgetTokens as a hard total-token cap (#581).
    // autoRecall.maxTokens is a user preference; ambientBudgetTokens is the architectural
    // ceiling — the injected context must not exceed either.
    const totalBudget = interactivePolicy.contextBudgetTokens;
    const issueCapTokens =
      totalBudget < 80 ? Math.max(0, Math.floor(totalBudget * 0.15)) : Math.max(80, Math.floor(totalBudget * 0.15));
    const narrativeCapTokens =
      narrativeBlockCapCfg ?? (narrativeBlock.length > 0 ? Math.max(100, Math.floor(totalBudget * 0.2)) : 0);
    const hotCapTokens = hotBlockCapCfg ?? (hotBlock.length > 0 ? Math.max(100, Math.floor(totalBudget * 0.25)) : 0);
    const defaultProcedureCap = procedureBlock.length > 0 ? Math.max(100, Math.floor(totalBudget * 0.2)) : 0;
    const procedureCapTokens =
      procedureBlockCapCfg ??
      (ctx.cfg.procedures.enabled
        ? Math.min(ctx.cfg.procedures.maxInjectionTokens ?? defaultProcedureCap, defaultProcedureCap)
        : 0);
    const edictReserve = edictMaxTokensForBudget(totalBudget);
    const budgetState: BudgetState = {
      remainingBudget: Math.max(0, totalBudget - edictReserve),
      audit: [],
    };

    issueBlock = capAndTrackBlock("issue", issueBlock, issueCapTokens, budgetState);
    narrativeBlock = capAndTrackBlock("narrative", narrativeBlock, narrativeCapTokens, budgetState);
    hotBlock = capAndTrackBlock("hot", hotBlock, hotCapTokens, budgetState);
    procedureBlock = capAndTrackBlock("procedure", procedureBlock, procedureCapTokens, budgetState);

    const activeTaskReserveCap = ctx.cfg.activeTask.enabled
      ? (activeTaskBlockCapCfg ??
        Math.min(ctx.cfg.activeTask.injectionBudget, Math.max(80, Math.floor(totalBudget * 0.2))))
      : 0;
    const staleWarningReserveCap =
      ctx.cfg.activeTask.enabled && ctx.cfg.activeTask.staleWarning.enabled
        ? (staleWarningBlockCapCfg ?? Math.max(40, Math.floor(totalBudget * 0.08)))
        : 0;
    reserveAndTrackBlock("activeTask", activeTaskReserveCap, activeTaskReserveCap > 0, budgetState);
    reserveAndTrackBlock("staleWarning", staleWarningReserveCap, staleWarningReserveCap > 0, budgetState);

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
      return completeStage(finishEmptyRecallPrepend(ctx, combinedContext));
    }
    if (shouldAbortRecall()) {
      const combinedContext = issueBlock + narrativeBlock + hotBlock + procedureBlock;
      if (candidates.length > 0 && !isRecallContextSuperseded(ctx)) {
        // Abort after main pipeline: keep partial recall, skip ambient/enrichment only.
      } else {
        return completeStage(finishEmptyRecallPrepend(ctx, combinedContext));
      }
    }

    setRecallProbePhase("finalize");
    const indexCap = Math.min(progressiveIndexMaxTokens ?? maxTokens, maxTokens);
    const groupByCategory = progressiveGroupByCategory === true;
    const pinnedRecallThreshold = progressivePinnedRecallCount ?? 3;

    if (isRecallContextSuperseded(ctx)) {
      const combinedContext = issueBlock + narrativeBlock + hotBlock + procedureBlock;
      return completeStage(finishEmptyRecallPrepend(ctx, combinedContext));
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
      progressiveIndexSessionKey: sessionKey,
      progressiveIndexBySession: ctx.progressiveIndexBySession,
      ambientCfg: { enabled: ambientCfg.enabled, multiQuery: ambientCfg.multiQuery },
      ambientSeenFacts: ambientCfg.enabled && ambientCfg.multiQuery ? ambientSeenFacts : null,
      semanticDegraded: pipelineStatusRef.semanticDegraded,
      totalBudget,
    };
    return completeStage({ kind: "full", result });
  } catch (err) {
    if (isRecallContextSuperseded(ctx)) {
      setRecallProbePhase("skip:superseded");
      api.logger.debug?.(
        `memory-hybrid: recall-probe id=${recallProbeId} skipped (registration superseded) elapsedMs=${Date.now() - recallStartMs} phase=${recallProbePhase}`,
      );
      return completeStage(emptyRecallStage());
    }
    if (isLifecycleSqliteShutdownError(err, ctx)) {
      setRecallProbePhase("skip:shutdown");
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
    const sessionCount = sessionState.recallInFlightBySession.get(trackedSessionScopeKey) ?? 1;
    if (sessionCount <= 1) sessionState.recallInFlightBySession.delete(trackedSessionScopeKey);
    else sessionState.recallInFlightBySession.set(trackedSessionScopeKey, sessionCount - 1);
    clearRecallProbeWatchdog();
    api.logger.debug?.(
      `memory-hybrid: recall-probe id=${recallProbeId} exit elapsedMs=${Date.now() - recallStartMs} phase=${recallProbePhase} completed=${recallStageCompleted}`,
    );
  }
}
