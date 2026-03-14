/**
 * Lifecycle stage: Recall (Phase 2.3).
 * Runs the full recall pipeline: degradation check, FTS+vector, ambient, directives,
 * entity lookup, scoring. Returns either degraded/empty prependContext or RecallResult for injection.
 * Config: autoRecall.enabled. Timeout: 35s.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { ScopeFilter } from "../types/memory.js";
import type { SearchResult } from "../types/memory.js";
import { getCronModelConfig, getLLMModelPreference } from "../config.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import { chatCompleteWithRetry, is500Like, is404Like, isOllamaOOM, type PendingLLMWarnings } from "../services/chat.js";
import { computeDynamicSalience } from "../utils/salience.js";
import {
  generateAmbientQueries,
  detectTopicShift,
  deduplicateResultsById,
  SessionSeenFacts,
  searchAmbientIssues,
} from "../services/ambient-retrieval.js";
import { capturePluginError } from "../services/error-reporter.js";
import { withTimeout } from "../utils/timeout.js";
import type { LifecycleContext, RecallResult, RecallStageResult, SessionState } from "./types.js";

export const RECALL_STAGE_TIMEOUT_MS = 35_000;
const VECTOR_STEP_TIMEOUT_MS = 30_000;

export async function runRecallStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<RecallStageResult | null> {
  return withTimeout(RECALL_STAGE_TIMEOUT_MS, () => runRecall(event, api, ctx, sessionState));
}

async function runRecall(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<RecallStageResult> {
  const e = event as { prompt?: string };
  if (!e.prompt || e.prompt.length < 5) {
    return { kind: "empty", prependContext: undefined };
  }

  ctx.recallInFlightRef.value++;
  const recallStartMs = Date.now();
  try {
    const { currentAgentIdRef } = ctx;
    const { resolveSessionKey, ambientSeenFactsMap, ambientLastEmbeddingMap, pruneSessionMaps, sessionStartSeen } =
      sessionState;

    api.logger.debug?.(`memory-hybrid: auto-recall start (prompt length ${e.prompt.length})`);

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

    const degradationQueueDepth = ctx.cfg.autoRecall.degradationQueueDepth ?? 10;
    const degradationMaxLatencyMs = ctx.cfg.autoRecall.degradationMaxLatencyMs ?? 5000;
    const forceDegraded = degradationQueueDepth > 0 && ctx.recallInFlightRef.value > degradationQueueDepth;

    if (forceDegraded) {
      const recallOpts = {
        tierFilter: ctx.cfg.memoryTiering.enabled ? ("warm" as const) : ("all" as const),
        scopeFilter,
        reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
        diversityWeight: ctx.cfg.reinforcement?.diversityWeight ?? 1.0,
      };
      const degradedLimit = ctx.cfg.autoRecall.limit;
      const trimmed = e.prompt.trim();
      const ftsOnly = ctx.factsDb.search(trimmed, degradedLimit, recallOpts);
      let hotPart = "";
      if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.hotMaxTokens > 0) {
        const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
        if (hotResults.length > 0) {
          const hotLines = hotResults.map(
            (r) =>
              `- [hot/${r.entry.category}] ${(r.entry.summary || r.entry.text).slice(0, 200)}${(r.entry.summary || r.entry.text).length > 200 ? "…" : ""}`,
          );
          hotPart = "Hot memories:\n" + hotLines.join("\n") + "\n\n";
        }
      }
      const memoryLines = ftsOnly
        .slice(0, degradedLimit)
        .map(
          (r) =>
            `- [${r.backend}/${r.entry.category}] ${(r.entry.summary || r.entry.text).slice(0, 200)}${(r.entry.summary || r.entry.text).length > 200 ? "…" : ""}`,
        );
      const inner = hotPart + (memoryLines.length ? "Recalled (FTS-only):\n" + memoryLines.join("\n") : "");
      const block = inner ? `<recalled-context>\n${inner}\n</recalled-context>` : "";
      const degradedMarker = "<!-- recall degraded: queue -->\n";
      api.logger.debug?.(
        `memory-hybrid: recall degraded (queue depth ${ctx.recallInFlightRef.value} > ${degradationQueueDepth}), using FTS-only + HOT`,
      );
      if (block) return { kind: "degraded", prependContext: degradedMarker + block + "\n\n" };
      return { kind: "degraded", prependContext: degradedMarker + "\n\n" };
    }

    // Procedural memory
    let procedureBlock = "";
    if (ctx.cfg.procedures.enabled) {
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
        procedureBlock = "<relevant-procedures>\n" + procLines.join("\n") + "\n</relevant-procedures>";
      }
    }
    const withProcedures = (s: string) => (procedureBlock ? procedureBlock + "\n" + s : s);

    // HOT block
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

    let directiveHydeUsed = false;
    const recallOpts = {
      tierFilter,
      scopeFilter,
      reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
      diversityWeight: ctx.cfg.reinforcement?.diversityWeight ?? 1.0,
    };

    async function runRecallPipeline(
      query: string,
      limitNum: number,
      opts?: {
        entity?: string;
        hydeLabel?: string;
        errorPrefix?: string;
        limitHydeOnce?: boolean;
        precomputedVector?: number[];
      },
    ): Promise<SearchResult[]> {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const stageMs = { fts: 0, embed: 0, vector: 0, merge: 0 };
      let t0 = Date.now();
      let sqliteResults: SearchResult[] = [];
      if (opts?.entity) {
        sqliteResults = ctx.factsDb.lookup(opts.entity, undefined, undefined, { scopeFilter }).slice(0, limitNum);
      }
      const ftsResults = ctx.factsDb.search(trimmed, limitNum, recallOpts);
      stageMs.fts = Date.now() - t0;
      sqliteResults = [...sqliteResults, ...ftsResults];

      let lanceResults: SearchResult[] = [];
      const directiveAbort = new AbortController();
      try {
        const vectorStepPromise = (async (): Promise<SearchResult[]> => {
          let textToEmbed = trimmed;
          const allowHyde = ctx.cfg.queryExpansion.enabled && (!opts?.limitHydeOnce || !directiveHydeUsed);
          t0 = Date.now();
          if (allowHyde) {
            if (opts?.limitHydeOnce) directiveHydeUsed = true;
            try {
              const cronCfg = getCronModelConfig(ctx.cfg);
              const pref = getLLMModelPreference(cronCfg, "nano");
              const hydeModel = ctx.cfg.queryExpansion.model ?? pref[0];
              const fallbackModels = ctx.cfg.queryExpansion.model ? [] : pref.slice(1);
              const hydeContent = await chatCompleteWithRetry({
                model: hydeModel,
                fallbackModels,
                content: `Write a short factual statement (1-2 sentences) that answers: ${trimmed}\n\nOutput only the statement, no preamble.`,
                temperature: 0.3,
                maxTokens: 150,
                openai: ctx.openai,
                label: opts?.hydeLabel ?? "HyDE",
                timeoutMs: ctx.cfg.queryExpansion.timeoutMs,
                signal: directiveAbort.signal,
                pendingWarnings: ctx.pendingLLMWarnings,
              });
              const hydeText = hydeContent.trim();
              if (hydeText.length > 10) textToEmbed = hydeText;
            } catch (err) {
              if (!directiveAbort.signal.aborted) {
                const hydeErr = err instanceof Error ? err : new Error(String(err));
                const isTransient =
                  isOllamaOOM(hydeErr) ||
                  is500Like(hydeErr) ||
                  is404Like(hydeErr) ||
                  /timed out|llm request timeout|request was aborted|econnrefused/i.test(hydeErr.message);
                if (!isTransient) {
                  capturePluginError(hydeErr, {
                    operation: `${opts?.errorPrefix ?? ""}hyde-generation`,
                    subsystem: "auto-recall",
                  });
                }
                if (isOllamaOOM(hydeErr)) {
                  api.logger.warn?.(
                    `memory-hybrid: Ollama model OOM during HyDE generation — model requires more memory than available. ` +
                      `Using raw query. Consider using a smaller model or configuring a cloud fallback.`,
                  );
                } else {
                  api.logger.warn?.(
                    `memory-hybrid: ${opts?.errorPrefix ?? ""}HyDE generation failed, using raw query: ${err}`,
                  );
                }
              }
            }
          }
          const vector =
            opts?.precomputedVector && textToEmbed === trimmed
              ? opts.precomputedVector
              : await ctx.embeddings.embed(textToEmbed);
          stageMs.embed = Date.now() - t0;
          t0 = Date.now();
          let results = await ctx.vectorDb.search(vector, limitNum * 2, minScore);
          stageMs.vector = Date.now() - t0;
          results = filterByScope(results, (id, o) => ctx.factsDb.getById(id, o), scopeFilter);
          results = results.map((r) => {
            const fullEntry = ctx.factsDb.getById(r.entry.id);
            if (fullEntry) return { ...r, entry: fullEntry, score: computeDynamicSalience(r.score, fullEntry) };
            return r;
          });
          return results;
        })();
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            directiveAbort.abort();
            reject(new Error(`recall pipeline timed out after ${VECTOR_STEP_TIMEOUT_MS}ms`));
          }, VECTOR_STEP_TIMEOUT_MS);
        });
        try {
          lanceResults = await Promise.race([vectorStepPromise, timeoutPromise]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          vectorStepPromise.catch((err) => {
            if (!directiveAbort.signal.aborted) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: `${opts?.errorPrefix ?? ""}vector-recall-post-timeout`,
                subsystem: "auto-recall",
              });
            }
          });
        }
      } catch (err) {
        const isTimeout = err instanceof Error && err.message.includes("timed out");
        if (isTimeout) api.logger.warn?.(`memory-hybrid: ${err.message}, using FTS-only recall`);
        else {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: `${opts?.errorPrefix ?? ""}vector-recall`,
            subsystem: "auto-recall",
            backend: "lancedb",
          });
          api.logger.warn(`memory-hybrid: ${opts?.errorPrefix ?? ""}vector recall failed: ${err}`);
        }
      }

      t0 = Date.now();
      let results = mergeResults(sqliteResults, lanceResults, limitNum, ctx.factsDb);
      stageMs.merge = Date.now() - t0;
      if (ctx.cfg.memoryTiering.enabled && results.length > 0) {
        results = results
          .filter((r) => {
            const full = ctx.factsDb.getById(r.entry.id);
            return full && full.tier !== "cold";
          })
          .slice(0, limitNum);
      }
      api.logger.debug?.(
        `memory-hybrid: recall pipeline timing (ms) — FTS: ${stageMs.fts}, embed: ${stageMs.embed}, vector: ${stageMs.vector}, merge: ${stageMs.merge}, total: ${stageMs.fts + stageMs.embed + stageMs.vector + stageMs.merge}`,
      );
      return results;
    }

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

    let promptEmbedding: number[] | null = null;
    if (ambientCfg.enabled && ambientCfg.multiQuery) {
      try {
        promptEmbedding = await ctx.embeddings.embed(e.prompt);
      } catch {
        // Non-fatal
      }
    }

    let candidates = await runRecallPipeline(e.prompt, limit, {
      hydeLabel: "HyDE",
      errorPrefix: "auto-recall-",
      precomputedVector: promptEmbedding ?? undefined,
    });

    if (ambientCfg.enabled && ambientCfg.multiQuery) {
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
            try {
              const qResults = await runRecallPipeline(q.text, Math.ceil(limit / 2), {
                entity: q.type === "entity" ? q.entity : undefined,
                hydeLabel: "HyDE",
                errorPrefix: `ambient-${q.type}-`,
                limitHydeOnce: true,
              });
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
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "ambient-multi-query",
          subsystem: "auto-recall",
        });
        api.logger.warn?.(`memory-hybrid: ambient multi-query failed, continuing with main recall: ${err}`);
      }
    }

    let issueBlock = "";
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
          if (issueLines.length > 0) issueBlock = issueLines.join("\n") + "\n\n";
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "ambient-issue-retrieval",
          subsystem: "auto-recall",
        });
      }
    }

    const promptLower = e.prompt.toLowerCase();
    const { entityLookup } = ctx.cfg.autoRecall;
    if (entityLookup.enabled && entityLookup.entities.length > 0) {
      const seenIds = new Set(candidates.map((c) => c.entry.id));
      for (const entity of entityLookup.entities) {
        if (!promptLower.includes(entity.toLowerCase())) continue;
        const entityResults = ctx.factsDb
          .lookup(entity, undefined, undefined, { scopeFilter })
          .slice(0, entityLookup.maxFactsPerEntity);
        for (const r of entityResults) {
          if (!seenIds.has(r.entry.id)) {
            seenIds.add(r.entry.id);
            candidates.push(r);
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

    if (directivesCfg.enabled) {
      try {
        if (directivesCfg.entityMentioned && entityLookup.enabled && entityLookup.entities.length > 0) {
          for (const entity of entityLookup.entities) {
            if (!promptLower.includes(entity.toLowerCase())) continue;
            if (!canRunDirective()) break;
            const results = await runRecallPipeline(entity, directiveLimit, {
              entity,
              hydeLabel: "HyDE",
              errorPrefix: "directive-",
              limitHydeOnce: true,
            });
            directiveCalls += 1;
            addDirectiveResults(results, `entity:${entity}`);
          }
        }
        if (directivesCfg.keywords.length > 0) {
          for (const keyword of directivesCfg.keywords) {
            if (!promptLower.includes(keyword.toLowerCase())) continue;
            if (!canRunDirective()) break;
            const results = await runRecallPipeline(keyword, directiveLimit, {
              hydeLabel: "HyDE",
              errorPrefix: "directive-",
              limitHydeOnce: true,
            });
            directiveCalls += 1;
            addDirectiveResults(results, `keyword:${keyword}`);
          }
        }
        for (const [taskType, triggers] of Object.entries(directivesCfg.taskTypes)) {
          const hit = triggers.some((t) => promptLower.includes(t.toLowerCase()));
          if (!hit || !canRunDirective()) continue;
          const results = await runRecallPipeline(taskType, directiveLimit, {
            hydeLabel: "HyDE",
            errorPrefix: "directive-",
            limitHydeOnce: true,
          });
          directiveCalls += 1;
          addDirectiveResults(results, `taskType:${taskType}`);
        }
        if (directivesCfg.sessionStart) {
          const sessionKey = resolveSessionKey(e, api) ?? currentAgentIdRef.value ?? "default";
          if (!sessionStartSeen.has(sessionKey) && canRunDirective()) {
            const results = await runRecallPipeline("session start", directiveLimit, {
              hydeLabel: "HyDE",
              errorPrefix: "directive-",
              limitHydeOnce: true,
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
      const combinedContext = issueBlock + hotBlock;
      return { kind: "empty", prependContext: combinedContext || undefined };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const NINETY_DAYS_SEC = 90 * 24 * 3600;
    const boosted = candidates.map((r) => {
      let s = r.score;
      if (ctx.cfg.autoRecall.preferLongTerm) {
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
      maxTokens,
      maxPerMemoryChars,
      useSummaryInInjection,
      summarizeWhenOverBudget,
      summarizeModel,
      progressiveIndexMaxTokens,
      progressiveGroupByCategory,
      progressivePinnedRecallCount,
    } = ctx.cfg.autoRecall;
    const indexCap = progressiveIndexMaxTokens ?? maxTokens;
    const groupByCategory = progressiveGroupByCategory === true;
    const pinnedRecallThreshold = progressivePinnedRecallCount ?? 3;

    const result: RecallResult = {
      candidates,
      issueBlock,
      hotBlock,
      procedureBlock,
      withProcedures,
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
    return { kind: "full", result };
  } finally {
    ctx.recallInFlightRef.value--;
  }
}
