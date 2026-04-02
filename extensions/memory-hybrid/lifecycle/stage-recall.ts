/**
 * Lifecycle stage: Recall (Phase 2.3).
 * Owns the interactive recall path for chat turns.
 * Runs the bounded recall pipeline: degradation check, FTS+vector, ambient, directives,
 * entity lookup, scoring. Returns either degraded/empty prependContext or RecallResult for injection.
 * Config: autoRecall.enabled. Stage wall-clock: INTERACTIVE_RECALL_STAGE_TIMEOUT_MS (abort).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { ScopeFilter } from "../types/memory.js";
import type { SearchResult } from "../types/memory.js";
import {
  generateAmbientQueries,
  detectTopicShift,
  deduplicateResultsById,
  SessionSeenFacts,
  searchAmbientIssues,
} from "../services/ambient-retrieval.js";
import { capturePluginError } from "../services/error-reporter.js";
import { formatNarrativeRange, recallNarrativeSummaries } from "../services/narrative-recall.js";
import { yieldEventLoop } from "../utils/event-loop-yield.js";
import { resolveEntityLookupNames } from "../utils/entity-lookup-resolve.js";
import { estimateTokens } from "../utils/text.js";
import { isConsolidatedDerivedFact } from "../utils/consolidation-controls.js";
import type { LifecycleContext, RecallResult, RecallStageResult, SessionState } from "./types.js";
import { runRecallPipelineQuery, type RecallPipelineDeps } from "../services/recall-pipeline.js";
import { createRecallSpan, createRecallTimingLogger } from "../services/recall-timing.js";
import {
  INTERACTIVE_RECALL_STAGE_TIMEOUT_MS,
  resolveInteractiveRecallPolicy,
} from "../services/retrieval-mode-policy.js";

const RECALL_STAGE_TIMEOUT_MS = INTERACTIVE_RECALL_STAGE_TIMEOUT_MS;

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

export async function runRecallStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<RecallStageResult | null> {
  const ac = new AbortController();
  const { signal } = ac;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runRecall(event, api, ctx, sessionState, signal),
      new Promise<RecallStageResult | null>((resolve) => {
        timer = setTimeout(() => {
          ac.abort();
          resolve(null);
        }, RECALL_STAGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runRecall(
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

  ctx.recallInFlightRef.value++;
  const recallStartMs = Date.now();
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
    if (recallAborted(signal)) return completeStage(emptyRecallStage());

    const { currentAgentIdRef } = ctx;
    const { resolveSessionKey, ambientSeenFactsMap, ambientLastEmbeddingMap, pruneSessionMaps, sessionStartSeen } =
      sessionState;

    api.logger.debug?.(`memory-hybrid: auto-recall start (prompt length ${e.prompt.length})`);

    // Let pending gateway I/O (health RPCs, WebSocket) run before heavy sync work (#931).
    await yieldEventLoop();
    if (recallAborted(signal)) return completeStage(emptyRecallStage());

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
      const ftsOnly = ctx.factsDb.search(trimmed, degradedLimit, recallOpts);
      let hotPart = "";
      if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.hotMaxTokens > 0) {
        const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
        if (hotResults.length > 0) {
          const hotLines = hotResults.map(
            (r) =>
              `- [hot/${r.entry.category}] ${(r.entry.summary || r.entry.text).slice(0, 200)}${(r.entry.summary || r.entry.text).length > 200 ? "…" : ""}`,
          );
          hotPart = `Hot memories:\n${hotLines.join("\n")}\n\n`;
        }
      }
      const memoryLines = ftsOnly
        .slice(0, degradedLimit)
        .map(
          (r) =>
            `- [${r.backend}/${r.entry.category}] ${(r.entry.summary || r.entry.text).slice(0, 200)}${(r.entry.summary || r.entry.text).length > 200 ? "…" : ""}`,
        );
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
            narrativePart = `<recent-history-narratives>\n- [${narrative.source}/${formatNarrativeRange(narrative.periodStart, narrative.periodEnd)}] (sessionKey: ${narrative.sessionId})\n${clipNarrativeText(narrative.text)}\n</recent-history-narratives>\n\n`;
          }
        } catch {
          // Non-fatal.
        }
      }
      const inner =
        narrativePart + hotPart + (memoryLines.length ? `Recalled (FTS-only):\n${memoryLines.join("\n")}` : "");
      const block = inner ? `<recalled-context>\n${inner}\n</recalled-context>` : "";
      const degradedMarker = "<!-- recall degraded: queue -->\n";
      api.logger.debug?.(
        `memory-hybrid: recall degraded (queue depth ${ctx.recallInFlightRef.value} > ${degradationQueueDepth}), using FTS-only + HOT`,
      );
      if (block) return completeStage({ kind: "degraded", prependContext: `${degradedMarker + block}\n\n` });
      return completeStage({ kind: "degraded", prependContext: `${degradedMarker}\n\n` });
    }

    // Procedural memory (skip expensive FTS when injection budget is zero — issue #863)
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
    const withProcedures = (s: string) => (procedureBlock ? `${procedureBlock}\n${s}` : s);

    // HOT block
    const hotFactsStartedAt = recallTiming.phaseStarted("hot_facts_block");
    let hotBlock = "";
    if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.hotMaxTokens > 0) {
      const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
      if (hotResults.length > 0) {
        const hotLines = hotResults.map(
          (r) =>
            `- [hot/${r.entry.category}] ${(r.entry.summary || r.entry.text).slice(0, 200)}${(r.entry.summary || r.entry.text).length > 200 ? "…" : ""}`,
        );
        hotBlock = `<hot-memories>\n${hotLines.join("\n")}\n</hot-memories>\n\n`;
      }
    }
    recallTiming.phaseCompleted("hot_facts_block", hotFactsStartedAt, { injected: hotBlock.length > 0 });

    await yieldEventLoop();
    if (recallAborted(signal)) return completeStage(emptyRecallStage());

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
    };

    const ambientCfg = ctx.cfg.ambient;
    const sessionScopeKey = resolveSessionKey(e, api) ?? "default";
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

    if (recallAborted(signal)) return completeStage(emptyRecallStage());

    let promptEmbedding: number[] | null = null;
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

    if (recallAborted(signal)) return completeStage(emptyRecallStage());

    const mainPipelineStartedAt = recallTiming.phaseStarted("main_pipeline");
    let candidates = await runRecallPipelineQuery(e.prompt, limit, pipelineDeps, hydeUsedRef, {
      hydeLabel: "HyDE",
      errorPrefix: "auto-recall-",
      precomputedVector: promptEmbedding ?? undefined,
      policy: interactivePolicy,
      timingSpan: recallSpan,
      timingOp: "auto-recall-main",
    });
    recallTiming.phaseCompleted("main_pipeline", mainPipelineStartedAt, { candidates: candidates.length });

    if (recallAborted(signal)) return completeStage(emptyRecallStage());

    if (interactivePolicy.allowAmbientMultiQuery && ambientCfg.enabled && ambientCfg.multiQuery) {
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
            if (recallAborted(signal)) {
              recallTiming.phaseCompleted("ambient_multi_query", ambientStartedAt, {
                status: "aborted",
                queries_run: ambientQueriesRun,
              });
              return completeStage(emptyRecallStage());
            }
            await yieldEventLoop();
            try {
              const qResults = await runRecallPipelineQuery(q.text, Math.ceil(limit / 2), pipelineDeps, hydeUsedRef, {
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

    let issueBlock = "";
    let narrativeBlock = "";
    const issuesStartedAt = recallTiming.phaseStarted("issues_block");
    if (ambientCfg.enabled && ctx.issueStore) {
      try {
        const issueResults = searchAmbientIssues(e.prompt, ctx.issueStore);
        if (issueResults.openIssues.length > 0 || issueResults.resolvedIssues.length > 0) {
          const issueLines: string[] = [];
          if (issueResults.openIssues.length > 0) {
            issueLines.push("<known-issues>");
            for (const issue of issueResults.openIssues) {
              issueLines.push(`- [${issue.severity}] ${issue.title} (status: ${issue.status})`);
            }
            issueLines.push("</known-issues>");
          }
          if (issueResults.resolvedIssues.length > 0) {
            issueLines.push("<resolved-issues>");
            for (const issue of issueResults.resolvedIssues) {
              const resolution = issue.fix ? ` — Fix: ${issue.fix.slice(0, 100)}` : "";
              issueLines.push(`- [${issue.severity}] ${issue.title}${resolution}`);
            }
            issueLines.push("</resolved-issues>");
          }
          if (issueLines.length > 0) issueBlock = `${issueLines.join("\n")}\n\n`;
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "ambient-issue-retrieval",
          subsystem: "auto-recall",
        });
      }
    }
    recallTiming.phaseCompleted("issues_block", issuesStartedAt, { injected: issueBlock.length > 0 });

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
            return `- [${n.source}/${formatNarrativeRange(n.periodStart, n.periodEnd)}] (sessionKey: ${n.sessionId})\n${clipNarrativeText(n.text)}`;
          });
          narrativeBlock = `<recent-history-narratives>\n${lines.join("\n")}\n</recent-history-narratives>\n\n`;
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "recent-narrative-retrieval",
          subsystem: "auto-recall",
        });
      }
    }
    recallTiming.phaseCompleted("narrative_block", narrativeStartedAt, { injected: narrativeBlock.length > 0 });

    await yieldEventLoop();
    if (recallAborted(signal)) return completeStage(emptyRecallStage());

    const promptLower = e.prompt.toLowerCase();
    const { entityLookup } = ctx.cfg.autoRecall;
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
        if (recallAborted(signal)) {
          return abortDirectives();
        }
        if (directivesCfg.entityMentioned && entityLookup.enabled) {
          const entityLookupNames = resolveEntityLookupNames(entityLookup, ctx.factsDb);
          if (entityLookupNames.length > 0) {
            for (const entity of entityLookupNames) {
              if (recallAborted(signal)) {
                return abortDirectives();
              }
              if (!promptLower.includes(entity.toLowerCase())) continue;
              if (!canRunDirective()) break;
              const results = await runRecallPipelineQuery(entity, directiveLimit, pipelineDeps, hydeUsedRef, {
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
            if (recallAborted(signal)) {
              return abortDirectives();
            }
            if (!promptLower.includes(keyword.toLowerCase())) continue;
            if (!canRunDirective()) break;
            const results = await runRecallPipelineQuery(keyword, directiveLimit, pipelineDeps, hydeUsedRef, {
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
          if (recallAborted(signal)) {
            return abortDirectives();
          }
          const hit = triggers.some((t) => promptLower.includes(t.toLowerCase()));
          if (!hit || !canRunDirective()) continue;
          const results = await runRecallPipelineQuery(taskType, directiveLimit, pipelineDeps, hydeUsedRef, {
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
          if (recallAborted(signal)) {
            return abortDirectives();
          }
          const sessionKey = resolveSessionKey(e, api) ?? currentAgentIdRef.value ?? "default";
          if (!sessionStartSeen.has(sessionKey) && canRunDirective()) {
            const results = await runRecallPipelineQuery("session start", directiveLimit, pipelineDeps, hydeUsedRef, {
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

    if (candidates.length === 0) {
      const combinedContext = issueBlock + narrativeBlock + hotBlock;
      return completeStage({ kind: "empty", prependContext: combinedContext || undefined });
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
    } = ctx.cfg.autoRecall;
    // Enforce retrieval.ambientBudgetTokens as a hard total-token cap (#581).
    // autoRecall.maxTokens is a user preference; ambientBudgetTokens is the architectural
    // ceiling — the injected context must not exceed either.
    const totalBudget = interactivePolicy.contextBudgetTokens;
    // Account for issueBlock, hotBlock, and procedureBlock tokens to ensure total stays within budget
    const fixedBlocksTokens =
      estimateTokens(issueBlock) +
      estimateTokens(narrativeBlock) +
      estimateTokens(hotBlock) +
      estimateTokens(procedureBlock);
    const maxTokens = Math.max(0, totalBudget - fixedBlocksTokens);
    if (maxTokens === 0) {
      api.logger.warn?.(
        `memory-hybrid: fixed blocks (${fixedBlocksTokens} tokens) exhausted total budget (${totalBudget} tokens); recall suppressed`,
      );
    }
    const indexCap = Math.min(progressiveIndexMaxTokens ?? maxTokens, maxTokens);
    const groupByCategory = progressiveGroupByCategory === true;
    const pinnedRecallThreshold = progressivePinnedRecallCount ?? 3;

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
    if (!recallStageCompleted) {
      recallTiming.phaseCompleted("recall_stage_run", recallStageStartedAt, {
        ...(recallStageFields ?? {}),
        status: "error",
      });
      recallStageCompleted = true;
    }
    throw err;
  } finally {
    ctx.recallInFlightRef.value--;
  }
}
