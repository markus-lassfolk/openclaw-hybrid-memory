/**
 * Lifecycle stage: Injection (Phase 2.3).
 * Builds prependContext from RecallResult: progressive_hybrid, progressive, or full/short/minimal
 * formatting; wrapRecalledContext, markDegradedLatency; refreshAccessedFacts, Hebbian.
 * Timeout: 10s.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { createRecallSpan, createRecallTimingLogger } from "../services/recall-timing.js";
import { estimateTokens, estimateTokensForDisplay, formatProgressiveIndexLine } from "../utils/text.js";
import { withTimeout } from "../utils/timeout.js";
import type { LifecycleContext, RecallResult } from "./types.js";

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
      factsDb.strengthenRelatedLinksBatch(pairs);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "hebbian-strengthen",
        subsystem: "stage-injection",
      });
      logger.warn(`memory-hybrid: hebbian link strengthening failed: ${err}`);
    }
  });
}

export async function runInjectionStage(
  recallResult: RecallResult,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
): Promise<{ prependContext: string } | undefined> {
  return withTimeout(INJECTION_STAGE_TIMEOUT_MS, () => runInjection(recallResult, api, ctx), undefined);
}

/** Get the edict block for forced prompt injection (always preserved, never trimmed). */
function buildEdictBlock(ctx: LifecycleContext): string {
  try {
    const { renderForPrompt } = ctx.edictStore.getEdicts({ format: "prompt" });
    return renderForPrompt;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "stage-injection",
      operation: "get-edicts",
    });
    return "";
  }
}

async function runInjection(
  r: RecallResult,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
): Promise<{ prependContext: string } | undefined> {
  const recallTiming = createRecallTimingLogger({
    logger: api.logger,
    mode: ctx.cfg.autoRecall.recallTiming ?? "off",
    span: recallResult.recallSpan || createRecallSpan("recall-injection"),
    op: "auto-recall-injection",
  });

  const wrapRecalledContext = (content: string): string =>
    content ? `<recalled-context>\n${content}\n</recalled-context>` : "";

  const markDegradedLatency = (content: string): string => {
    if (r.degradationMaxLatencyMs > 0 && Date.now() - r.recallStartMs > r.degradationMaxLatencyMs) {
      api.logger.debug?.(
        `memory-hybrid: recall degraded (latency ${Date.now() - r.recallStartMs}ms > ${r.degradationMaxLatencyMs}ms)`,
      );
      return `<!-- recall degraded: latency -->\n${content}`;
    }
    return content;
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
    lastProgressiveIndexIdsRef,
    ambientCfg,
    ambientSeenFacts,
  } = r;
  const edictBlock = buildEdictBlock(ctx);
  const baseContext = edictBlock + issueBlock + narrativeBlock + hotBlock;

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
      const title = x.entry.key
        ? `${x.entry.entity ? `${x.entry.entity}: ` : ""}${x.entry.key}`
        : x.entry.summary || x.entry.text.slice(0, 60).trim() + (x.entry.text.length > 60 ? "…" : "");
      const tokenCost = estimateTokensForDisplay(x.entry.summary || x.entry.text);
      const pos = startPosition + indexEntries.length;
      const line = formatProgressiveIndexLine(x.entry.category, title, tokenCost, pos);
      const lineTokens = estimateTokens(`${line}\n`);
      if (usedTokens + lineTokens > cap) break;
      indexEntries.push({ line, id: x.entry.id, category: x.entry.category, position: pos });
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
        const entries = byCat.get(cat)!;
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
      const recallCount = x.entry.recallCount ?? 0;
      if (x.entry.decayClass === "permanent" || recallCount >= pinnedRecallThreshold) pinned.push(x);
      else rest.push(x);
    }
    const pinnedHeader = '<relevant-memories format="progressive_hybrid">\n';
    const pinnedPart: string[] = [];
    let pinnedTokens = estimateTokens(pinnedHeader);
    const pinnedBudget = Math.min(maxTokens, Math.floor(maxTokens * 0.6));
    for (const x of pinned) {
      let text = useSummaryInInjection && x.entry.summary ? x.entry.summary : x.entry.text;
      if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars)
        text = `${text.slice(0, maxPerMemoryChars).trim()}…`;
      const line = `- [${x.backend}/${x.entry.category}] ${text}`;
      const lineTokens = estimateTokens(`${line}\n`);
      if (pinnedTokens + lineTokens > pinnedBudget) break;
      pinnedPart.push(line);
      pinnedTokens += lineTokens;
    }
    const indexIntro =
      pinnedPart.length > 0
        ? `\nOther memories (index — use memory_recall(id: N) or memory_recall("query") to fetch):\n`
        : `<relevant-memories format="index">\n`;
    const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
    const indexBudget = indexCap - estimateTokens(pinnedHeader + pinnedPart.join("\n") + indexIntro + indexFooter);
    if (indexBudget <= 0) {
      lastProgressiveIndexIdsRef.length = 0;
      api.logger.debug?.(
        `memory-hybrid: progressive index budget exhausted by fixed blocks (indexCap=${indexCap} tokens); no index will be injected`,
      );
      if (pinnedPart.length > 0) {
        const pinnedIds = pinned.map((x) => x.entry.id);
        ctx.factsDb.refreshAccessedFacts(pinnedIds);
        if (ambientSeenFacts) ambientSeenFacts.markSeen(pinnedIds);
        if (ctx.cfg.graph.enabled && ctx.cfg.graph.strengthenOnRecall && pinnedIds.length >= 2) {
          strengthenHebbianLinks(pinnedIds, ctx.factsDb, api.logger);
        }
        const fullContent = `${pinnedHeader}${pinnedPart.join("\n")}\n</relevant-memories>`;
        api.logger.info?.(
          `memory-hybrid: progressive_hybrid — ${pinnedPart.length} pinned in full, no index (~${pinnedTokens} tokens)`,
        );
        return {
          prependContext: markDegradedLatency(wrapRecalledContext(baseContext + withProcedures(fullContent))),
        };
      }
      if (procedureBlock) {
        return { prependContext: markDegradedLatency(wrapRecalledContext(baseContext + procedureBlock)) };
      }
      const combinedContext = baseContext;
      return combinedContext
        ? { prependContext: markDegradedLatency(wrapRecalledContext(combinedContext)) }
        : undefined;
    }
    const { lines: indexLines, ids: indexIds } = buildProgressiveIndex(rest, indexBudget, 1);
    lastProgressiveIndexIdsRef.length = 0;
    lastProgressiveIndexIdsRef.push(...indexIds);
    if (pinnedPart.length > 0) ctx.factsDb.refreshAccessedFacts(pinned.map((x) => x.entry.id));
    if (indexIds.length > 0) ctx.factsDb.refreshAccessedFacts(indexIds);
    const allIds = [...pinned.map((x) => x.entry.id), ...indexIds];
    if (ambientSeenFacts && allIds.length > 0) ambientSeenFacts.markSeen(allIds);
    if (ctx.cfg.graph.enabled && ctx.cfg.graph.strengthenOnRecall && allIds.length >= 2) {
      strengthenHebbianLinks(allIds, ctx.factsDb, api.logger);
    }
    const indexContent = indexLines.join("\n");
    const fullContent =
      pinnedPart.length > 0
        ? `${pinnedHeader}${pinnedPart.join("\n")}${indexIntro}${indexContent}${indexFooter}`
        : `${indexIntro}${indexContent}${indexFooter}`;
    api.logger.info?.(
      `memory-hybrid: progressive_hybrid — ${pinnedPart.length} pinned in full, index of ${indexIds.length} (~${pinnedTokens + estimateTokens(indexContent)} tokens)`,
    );
    return {
      prependContext: markDegradedLatency(wrapRecalledContext(baseContext + withProcedures(fullContent))),
    };
  }

  if (injectionFormat === "progressive") {
    const indexHeader = `<relevant-memories format="index">\n`;
    const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
    const {
      lines: indexLines,
      ids: indexIds,
      usedTokens: indexTokens,
    } = buildProgressiveIndex(candidates, indexCap - estimateTokens(indexHeader + indexFooter), 1);
    if (indexLines.length === 0) {
      if (procedureBlock) {
        return { prependContext: markDegradedLatency(wrapRecalledContext(baseContext + procedureBlock)) };
      }
      const combinedContext = baseContext;
      return combinedContext
        ? { prependContext: markDegradedLatency(wrapRecalledContext(combinedContext)) }
        : undefined;
    }
    lastProgressiveIndexIdsRef.length = 0;
    lastProgressiveIndexIdsRef.push(...indexIds);
    ctx.factsDb.refreshAccessedFacts(indexIds);
    if (ambientSeenFacts && indexIds.length > 0) ambientSeenFacts.markSeen(indexIds);
    if (ctx.cfg.graph.enabled && ctx.cfg.graph.strengthenOnRecall && indexIds.length >= 2) {
      strengthenHebbianLinks(indexIds, ctx.factsDb, api.logger);
    }
    const indexContent = indexLines.join("\n");
    api.logger.info?.(
      `memory-hybrid: progressive disclosure — injecting index of ${indexLines.length} memories (~${indexTokens} tokens)`,
    );
    return {
      prependContext: markDegradedLatency(
        wrapRecalledContext(baseContext + withProcedures(`${indexHeader}${indexContent}${indexFooter}`)),
      ),
    };
  }

  const header = "<relevant-memories>\nThe following memories may be relevant:\n";
  const footer = "\n</relevant-memories>";
  let usedTokens = estimateTokens(header + footer);
  const lines: string[] = [];
  const injectedIds: string[] = [];
  for (const x of candidates) {
    let text = useSummaryInInjection && x.entry.summary ? x.entry.summary : x.entry.text;
    if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) text = `${text.slice(0, maxPerMemoryChars).trim()}…`;
    const line =
      injectionFormat === "minimal"
        ? `- ${text}`
        : injectionFormat === "short"
          ? `- ${x.entry.category}: ${text}`
          : `- [${x.backend}/${x.entry.category}] ${text}`;
    const lineTokens = estimateTokens(`${line}\n`);
    if (usedTokens + lineTokens > maxTokens) break;
    lines.push(line);
    injectedIds.push(x.entry.id);
    usedTokens += lineTokens;
  }

  if (lines.length === 0) {
    if (procedureBlock) {
      return { prependContext: markDegradedLatency(wrapRecalledContext(baseContext + procedureBlock)) };
    }
    const combinedContext = baseContext;
    return combinedContext ? { prependContext: markDegradedLatency(wrapRecalledContext(combinedContext)) } : undefined;
  }

  ctx.factsDb.refreshAccessedFacts(injectedIds);
  if (ambientSeenFacts) ambientSeenFacts.markSeen(injectedIds);
  if (ctx.cfg.graph.enabled && ctx.cfg.graph.strengthenOnRecall && injectedIds.length >= 2) {
    strengthenHebbianLinks(injectedIds, ctx.factsDb, api.logger);
  }

  let memoryContext = lines.join("\n");

  if (summarizeWhenOverBudget && lines.length < candidates.length) {
    const summarizeStartedAt = recallTiming.phaseStarted("injection_summarize", {
      candidate_count: candidates.length,
    });
    const fullBullets = candidates
      .map((x) => {
        let text = useSummaryInInjection && x.entry.summary ? x.entry.summary : x.entry.text;
        if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars)
          text = `${text.slice(0, maxPerMemoryChars).trim()}…`;
        return injectionFormat === "minimal"
          ? `- ${text}`
          : injectionFormat === "short"
            ? `- ${x.entry.category}: ${text}`
            : `- [${x.backend}/${x.entry.category}] ${text}`;
      })
      .join("\n");
    try {
      const { withLLMRetry } = await import("../services/chat.js");
      const resp = await withLLMRetry(
        () =>
          ctx.openai.chat.completions.create({
            model: summarizeModel ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "nano"),
            messages: [
              {
                role: "user",
                content: `Summarize these memories into 2-3 short sentences. Preserve key facts.\n\n${fullBullets.slice(0, 4000)}`,
              },
            ],
            temperature: 0,
            max_tokens: 200,
          }),
        { maxRetries: 2 },
      );
      const summary = (resp.choices[0]?.message?.content ?? "").trim();
      if (summary) {
        memoryContext = summary;
        usedTokens = estimateTokens(header + memoryContext + footer);
        api.logger.info?.(`memory-hybrid: over budget — injected LLM summary (~${usedTokens} tokens)`);
        recallTiming.phaseCompleted("injection_summarize", summarizeStartedAt, {
          status: "ok",
          summary_chars: summary.length,
        });
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
      return { prependContext: markDegradedLatency(wrapRecalledContext(baseContext + procedureBlock)) };
    }
    const combinedContext = baseContext;
    return combinedContext ? { prependContext: markDegradedLatency(wrapRecalledContext(combinedContext)) } : undefined;
  }

  if (!summarizeWhenOverBudget || lines.length >= candidates.length) {
    api.logger.info?.(`memory-hybrid: injecting ${lines.length} memories (~${usedTokens} tokens)`);
  }

  return {
    prependContext: markDegradedLatency(
      wrapRecalledContext(baseContext + withProcedures(`${header}${memoryContext}${footer}`)),
    ),
  };
}
