/**
 * Lifecycle stage: Injection (Phase 2.3).
 * Builds prependContext from RecallResult: progressive_hybrid, progressive, or full/short/minimal
 * formatting; wrapRecalledContext, markDegradedLatency; refreshAccessedFacts, Hebbian.
 * Timeout: 10s.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { getCronModelConfig, getDefaultCronModel } from "../config/index.js";
import "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { chatCompletionTokenParams } from "../services/model-capabilities.js";
import { trimBlockToBudget } from "../services/context-block-trim.js";
import { consumePrependBudget } from "../services/prepend-budget.js";
import { shouldPinFactForInjection } from "../services/pinned-recall-policy.js";
import {
  assembleRecallPrependContext,
  buildEdictBlock,
  DEFAULT_EDICT_BUDGET_FRACTION,
  finalizeInjectionMemoryContent,
} from "../services/recalled-context-assembler.js";
import { logRecallEvent } from "../services/recall-events.js";
import { recordInjectionAttribution } from "../services/injection-attribution-store.js";
import {
  attributeInjectionToTurn,
  segmentTranscriptIntoTurns,
} from "../services/per-turn-attribution.js";
import { scanInjectionFilter, type InjectionFilterMode } from "../services/injection-filter.js";
import { emitRecallVerboseLog } from "../services/recall-verbose-log.js";
import { createRecallSpan, createRecallTimingLogger } from "../services/recall-timing.js";
import { sanitizePromptInjection } from "../services/skill-prompt-injection.js";
import { extractAssistantMessageText } from "../utils/llm-message.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import {
  estimateTokens,
  estimateTokensForDisplay,
  formatProgressiveIndexLine,
  sanitizeRecallFactText,
} from "../utils/text.js";
import { markFactsInjectedForSession } from "../services/session-injection-dedup.js";
import { setProgressiveIndexIds } from "../utils/progressive-index-session.js";
import type { LifecycleContext, RecallResult } from "./types.js";
import { resolveAgentIdFromHookEvent } from "./resolve-agent-id.js";

const INJECTION_STAGE_TIMEOUT_MS = 10_000;
const HEBBIAN_MAX_K = 8;

/** Collect top-K pairs and batch-strengthen in a single transaction, fire-and-forget. */
function strengthenHebbianLinks(
  ids: string[],
  factsDb: LifecycleContext["factsDb"],
  logger: { warn: (msg: string) => void },
): void {
  const topK = Array.from(new Set(ids)).slice(0, HEBBIAN_MAX_K);
  const pairs: [string, string][] = [];
  for (let i = 0; i < topK.length; i++) {
    for (let j = i + 1; j < topK.length; j++) {
      pairs.push([topK[i], topK[j]]);
    }
  }
  if (pairs.length === 0) return;
  setImmediate(() => {
    try {
      // Check database connection before deferred operation to prevent race condition during shutdown (#1288)
      if (typeof factsDb.isOpen === "function" && !factsDb.isOpen()) {
        return;
      }
      factsDb.strengthenRelatedLinksBatch(pairs);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Expected when the plugin is shutting down or the database closed mid-operation
      if (!/database connection is not open/i.test(e.message)) {
        capturePluginError(e, {
          operation: "hebbian-strengthen",
          subsystem: "stage-injection",
        });
        logger.warn(`memory-hybrid: hebbian link strengthening failed: ${err}`);
      }
    }
  });
}

type InjectionSideEffects = {
  accessedIds?: string[];
  indexedIds?: string[];
};

function applyInjectionSideEffects(
  ctx: LifecycleContext,
  api: ClawdbotPluginApi,
  ambientSeenFacts: RecallResult["ambientSeenFacts"],
  sessionKey: string,
  sideEffects: InjectionSideEffects,
): void {
  const accessedIds = sideEffects.accessedIds ?? [];
  const indexedIds = sideEffects.indexedIds ?? [];
  if (accessedIds.length > 0) ctx.factsDb.refreshAccessedFacts(accessedIds);
  if (indexedIds.length > 0) ctx.factsDb.refreshIndexedFacts(indexedIds);
  const seenIds = [...accessedIds, ...indexedIds];
  markFactsInjectedForSession(ctx.injectedFactIdsBySession, sessionKey, seenIds);
  if (ambientSeenFacts && seenIds.length > 0) ambientSeenFacts.markSeen(seenIds);
  if (ctx.cfg.graph.enabled && ctx.cfg.graph.strengthenOnRecall && accessedIds.length >= 2) {
    strengthenHebbianLinks(accessedIds, ctx.factsDb, api.logger);
  }
}

export async function runInjectionStage(
  recallResult: RecallResult,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  event: unknown,
): Promise<{ prependContext: string } | undefined> {
  const emitGate = { emitted: false };
  const injectionAbort = new AbortController();
  let primarySettled = false;

  const primary = runInjection(recallResult, api, ctx, event, {
    emitGate,
    abortSignal: injectionAbort.signal,
  }).then((result) => {
    primarySettled = true;
    return result;
  });

  let injectionTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutFallback = new Promise<{ prependContext: string } | undefined>((resolve) => {
    injectionTimeoutId = setTimeout(() => {
      if (primarySettled || emitGate.emitted) {
        resolve(undefined);
        return;
      }
      injectionAbort.abort();
      api.logger.warn?.("memory-hybrid: injection stage timed out — returning unsummarized partial injection");
      void runInjection(recallResult, api, ctx, event, { skipLlmSummarize: true, emitGate }).then(resolve);
    }, INJECTION_STAGE_TIMEOUT_MS);
  });

  return Promise.race([primary, timeoutFallback]).finally(() => {
    if (injectionTimeoutId !== undefined) clearTimeout(injectionTimeoutId);
  });
}

type RunInjectionOptions = {
  skipLlmSummarize?: boolean;
  /** Prevents double prepend emission when primary and timeout paths race. */
  emitGate?: { emitted: boolean };
  /** Aborted when injection stage timeout wins — skips LLM summarize on primary path. */
  abortSignal?: AbortSignal;
};

async function runInjection(
  r: RecallResult,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  event: unknown,
  options: RunInjectionOptions = {},
): Promise<{ prependContext: string } | undefined> {
  const recallTiming = createRecallTimingLogger({
    logger: api.logger,
    mode: ctx.cfg.autoRecall.recallTiming ?? "off",
    span: r.recallSpan || createRecallSpan("recall-injection"),
    op: "auto-recall-injection",
  });

  const agentId = resolveAgentIdFromHookEvent(event, api);
  const injectionStart = Date.now();

  const markDegradedLatency = (content: string): string => {
    let out = content;
    if (r.degradationMaxLatencyMs > 0 && Date.now() - r.recallStartMs > r.degradationMaxLatencyMs) {
      api.logger.debug?.(
        `memory-hybrid: recall degraded (latency ${Date.now() - r.recallStartMs}ms > ${r.degradationMaxLatencyMs}ms)`,
      );
      out = `<!-- recall degraded: latency -->\n${out}`;
    }
    if (r.semanticDegraded) {
      api.logger.debug?.("memory-hybrid: recall degraded (semantic/vector step unavailable — FTS-only results)");
      out = `<!-- recall degraded: semantic -->\n${out}`;
    }
    return out;
  };

  const {
    candidates,
    issueBlock,
    narrativeBlock,
    hotBlock,
    procedureBlock,
    withProcedures,
    injectionFormat,
    maxTokens,
    maxPerMemoryChars,
    useSummaryInInjection,
    indexCap,
    summarizeWhenOverBudget,
    summarizeModel,
    groupByCategory,
    pinnedRecallThreshold,
    progressiveIndexSessionKey,
    progressiveIndexBySession,
    ambientCfg: _ambientCfg,
    ambientSeenFacts,
  } = r;
  const recalledAmbient = issueBlock + narrativeBlock + hotBlock;

  const injectionFilterMode: InjectionFilterMode =
    ctx.cfg.retrieval?.contextBoundary?.injectionFilter ?? "audit";
  let injectionFilteredCount = 0;

  const sanitizeFactForInjection = (raw: string): string => {
    const cleaned = sanitizePromptInjection(sanitizeRecallFactText(raw));
    if (!cleaned || injectionFilterMode === "off") return cleaned;
    const scan = scanInjectionFilter(cleaned);
    if (scan.allowed) return cleaned;
    if (injectionFilterMode === "audit") {
      emitRecallVerboseLog({
        evt: "injection.would_drop",
        feature: "injection_filter",
        layer: scan.layer,
        reason: scan.reason,
      });
      return cleaned;
    }
    injectionFilteredCount++;
    return "";
  };

  const edictMaxTokens = Math.max(
    0,
    Math.min(maxTokens, Math.floor((r.totalBudget ?? maxTokens) * DEFAULT_EDICT_BUDGET_FRACTION)),
  );
  const edictBlock = (() => {
    const raw = buildEdictBlock(ctx);
    if (!raw) return "";
    if (edictMaxTokens <= 0) return "";
    return trimBlockToBudget(raw, edictMaxTokens).text;
  })();
  const memoryTokenBudget = Math.max(0, maxTokens - estimateTokens(edictBlock));
  const effectiveIndexCap = Math.min(indexCap, memoryTokenBudget);

  const finishPrepend = (
    memoryContent: string,
    prefix?: string,
    sideEffects?: InjectionSideEffects,
  ): { prependContext: string } | undefined => {
    if (options.emitGate?.emitted) return undefined;
    const structured = finalizeInjectionMemoryContent(ctx, event, memoryContent, candidates);
    const prepend = assembleRecallPrependContext(ctx, markDegradedLatency(structured), {
      prefix,
      edictBlock,
    });
    if (!prepend) return undefined;
    if (options.emitGate) options.emitGate.emitted = true;
    consumePrependBudget(ctx.prependBudgetRef, prepend);
    if (sideEffects) applyInjectionSideEffects(ctx, api, ambientSeenFacts, progressiveIndexSessionKey, sideEffects);
    if (injectionFilteredCount > 0) {
      emitRecallVerboseLog({
        evt: "injection.summary",
        feature: "injection_filter",
        filter_dropped: injectionFilteredCount,
      });
    }
    const messages = (event as { messages?: unknown[] })?.messages;
    if (messages && sideEffects?.accessedIds?.length) {
      const turns = segmentTranscriptIntoTurns(messages);
      const attr = attributeInjectionToTurn(turns, sideEffects.accessedIds);
      try {
        recordInjectionAttribution(ctx.factsDb.getRawDb(), {
          sessionKey: api.context?.sessionKey ?? api.context?.sessionId ?? null,
          agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? null,
          attribution: attr,
        });
        const queryText = extractLastUserMessageText(event) ?? "";
        logRecallEvent(ctx.factsDb.getRawDb(), {
          sessionKey: api.context?.sessionKey ?? api.context?.sessionId ?? null,
          agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? null,
          query: queryText.slice(0, 500) || null,
          factIds: sideEffects.accessedIds,
          hit: sideEffects.accessedIds.length > 0,
          source: "auto-recall",
        });
      } catch {
        /* non-fatal attribution persistence */
      }
      emitRecallVerboseLog({
        evt: "recall.attribution",
        feature: "per_turn_attribution",
        turn_index: attr.turnIndex,
        injected: attr.injectedFactIds.length,
        referenced: attr.referencedFactIds.length,
      });
    }
    return { prependContext: prepend };
  };

  const withAmbient = (s: string) => (recalledAmbient ? `${recalledAmbient}${s}` : s);

  const emitAudit = (tokens: number) => {
    ctx.auditStore?.append({
      agentId: agentId ?? ctx.currentAgentIdRef.value ?? "unknown",
      action: "injection:completed",
      outcome: "success",
      sessionId: api.context?.sessionKey,
      durationMs: Date.now() - injectionStart,
      tokens,
    });
  };

  function buildProgressiveIndex(
    list: typeof candidates,
    cap: number,
    startPosition: number,
  ): { lines: string[]; ids: string[]; usedTokens: number } {
    const totalTokens = list.reduce((sum, x) => sum + estimateTokensForDisplay(x.entry.summary || x.entry.text), 0);
    const header = `📋 Available memories (${list.length} matches, ~${totalTokens} tokens total):\n`;
    let usedTokens = estimateTokens(header);
    const indexEntries: { line: string; id: string; category: string; position: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      let title: string;
      if (x.entry.key) {
        title = sanitizePromptInjection(`${x.entry.entity ? `${x.entry.entity}: ` : ""}${x.entry.key}`);
      } else if (x.entry.summary) {
        title = sanitizeFactForInjection(x.entry.summary);
      } else {
        const truncated = x.entry.text.length > 60 ? `${x.entry.text.slice(0, 60).trim()}…` : x.entry.text;
        title = sanitizeFactForInjection(truncated);
      }
      if (!title) continue;
      const tokenCost = estimateTokensForDisplay(x.entry.summary || x.entry.text);
      const pos = startPosition + indexEntries.length;
      const category = sanitizePromptInjection(x.entry.category);
      const line = formatProgressiveIndexLine(category, title, tokenCost, pos);
      const lineTokens = estimateTokens(`${line}\n`);
      if (usedTokens + lineTokens > cap) break;
      indexEntries.push({ line, id: x.entry.id, category, position: pos });
      usedTokens += lineTokens;
    }
    const ids = indexEntries.map((e) => e.id);
    let lines: string[];
    if (groupByCategory) {
      const byCat = new Map<string, typeof indexEntries>();
      for (const e of indexEntries) {
        const arr = byCat.get(e.category) ?? [];
        arr.push(e);
        byCat.set(e.category, arr);
      }
      const sortedCats = [...byCat.keys()].sort();
      lines = [header.trimEnd()];
      for (const cat of sortedCats) {
        const entries = byCat.get(cat) ?? [];
        lines.push(`  ${cat} (${entries.length}):`);
        for (const e of entries) {
          lines.push(e.line.replace(/^(\s+)(\d+\.)/, "  $2"));
        }
      }
    } else {
      lines = [header.trimEnd(), ...indexEntries.map((e) => e.line)];
    }
    return { lines, ids, usedTokens };
  }

  if (injectionFormat === "progressive_hybrid") {
    const pinned: typeof candidates = [];
    const rest: typeof candidates = [];
    for (const x of candidates) {
      if (shouldPinFactForInjection(x.entry, pinnedRecallThreshold)) {
        pinned.push(x);
      } else {
        rest.push(x);
      }
    }
    const pinnedHeader = '<relevant-memories format="progressive_hybrid">\n';
    const pinnedPart: string[] = [];
    const injectedPinnedIds: string[] = [];
    let pinnedTokens = estimateTokens(pinnedHeader);
    const pinnedBudget = Math.min(memoryTokenBudget, Math.floor(memoryTokenBudget * 0.6));
    for (const x of pinned) {
      let text = sanitizeFactForInjection(useSummaryInInjection && x.entry.summary ? x.entry.summary : x.entry.text);
      if (!text) continue;
      if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars)
        text = `${text.slice(0, maxPerMemoryChars).trim()}…`;
      const category = sanitizePromptInjection(x.entry.category);
      const line = `- [${x.backend}/${category}] ${text}`;
      const lineTokens = estimateTokens(`${line}\n`);
      if (pinnedTokens + lineTokens > pinnedBudget) break;
      pinnedPart.push(line);
      injectedPinnedIds.push(x.entry.id);
      pinnedTokens += lineTokens;
    }
    const indexIntro =
      pinnedPart.length > 0
        ? `\nOther memories (index — use memory_recall(id: N) or memory_recall("query") to fetch):\n`
        : `<relevant-memories format="index">\n`;
    const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
    const fixedOverhead = estimateTokens(
      (pinnedPart.length > 0 ? pinnedHeader + pinnedPart.join("\n") : "") + indexIntro + indexFooter,
    );
    const indexBudget = Math.min(effectiveIndexCap, Math.max(0, memoryTokenBudget - pinnedTokens - fixedOverhead));
    if (indexBudget <= 0) {
      setProgressiveIndexIds(progressiveIndexBySession, progressiveIndexSessionKey, []);
      api.logger.debug?.(
        `memory-hybrid: progressive index budget exhausted by fixed blocks (indexCap=${indexCap} tokens); no index will be injected`,
      );
      if (pinnedPart.length > 0) {
        const fullContent = `${pinnedHeader}${pinnedPart.join("\n")}\n</relevant-memories>`;
        api.logger.info?.(
          `memory-hybrid: progressive_hybrid — ${pinnedPart.length} pinned in full, no index (~${pinnedTokens} tokens)`,
        );
        emitAudit(pinnedTokens);
        return (
          finishPrepend(withAmbient(withProcedures(fullContent)), undefined, {
            accessedIds: injectedPinnedIds,
          }) ?? undefined
        );
      }
      if (procedureBlock) {
        emitAudit(estimateTokens(recalledAmbient + procedureBlock));
        return finishPrepend(withAmbient(procedureBlock)) ?? undefined;
      }
      if (recalledAmbient) {
        emitAudit(estimateTokens(recalledAmbient));
        return finishPrepend(recalledAmbient) ?? undefined;
      }
      if (edictBlock) {
        emitAudit(estimateTokens(edictBlock));
        return finishPrepend("") ?? undefined;
      }
      return undefined;
    }
    const { lines: indexLines, ids: indexIds } = buildProgressiveIndex(rest, indexBudget, 1);
    setProgressiveIndexIds(progressiveIndexBySession, progressiveIndexSessionKey, indexIds);
    const indexContent = indexLines.join("\n");
    const fullContent =
      pinnedPart.length > 0
        ? `${pinnedHeader}${pinnedPart.join("\n")}${indexIntro}${indexContent}${indexFooter}`
        : `${indexIntro}${indexContent}${indexFooter}`;
    const totalTokens = pinnedTokens + estimateTokens(indexContent);
    api.logger.info?.(
      `memory-hybrid: progressive_hybrid — ${pinnedPart.length} pinned in full, index of ${indexIds.length} (~${totalTokens} tokens)`,
    );
    emitAudit(totalTokens);
    return (
      finishPrepend(withAmbient(withProcedures(fullContent)), undefined, {
        accessedIds: injectedPinnedIds,
        indexedIds: indexIds,
      }) ?? undefined
    );
  }

  if (injectionFormat === "progressive") {
    const indexHeader = `<relevant-memories format="index">\n`;
    const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
    const {
      lines: indexLines,
      ids: indexIds,
      usedTokens: indexTokens,
    } = buildProgressiveIndex(candidates, effectiveIndexCap - estimateTokens(indexHeader + indexFooter), 1);
    if (indexLines.length === 0) {
      if (procedureBlock) {
        emitAudit(estimateTokens(recalledAmbient + procedureBlock));
        return finishPrepend(withAmbient(procedureBlock)) ?? undefined;
      }
      if (recalledAmbient) {
        emitAudit(estimateTokens(recalledAmbient));
        return finishPrepend(recalledAmbient) ?? undefined;
      }
      if (edictBlock) {
        emitAudit(estimateTokens(edictBlock));
        return finishPrepend("") ?? undefined;
      }
      return undefined;
    }
    setProgressiveIndexIds(progressiveIndexBySession, progressiveIndexSessionKey, indexIds);
    const indexContent = indexLines.join("\n");
    api.logger.info?.(
      `memory-hybrid: progressive disclosure — injecting index of ${indexLines.length} memories (~${indexTokens} tokens)`,
    );
    emitAudit(indexTokens);
    return (
      finishPrepend(withAmbient(withProcedures(`${indexHeader}${indexContent}${indexFooter}`)), undefined, {
        indexedIds: indexIds,
      }) ?? undefined
    );
  }

  const header = "<relevant-memories>\nThe following memories may be relevant:\n";
  const footer = "\n</relevant-memories>";
  let usedTokens = estimateTokens(header + footer);
  const lines: string[] = [];
  const injectedIds: string[] = [];
  for (const x of candidates) {
    let text = sanitizeFactForInjection(useSummaryInInjection && x.entry.summary ? x.entry.summary : x.entry.text);
    if (!text) continue;
    if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) text = `${text.slice(0, maxPerMemoryChars).trim()}…`;
    const category = sanitizePromptInjection(x.entry.category);
    const line =
      injectionFormat === "minimal"
        ? `- ${text}`
        : injectionFormat === "short"
          ? `- ${category}: ${text}`
          : `- [${x.backend}/${category}] ${text}`;
    const lineTokens = estimateTokens(`${line}\n`);
    if (usedTokens + lineTokens > memoryTokenBudget) break;
    lines.push(line);
    injectedIds.push(x.entry.id);
    usedTokens += lineTokens;
  }

  if (lines.length === 0) {
    if (procedureBlock) {
      emitAudit(estimateTokens(recalledAmbient + procedureBlock));
      return finishPrepend(withAmbient(procedureBlock)) ?? undefined;
    }
    if (recalledAmbient) {
      emitAudit(estimateTokens(recalledAmbient));
      return finishPrepend(recalledAmbient) ?? undefined;
    }
    if (edictBlock) {
      emitAudit(estimateTokens(edictBlock));
      return finishPrepend("") ?? undefined;
    }
    return undefined;
  }

  let memoryContext = lines.join("\n");
  let accessRefreshIds = injectedIds;

  if (
    !options.skipLlmSummarize &&
    !options.abortSignal?.aborted &&
    summarizeWhenOverBudget &&
    lines.length < candidates.length
  ) {
    const summarizeStartedAt = recallTiming.phaseStarted("injection_summarize", {
      candidate_count: candidates.length,
    });
    const fullBullets = candidates
      .map((x) => {
        let text = sanitizePromptInjection(useSummaryInInjection && x.entry.summary ? x.entry.summary : x.entry.text);
        if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars)
          text = `${text.slice(0, maxPerMemoryChars).trim()}…`;
        const category = sanitizePromptInjection(x.entry.category);
        return injectionFormat === "minimal"
          ? `- ${text}`
          : injectionFormat === "short"
            ? `- ${category}: ${text}`
            : `- [${x.backend}/${category}] ${text}`;
      })
      .join("\n");
    try {
      const { withLLMRetry } = await import("../services/chat.js");
      const injectionSummarizeModel = summarizeModel ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "nano");
      const resp = await withLLMRetry(
        () => {
          if (options.abortSignal?.aborted) {
            throw Object.assign(new Error("injection stage aborted"), { name: "AbortError" });
          }
          return ctx.openai.chat.completions.create({
            model: injectionSummarizeModel,
            messages: [
              {
                role: "user",
                content: `Summarize these memories into 2-3 short sentences. Preserve key facts.\n\n${fullBullets.slice(0, 4000)}`,
              },
            ],
            temperature: 0,
            ...chatCompletionTokenParams(injectionSummarizeModel, 200),
          });
        },
        { maxRetries: 2 },
      );
      const summary = extractAssistantMessageText(resp.choices[0]?.message).text;
      if (summary) {
        let sanitizedSummary = sanitizePromptInjection(summary);
        let summaryTokens = estimateTokens(header + sanitizedSummary + footer);
        if (summaryTokens > memoryTokenBudget) {
          const maxSummaryChars = Math.max(80, memoryTokenBudget * 3);
          sanitizedSummary =
            sanitizedSummary.length > maxSummaryChars
              ? `${sanitizedSummary.slice(0, maxSummaryChars).trim()}…`
              : sanitizedSummary;
          summaryTokens = estimateTokens(header + sanitizedSummary + footer);
        }
        if (summaryTokens <= memoryTokenBudget) {
          memoryContext = sanitizedSummary;
          usedTokens = summaryTokens;
          accessRefreshIds = candidates.map((c) => c.entry.id);
          api.logger.info?.(`memory-hybrid: over budget — injected LLM summary (~${usedTokens} tokens)`);
          recallTiming.phaseCompleted("injection_summarize", summarizeStartedAt, {
            status: "ok",
            summary_chars: sanitizedSummary.length,
          });
        } else {
          recallTiming.phaseCompleted("injection_summarize", summarizeStartedAt, {
            status: "over_budget",
            summary_chars: sanitizedSummary.length,
          });
        }
      } else {
        recallTiming.phaseCompleted("injection_summarize", summarizeStartedAt, {
          status: "empty",
          summary_chars: 0,
        });
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "summarize-when-over-budget",
        subsystem: "auto-recall",
      });
      api.logger.warn(`memory-hybrid: summarize-when-over-budget failed: ${err}`);
      recallTiming.phaseCompleted("injection_summarize", summarizeStartedAt, { status: "error" });
    }
  }

  if (!memoryContext) {
    if (procedureBlock) {
      emitAudit(estimateTokens(recalledAmbient + procedureBlock));
      return finishPrepend(withAmbient(procedureBlock)) ?? undefined;
    }
    if (recalledAmbient) {
      emitAudit(estimateTokens(recalledAmbient));
      return finishPrepend(recalledAmbient) ?? undefined;
    }
    if (edictBlock) {
      emitAudit(estimateTokens(edictBlock));
      return finishPrepend("") ?? undefined;
    }
    return undefined;
  }

  if (!options.skipLlmSummarize && (!summarizeWhenOverBudget || lines.length >= candidates.length)) {
    api.logger.info?.(`memory-hybrid: injecting ${lines.length} memories (~${usedTokens} tokens)`);
  }

  emitAudit(usedTokens);

  return (
    finishPrepend(withAmbient(withProcedures(`${header}${memoryContext}${footer}`)), undefined, {
      accessedIds: accessRefreshIds,
    }) ?? undefined
  );
}
