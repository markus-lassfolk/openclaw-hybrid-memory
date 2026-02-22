/**
 * Lifecycle Hooks
 *
 * Extracted from index.ts - handles lifecycle events (before_agent_start, agent_end)
 * for auto-recall, auto-capture, tiering, credentials, and auth failure detection.
 */

import { existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import { getDefaultCronModel, getCronModelConfig } from "../config.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "../services/embeddings.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "../types/memory.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import { chatComplete } from "../services/chat.js";
import { computeDynamicSalience } from "../utils/salience.js";
import { estimateTokens, estimateTokensForDisplay, formatProgressiveIndexLine, truncateForStorage } from "../utils/text.js";
import { extractTags } from "../utils/tags.js";
import { CLI_STORE_IMPORTANCE, getRestartPendingPath } from "../utils/constants.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { VAULT_POINTER_PREFIX, detectCredentialPatterns } from "../services/auto-capture.js";
import { classifyMemoryOperation } from "../services/classification.js";
import { detectAuthFailure, buildCredentialQuery, formatCredentialHint, DEFAULT_AUTH_FAILURE_PATTERNS, type AuthFailurePattern } from "../services/auth-failure-detect.js";
import { extractCredentialsFromToolCalls } from "../services/credential-scanner.js";
import { capturePluginError, addOperationBreadcrumb } from "../services/error-reporter.js";

export interface LifecycleContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  currentAgentIdRef: { value: string | null };
  lastProgressiveIndexIds: string[];
  restartPendingCleared: boolean;
  resolvedSqlitePath: string;
  walWrite: (operation: "store" | "update", data: Record<string, unknown>, logger: { warn: (msg: string) => void }) => string;
  walRemove: (id: string, logger: { warn: (msg: string) => void }) => void;
  findSimilarByEmbedding: (
    vectorDb: VectorDB,
    factsDb: { getById(id: string): MemoryEntry | null },
    vector: number[],
    limit: number,
    minScore?: number,
  ) => Promise<MemoryEntry[]>;
  shouldCapture: (text: string) => boolean;
  detectCategory: (text: string) => MemoryCategory;
}

export function createLifecycleHooks(ctx: LifecycleContext) {
  // Mutable refs that need to be updated across hooks
  // Note: currentAgentIdRef is already a mutable ref object from index.ts
  const currentAgentIdRef = ctx.currentAgentIdRef;
  let lastProgressiveIndexIds = ctx.lastProgressiveIndexIds;
  let restartPendingCleared = ctx.restartPendingCleared;

  // Track auth failures per target per session to avoid spam
  const authFailureRecallsThisSession = new Map<string, number>();

  const onAgentStart = (api: ClawdbotPluginApi) => {
    // Agent detection must run independently of autoRecall
    // to support multi-agent scoping even when autoRecall is disabled
    api.on("before_agent_start", async (event: unknown) => {
      if (!restartPendingCleared && existsSync(getRestartPendingPath())) {
        restartPendingCleared = true; // Set flag before unlink to prevent race
        try {
          unlinkSync(getRestartPendingPath());
        } catch (err: unknown) {
          // Ignore ENOENT (already deleted by another agent), propagate other errors
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "lifecycle",
              operation: "delete-restart-marker",
            });
            console.warn("Failed to delete restart marker:", err);
          }
        }
      }
      const e = event as { prompt?: string; agentId?: string; session?: { agentId?: string } };

      // Detect current agent identity at runtime
      // Try multiple sources: event payload, api.context, or keep current
      const detectedAgentId = e.agentId || e.session?.agentId || api.context?.agentId;
      if (detectedAgentId) {
        currentAgentIdRef.value = detectedAgentId;
        // Log successful detection at debug level to reduce log noise
        api.logger.debug?.(`memory-hybrid: Detected agentId: ${detectedAgentId}`);
      } else {
        // Issue #9: Log when agent detection fails - fall back to orchestrator or keep current
        api.logger.warn("memory-hybrid: Agent detection failed - no agentId in event payload or api.context, falling back to orchestrator");
        currentAgentIdRef.value = currentAgentIdRef.value || ctx.cfg.multiAgent.orchestratorId;
        if (ctx.cfg.multiAgent.defaultStoreScope === "agent" || ctx.cfg.multiAgent.defaultStoreScope === "auto") {
          api.logger.warn(`memory-hybrid: Agent detection failed but defaultStoreScope is "${ctx.cfg.multiAgent.defaultStoreScope}" - memories may be incorrectly scoped`);
        }
      }
    });

    if (ctx.cfg.autoRecall.enabled) {
      api.on("before_agent_start", async (event: unknown) => {
        const e = event as { prompt?: string; agentId?: string; session?: { agentId?: string } };

        if (!e.prompt || e.prompt.length < 5) return;

        try {
          // Use configurable candidate pool for progressive disclosure
          const fmt = ctx.cfg.autoRecall.injectionFormat;
          const isProgressive = fmt === "progressive" || fmt === "progressive_hybrid";
          const searchLimit = isProgressive
            ? (ctx.cfg.autoRecall.progressiveMaxCandidates ?? Math.max(ctx.cfg.autoRecall.limit, 15))
            : ctx.cfg.autoRecall.limit;
          const { minScore } = ctx.cfg.autoRecall;
          const limit = searchLimit;
          const tierFilter = ctx.cfg.memoryTiering.enabled ? "warm" : "all";

          // Build scope filter dynamically from detected agentId
          // Merge agent-detected scope with configured scopeFilter for multi-tenant support
          let scopeFilter: ScopeFilter | undefined;
          if (currentAgentIdRef.value && currentAgentIdRef.value !== ctx.cfg.multiAgent.orchestratorId) {
            // Specialist agent — merge with configured scopeFilter to preserve userId
            scopeFilter = {
              userId: ctx.cfg.autoRecall.scopeFilter?.userId ?? null,
              agentId: currentAgentIdRef.value,
              sessionId: ctx.cfg.autoRecall.scopeFilter?.sessionId ?? null,
            };
          } else if (
            ctx.cfg.autoRecall.scopeFilter &&
            (ctx.cfg.autoRecall.scopeFilter.userId || ctx.cfg.autoRecall.scopeFilter.agentId || ctx.cfg.autoRecall.scopeFilter.sessionId)
          ) {
            // Orchestrator or explicit config override
            scopeFilter = {
              userId: ctx.cfg.autoRecall.scopeFilter.userId ?? null,
              agentId: ctx.cfg.autoRecall.scopeFilter.agentId ?? null,
              sessionId: ctx.cfg.autoRecall.scopeFilter.sessionId ?? null,
            };
          } else {
            // No filter — orchestrator sees all (backward compatible)
            scopeFilter = undefined;
          }

          // Procedural memory: inject relevant procedures and negative warnings
          // Apply scope filter to procedure search
          let procedureBlock = "";
          if (ctx.cfg.procedures.enabled) {
            const rankedProcs = ctx.factsDb.searchProceduresRanked(e.prompt, 5, ctx.cfg.distill?.reinforcementProcedureBoost ?? 0.1, scopeFilter);
            const positiveFiltered = rankedProcs.filter((p) => p.procedureType === "positive" && p.relevanceScore > 0.4);
            const negativeUnfiltered = rankedProcs.filter((p) => p.procedureType === "negative");
            const procLines: string[] = [];

            // Positive procedures with relevance score
            const positiveList = positiveFiltered;
            if (positiveList.length > 0) {
              procLines.push("Last time this worked:");
              for (const p of positiveList.slice(0, 3)) {
                try {
                  const steps = (JSON.parse(p.recipeJson) as Array<{ tool?: string }>)
                    .map((s) => s.tool)
                    .filter(Boolean)
                    .join(" → ");
                  const emoji = p.relevanceScore >= 0.7 ? "✅" : "⚠️";
                  const confidence = Math.round(p.relevanceScore * 100);
                  procLines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 50)}… (${steps})`);
                } catch (err) {
                  capturePluginError(err as Error, {
                    operation: 'json-parse-recipe',
                    severity: 'info',
                    subsystem: 'lifecycle'
                  });
                  const emoji = p.relevanceScore >= 0.7 ? "✅" : "⚠️";
                  const confidence = Math.round(p.relevanceScore * 100);
                  procLines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 70)}…`);
                }
              }
            }

            // Negative procedures (known failures)
            const negs = negativeUnfiltered;
            if (negs.length > 0) {
              procLines.push("⚠️ Known issue (avoid):");
              for (const n of negs.slice(0, 2)) {
                try {
                  const emoji = n.relevanceScore >= 0.7 ? "❌" : "⚠️";
                  const confidence = Math.round(n.relevanceScore * 100);
                  const steps = (JSON.parse(n.recipeJson) as Array<{ tool?: string }>)
                    .map((s) => s.tool)
                    .filter(Boolean)
                    .join(" → ");
                  procLines.push(`- ${emoji} [${confidence}%] ${n.taskPattern.slice(0, 50)}… (${steps})`);
                } catch (err) {
                  capturePluginError(err as Error, {
                    operation: 'json-parse-recipe',
                    severity: 'info',
                    subsystem: 'lifecycle'
                  });
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

          // HOT tier — always inject first (cap by hotMaxTokens)
          let hotBlock = "";
          if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.hotMaxTokens > 0) {
            const hotResults = ctx.factsDb.getHotFacts(ctx.cfg.memoryTiering.hotMaxTokens, scopeFilter);
            if (hotResults.length > 0) {
              const hotLines = hotResults.map((r) => `- [hot/${r.entry.category}] ${(r.entry.summary || r.entry.text).slice(0, 200)}${(r.entry.summary || r.entry.text).length > 200 ? "…" : ""}`);
              hotBlock = `<hot-memories>\n${hotLines.join("\n")}\n</hot-memories>\n\n`;
            }
          }

          const ftsResults = ctx.factsDb.search(e.prompt, limit, {
            tierFilter,
            scopeFilter,
            reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
          });
          let lanceResults: SearchResult[] = [];
          try {
            let textToEmbed = e.prompt;
            if (ctx.cfg.search?.hydeEnabled) {
              try {
                const hydeModel = ctx.cfg.search.hydeModel ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "default");
                const hydeContent = await chatComplete({
                  model: hydeModel,
                  content: `Write a short factual statement (1-2 sentences) that answers: ${e.prompt}\n\nOutput only the statement, no preamble.`,
                  temperature: 0.3,
                  maxTokens: 150,
                  openai: ctx.openai,
                });
                const hydeText = hydeContent.trim();
                if (hydeText.length > 10) textToEmbed = hydeText;
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "hyde-generation",
                  subsystem: "auto-recall",
                });
                api.logger.warn(`memory-hybrid: HyDE generation failed, using raw prompt: ${err}`);
              }
            }
            const vector = await ctx.embeddings.embed(textToEmbed);
            lanceResults = await ctx.vectorDb.search(vector, limit * 2, minScore);
            lanceResults = filterByScope(lanceResults, (id, opts) => ctx.factsDb.getById(id, opts), scopeFilter);
            // Enrich lance results with full entry and apply dynamic salience
            lanceResults = lanceResults.map((r) => {
              const fullEntry = ctx.factsDb.getById(r.entry.id);
              if (fullEntry) {
                return {
                  ...r,
                  entry: fullEntry,
                  score: computeDynamicSalience(r.score, fullEntry),
                };
              }
              return r;
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: 'auto-recall-vector-search',
              subsystem: 'vector',
              phase: 'runtime',
              backend: 'lancedb',
            });
            api.logger.warn(
              `memory-hybrid: vector recall failed: ${err}`,
            );
          }

          let candidates = mergeResults(ftsResults, lanceResults, limit, ctx.factsDb);

          // Exclude COLD tier from auto-recall (only HOT + WARM)
          if (ctx.cfg.memoryTiering.enabled && candidates.length > 0) {
            candidates = candidates.filter((r) => {
              const full = ctx.factsDb.getById(r.entry.id);
              return full && full.tier !== "cold";
            }).slice(0, limit);
          }

          const { entityLookup } = ctx.cfg.autoRecall;
          if (entityLookup.enabled && entityLookup.entities.length > 0) {
            const promptLower = e.prompt.toLowerCase();
            const seenIds = new Set(candidates.map((c) => c.entry.id));
            for (const entity of entityLookup.entities) {
              if (!promptLower.includes(entity.toLowerCase())) continue;
              const entityResults = ctx.factsDb.lookup(entity, undefined, undefined, { scopeFilter }).slice(0, entityLookup.maxFactsPerEntity);
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

          if (candidates.length === 0) return hotBlock ? { prependContext: hotBlock } : undefined;

          {
            const nowSec = Math.floor(Date.now() / 1000);
            const NINETY_DAYS_SEC = 90 * 24 * 3600;
            const boosted = candidates.map((r) => {
              let s = r.score;
              if (ctx.cfg.autoRecall.preferLongTerm) {
                s *=
                  r.entry.decayClass === "permanent"
                    ? 1.2
                    : r.entry.decayClass === "stable"
                      ? 1.1
                      : 1;
              }
              if (ctx.cfg.autoRecall.useImportanceRecency) {
                const importanceFactor = 0.7 + 0.3 * r.entry.importance;
                const recencyFactor =
                  r.entry.lastConfirmedAt === 0
                    ? 1
                    : 0.8 +
                      0.2 *
                        Math.max(
                          0,
                          1 - (nowSec - r.entry.lastConfirmedAt) / NINETY_DAYS_SEC,
                        );
                s *= importanceFactor * recencyFactor;
              }
              // Access-count salience boost — frequently recalled facts score higher
              const recallCount = r.entry.recallCount ?? 0;
              if (recallCount > 0) {
                s *= 1 + 0.1 * Math.log(recallCount + 1);
              }
              return { ...r, score: s };
            });
            boosted.sort((a, b) => b.score - a.score);
            candidates = boosted;
          }

          const {
            maxTokens,
            maxPerMemoryChars,
            injectionFormat,
            useSummaryInInjection,
            summarizeWhenOverBudget,
            summarizeModel,
          } = ctx.cfg.autoRecall;

          // Progressive disclosure — inject a lightweight index, let the agent decide what to fetch
          const indexCap = ctx.cfg.autoRecall.progressiveIndexMaxTokens ?? maxTokens;
          const groupByCategory = ctx.cfg.autoRecall.progressiveGroupByCategory === true;

          function buildProgressiveIndex(
            list: typeof candidates,
            cap: number,
            startPosition: number,
          ): { lines: string[]; ids: string[]; usedTokens: number } {
            const totalTokens = list.reduce((sum, r) => {
              const t = r.entry.summary || r.entry.text;
              return sum + estimateTokensForDisplay(t);
            }, 0);
            const header = `📋 Available memories (${list.length} matches, ~${totalTokens} tokens total):\n`;
            let usedTokens = estimateTokens(header);
            const indexEntries: { line: string; id: string; category: string; position: number }[] = [];
            for (let i = 0; i < list.length; i++) {
              const r = list[i];
              const title = r.entry.key
                ? `${r.entry.entity ? r.entry.entity + ": " : ""}${r.entry.key}`
                : (r.entry.summary || r.entry.text.slice(0, 60).trim() + (r.entry.text.length > 60 ? "…" : ""));
              const tokenCost = estimateTokensForDisplay(r.entry.summary || r.entry.text);
              const pos = startPosition + indexEntries.length;
              const line = formatProgressiveIndexLine(r.entry.category, title, tokenCost, pos);
              const lineTokens = estimateTokens(line + "\n");
              if (usedTokens + lineTokens > cap) break;
              indexEntries.push({ line, id: r.entry.id, category: r.entry.category, position: pos });
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
                  // Keep numeric position for memory_recall(id: N) to work
                  lines.push(e.line.replace(/^(\s+)(\d+\.)/, "  $2"));
                }
              }
            } else {
              lines = [header.trimEnd(), ...indexEntries.map((e) => e.line)];
            }
            return { lines, ids, usedTokens };
          }

          if (injectionFormat === "progressive_hybrid") {
            // Hybrid: pinned (permanent or high recall count) in full, rest as index
            const pinnedRecallThreshold = ctx.cfg.autoRecall.progressivePinnedRecallCount ?? 3;
            const pinned: typeof candidates = [];
            const rest: typeof candidates = [];
            for (const r of candidates) {
              const recallCount = r.entry.recallCount ?? 0;
              if (
                r.entry.decayClass === "permanent" ||
                recallCount >= pinnedRecallThreshold
              ) {
                pinned.push(r);
              } else {
                rest.push(r);
              }
            }
            const pinnedHeader = "<relevant-memories format=\"progressive_hybrid\">\n";
            const pinnedPart: string[] = [];
            let pinnedTokens = estimateTokens(pinnedHeader);
            const pinnedBudget = Math.min(maxTokens, Math.floor(maxTokens * 0.6));
            for (const r of pinned) {
              let text =
                useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
              if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
                text = text.slice(0, maxPerMemoryChars).trim() + "…";
              }
              const line = `- [${r.backend}/${r.entry.category}] ${text}`;
              const lineTokens = estimateTokens(line + "\n");
              if (pinnedTokens + lineTokens > pinnedBudget) break;
              pinnedPart.push(line);
              pinnedTokens += lineTokens;
            }
            const indexIntro = pinnedPart.length > 0
              ? `\nOther memories (index — use memory_recall(id: N) or memory_recall("query") to fetch):\n`
              : `<relevant-memories format="index">\n`;
            const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
            const indexBudget = indexCap - estimateTokens(pinnedHeader + pinnedPart.join("\n") + indexIntro + indexFooter);
            const { lines: indexLines, ids: indexIds } = buildProgressiveIndex(
              rest,
              Math.max(100, indexBudget),
              1,
            );
            lastProgressiveIndexIds = indexIds;
            ctx.lastProgressiveIndexIds = indexIds;
            if (pinnedPart.length > 0) {
              ctx.factsDb.refreshAccessedFacts(pinned.map((r) => r.entry.id));
            }
            if (indexIds.length > 0) {
              ctx.factsDb.refreshAccessedFacts(indexIds);
            }
            // Hebbian: Strengthen RELATED_TO links between facts recalled together
            const allIds = [...pinned.map((r) => r.entry.id), ...indexIds];
            if (ctx.cfg.graph.enabled && allIds.length >= 2) {
              for (let i = 0; i < allIds.length; i++) {
                for (let j = i + 1; j < allIds.length; j++) {
                  ctx.factsDb.createOrStrengthenRelatedLink(allIds[i], allIds[j]);
                }
              }
            }
            const indexContent = indexLines.join("\n");
            const fullContent =
              pinnedPart.length > 0
                ? `${pinnedHeader}${pinnedPart.join("\n")}${indexIntro}${indexContent}${indexFooter}`
                : `${indexIntro}${indexContent}${indexFooter}`;
            api.logger.info?.(
              `memory-hybrid: progressive_hybrid — ${pinnedPart.length} pinned in full, index of ${indexIds.length} (~${pinnedTokens + estimateTokens(indexContent)} tokens)`,
            );
            return { prependContext: hotBlock + withProcedures(fullContent) };
          }

          if (injectionFormat === "progressive") {
            const indexHeader = `<relevant-memories format="index">\n`;
            const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
            const { lines: indexLines, ids: indexIds, usedTokens: indexTokens } = buildProgressiveIndex(
              candidates,
              indexCap - estimateTokens(indexHeader + indexFooter),
              1,
            );
            if (indexLines.length === 0) {
              if (procedureBlock) {
                return { prependContext: hotBlock + procedureBlock };
              }
              return hotBlock ? { prependContext: hotBlock } : undefined;
            }
            lastProgressiveIndexIds = indexIds;
            ctx.lastProgressiveIndexIds = indexIds;
            const includedIds = indexIds;
            ctx.factsDb.refreshAccessedFacts(includedIds);
            // Hebbian: Strengthen RELATED_TO links between facts recalled together
            if (ctx.cfg.graph.enabled && includedIds.length >= 2) {
              for (let i = 0; i < includedIds.length; i++) {
                for (let j = i + 1; j < includedIds.length; j++) {
                  ctx.factsDb.createOrStrengthenRelatedLink(includedIds[i], includedIds[j]);
                }
              }
            }
            const indexContent = indexLines.join("\n");
            api.logger.info?.(
              `memory-hybrid: progressive disclosure — injecting index of ${indexLines.length} memories (~${indexTokens} tokens)`,
            );
            return {
              prependContext: hotBlock + withProcedures(`${indexHeader}${indexContent}${indexFooter}`),
            };
          }

          const header = "<relevant-memories>\nThe following memories may be relevant:\n";
          const footer = "\n</relevant-memories>";
          let usedTokens = estimateTokens(header + footer);

          const lines: string[] = [];
          const injectedIds: string[] = [];
          for (const r of candidates) {
            let text =
              useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
            if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
              text = text.slice(0, maxPerMemoryChars).trim() + "…";
            }
            const line =
              injectionFormat === "minimal"
                ? `- ${text}`
                : injectionFormat === "short"
                  ? `- ${r.entry.category}: ${text}`
                  : `- [${r.backend}/${r.entry.category}] ${text}`;
            const lineTokens = estimateTokens(line + "\n");
            if (usedTokens + lineTokens > maxTokens) break;
            lines.push(line);
            injectedIds.push(r.entry.id);
            usedTokens += lineTokens;
          }

          if (lines.length === 0) {
            if (procedureBlock) {
              return { prependContext: hotBlock + procedureBlock };
            }
            return hotBlock ? { prependContext: hotBlock } : undefined;
          }

          // Access tracking for injected memories
          ctx.factsDb.refreshAccessedFacts(injectedIds);
          // Hebbian: Strengthen RELATED_TO links between facts recalled together
          if (ctx.cfg.graph.enabled && injectedIds.length >= 2) {
            for (let i = 0; i < injectedIds.length; i++) {
              for (let j = i + 1; j < injectedIds.length; j++) {
                ctx.factsDb.createOrStrengthenRelatedLink(injectedIds[i], injectedIds[j]);
              }
            }
          }

          let memoryContext = lines.join("\n");

          if (summarizeWhenOverBudget && lines.length < candidates.length) {
            const fullBullets = candidates
              .map((r) => {
                let text =
                  useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
                if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
                  text = text.slice(0, maxPerMemoryChars).trim() + "…";
                }
                return injectionFormat === "minimal"
                  ? `- ${text}`
                  : injectionFormat === "short"
                    ? `- ${r.entry.category}: ${text}`
                    : `- [${r.backend}/${r.entry.category}] ${text}`;
              })
              .join("\n");
            try {
              const { withLLMRetry } = await import("../services/chat.js");
              const resp = await withLLMRetry(
                () => ctx.openai.chat.completions.create({
                  model: summarizeModel,
                  messages: [
                    {
                      role: "user",
                      content: `Summarize these memories into 2-3 short sentences. Preserve key facts.\n\n${fullBullets.slice(0, 4000)}`,
                    },
                  ],
                  temperature: 0,
                  max_tokens: 200,
                }),
                { maxRetries: 2 }
              );
              const summary = (resp.choices[0]?.message?.content ?? "").trim();
              if (summary) {
                memoryContext = summary;
                usedTokens = estimateTokens(header + memoryContext + footer);
                api.logger.info?.(
                  `memory-hybrid: over budget — injected LLM summary (~${usedTokens} tokens)`,
                );
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: "summarize-when-over-budget",
                subsystem: "auto-recall",
              });
              api.logger.warn(`memory-hybrid: summarize-when-over-budget failed: ${err}`);
            }
          }

          if (!memoryContext) {
            if (procedureBlock) {
              return { prependContext: hotBlock + procedureBlock };
            }
            return hotBlock ? { prependContext: hotBlock } : undefined;
          }

          if (!summarizeWhenOverBudget || lines.length >= candidates.length) {
            api.logger.info?.(
              `memory-hybrid: injecting ${lines.length} memories (sqlite: ${ftsResults.length}, lance: ${lanceResults.length}, ~${usedTokens} tokens)`,
            );
          }

          return {
            prependContext: hotBlock + withProcedures(`${header}${memoryContext}${footer}`),
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "recall",
            subsystem: "auto-recall",
          });
          api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-recall on authentication failures (reactive memory trigger)
    if (ctx.cfg.autoRecall.enabled && ctx.cfg.autoRecall.authFailure.enabled) {
      // Compile custom patterns once at handler registration time
      const customPatterns: AuthFailurePattern[] = [];
      for (const p of ctx.cfg.autoRecall.authFailure.patterns) {
        try {
          customPatterns.push({
            regex: new RegExp(p, "i"),
            type: "generic" as const,
            hint: p,
          });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "auth-failure-regex",
            subsystem: "auto-recall",
          });
          api.logger.warn?.(`memory-hybrid: invalid regex pattern "${p}": ${err}`);
        }
      }

      // Merge with default patterns (config patterns should not include defaults to avoid duplication)
      const allPatterns = [...DEFAULT_AUTH_FAILURE_PATTERNS, ...customPatterns];

      // Note: Multiple before_agent_start handlers exist in this plugin:
      // 1. Main auto-recall (procedures + facts)
      // 2. Auth failure recall (this one)
      // 3. Credential auto-detect
      // OpenClaw's event system merges returned { prependContext } by concatenation.
      // Order: main auto-recall runs first, then this auth-failure handler, then credential auto-detect.
      api.on("before_agent_start", async (event: unknown) => {
        const e = event as { prompt?: string; messages?: unknown[] };
        if (!e.prompt && (!e.messages || !Array.isArray(e.messages))) return;

        try {

          // Scan prompt for auth failures
          let textToScan = e.prompt || "";

          // Also scan recent messages if available (tool results might be there)
          if (e.messages && Array.isArray(e.messages)) {
            const recentMessages = e.messages.slice(-5); // Last 5 messages
            for (const msg of recentMessages) {
              if (!msg || typeof msg !== "object") continue;
              const msgObj = msg as Record<string, unknown>;
              const content = msgObj.content;
              if (typeof content === "string") {
                textToScan += "\n" + content;
              }
            }
          }

          // Detect auth failure
          const detection = detectAuthFailure(textToScan, allPatterns);
          if (!detection.detected || !detection.target) return;

          // Check if we've already recalled for this target in this session
          const recallCount = authFailureRecallsThisSession.get(detection.target) || 0;
          const maxRecalls = ctx.cfg.autoRecall.authFailure.maxRecallsPerTarget;
          if (maxRecalls > 0 && recallCount >= maxRecalls) {
            // Use debug level to avoid log spam for repeated failures
            api.logger.debug?.(`memory-hybrid: auth failure for ${detection.target} already recalled ${recallCount} times this session, skipping`);
            return;
          }

          // Build credential query
          const query = buildCredentialQuery(detection);
          if (!query) return;

          api.logger.info?.(`memory-hybrid: auth failure detected for ${detection.target} (${detection.hint}), searching for credentials...`);

          // Search for credential facts
          // Apply scope filter (global + current agent)
          const detectedAgentId = currentAgentIdRef.value || ctx.cfg.multiAgent.orchestratorId;
          const scopeFilter: ScopeFilter | undefined = detectedAgentId && detectedAgentId !== ctx.cfg.multiAgent.orchestratorId
            ? { userId: ctx.cfg.autoRecall.scopeFilter?.userId ?? null, agentId: detectedAgentId, sessionId: ctx.cfg.autoRecall.scopeFilter?.sessionId ?? null }
            : undefined;

          // Search both SQLite and vector backends
          const ftsResults = ctx.factsDb.search(query, 5, { scopeFilter });
          const vector = await ctx.embeddings.embed(query);
          let lanceResults = await ctx.vectorDb.search(vector, 5, 0.3);

          // Filter LanceDB results by scope using filterByScope (LanceDB doesn't store scope metadata)
          lanceResults = filterByScope(lanceResults, (id, opts) => ctx.factsDb.getById(id, opts), scopeFilter);

          // Merge and filter for credential-related facts
          const merged = mergeResults(
            ftsResults.map((r) => ({ ...r, backend: "sqlite" as const })),
            lanceResults.map((r) => ({ ...r, backend: "lancedb" as const })),
            5,
            ctx.factsDb,
          );

          // Validate merged results against scope (merged results may not have scope metadata)
          const scopeValidatedMerged = scopeFilter
            ? merged.filter((r) => ctx.factsDb.getById(r.entry.id, { scopeFilter }) != null)
            : merged;

          // Filter to technical/credential facts
          let credentialFacts = scopeValidatedMerged
            .filter((r) => {
              const fact = r.entry;
              if (fact.category === "technical") return true;
              if (fact.entity?.toLowerCase() === "credentials") return true;
              const tags = fact.tags || [];
              return tags.some((t) => ["credential", "ssh", "token", "api", "auth", "password"].includes(t.toLowerCase()));
            });

          // Filter out vault pointers if includeVaultHints is false
          if (!ctx.cfg.autoRecall.authFailure.includeVaultHints) {
            credentialFacts = credentialFacts.filter((r) => {
              const fact = r.entry;
              return !fact.text.includes("stored in secure vault") &&
                     (!fact.value || !String(fact.value).startsWith(VAULT_POINTER_PREFIX));
            });
          }

          credentialFacts = credentialFacts.slice(0, 3);

          if (credentialFacts.length === 0) {
            api.logger.info?.(`memory-hybrid: no credential facts found for ${detection.target}`);
            return;
          }

          // Format hint and inject
          const hint = formatCredentialHint(detection, credentialFacts.map((r) => r.entry));
          if (hint) {
            // Inject as prepended context (this will be added to the prompt)
            api.logger.info?.(`memory-hybrid: injecting ${credentialFacts.length} credential facts for ${detection.target}`);

            // Track this recall
            authFailureRecallsThisSession.set(detection.target, recallCount + 1);

            // Return the hint to be injected
            // Hook contract validation: OpenClaw's before_agent_start hook must support
            // returning { prependContext: string } which is automatically prepended to the
            // agent's prompt. This is documented in OpenClaw's plugin API.
            // If this contract changes or is not supported in your OpenClaw version,
            // this will fail silently (hint won't be injected). Alternative injection
            // mechanisms would be: tool response text, or system message via API.
            return { prependContext: hint + "\n\n" };
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "auth-failure-recall",
            subsystem: "auto-recall",
          });
          api.logger.warn(`memory-hybrid: auth failure recall failed: ${String(err)}`);
        }
      });
    }

    // Credential auto-detect: when patterns found in conversation, persist hint for next turn
    if (ctx.cfg.credentials.enabled && ctx.cfg.credentials.autoDetect) {
      const pendingPath = join(dirname(ctx.resolvedSqlitePath), "credentials-pending.json");
      const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min

      api.on("before_agent_start", async () => {
        try {
          await access(pendingPath);
        } catch {
          return; // File doesn't exist — no pending credentials, normal case
        }
        try {
          const raw = await readFile(pendingPath, "utf-8");
          const data = JSON.parse(raw) as { hints?: string[]; at?: number };
          const at = typeof data.at === "number" ? data.at : 0;
          if (Date.now() - at > PENDING_TTL_MS) {
            await unlink(pendingPath).catch(() => {});
            return;
          }
          const hints = Array.isArray(data.hints) ? data.hints : [];
          if (hints.length === 0) {
            await unlink(pendingPath).catch(() => {});
            return;
          }
          await unlink(pendingPath).catch(() => {});
          const hintText = hints.join(", ");
          return {
            prependContext: `\n<credential-hint>\nA credential may have been shared in the previous exchange (${hintText}). Consider asking the user if they want to store it securely with credential_store.\n</credential-hint>\n`,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "credential-hint-read",
            subsystem: "credentials",
          });
          await unlink(pendingPath).catch(() => {});
        }
      });
    }
  };

  const onAgentEnd = (api: ClawdbotPluginApi) => {
    // Clear auth failure dedup map on session end
    if (ctx.cfg.autoRecall.enabled && ctx.cfg.autoRecall.authFailure.enabled) {
      api.on("agent_end", async () => {
        authFailureRecallsThisSession.clear();
        api.logger.info?.("memory-hybrid: cleared auth failure recall dedup map for new session");
      });
    }

    // Compaction on session end — migrate completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT
    if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.compactionOnSessionEnd) {
      api.on("agent_end", async () => {
        try {
          const counts = ctx.factsDb.runCompaction({
            inactivePreferenceDays: ctx.cfg.memoryTiering.inactivePreferenceDays,
            hotMaxTokens: ctx.cfg.memoryTiering.hotMaxTokens,
            hotMaxFacts: ctx.cfg.memoryTiering.hotMaxFacts,
          });
          if (counts.hot + counts.warm + counts.cold > 0) {
            api.logger.info?.(`memory-hybrid: tier compaction — hot=${counts.hot} warm=${counts.warm} cold=${counts.cold}`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "compaction",
            subsystem: "memory-tiering",
          });
          api.logger.warn(`memory-hybrid: compaction failed: ${err}`);
        }
      });
    }

    if (ctx.cfg.autoCapture) {
      api.on("agent_end", async (event: unknown) => {
        const ev = event as { success?: boolean; messages?: unknown[] };
        if (!ev.success || !ev.messages || ev.messages.length === 0) {
          return;
        }

        try {
          const texts: string[] = [];
          for (const msg of ev.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            const content = msgObj.content;
            if (typeof content === "string") {
              texts.push(content);
              continue;
            }
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push(
                    (block as Record<string, unknown>).text as string,
                  );
                }
              }
            }
          }

          const toCapture = texts.filter((t) => t && ctx.shouldCapture(t));
          if (toCapture.length === 0) return;

          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            let textToStore = text;
            textToStore = truncateForStorage(textToStore, ctx.cfg.captureMaxChars);

            // Heuristic classification only — "other" facts are reclassified
            // by the daily auto-classify timer (no LLM calls on the hot path)
            const category: MemoryCategory = ctx.detectCategory(textToStore);
            const extracted = extractStructuredFields(textToStore, category);

            if (ctx.factsDb.hasDuplicate(textToStore)) continue;

            const summaryThreshold = ctx.cfg.autoRecall.summaryThreshold;
            const summary =
              summaryThreshold > 0 && textToStore.length > summaryThreshold
                ? textToStore.slice(0, ctx.cfg.autoRecall.summaryMaxChars).trim() + "…"
                : undefined;

            // Generate vector once (used for classification by embedding similarity and for storage)
            let vector: number[] | undefined;
            try {
              vector = await ctx.embeddings.embed(textToStore);
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: "auto-capture-embedding",
                subsystem: "auto-capture",
              });
              api.logger.warn(`memory-hybrid: auto-capture embedding failed: ${err}`);
            }

            // Classify before auto-capture using embedding similarity, fallback to entity/key
            if (ctx.cfg.store.classifyBeforeWrite) {
              let similarFacts: MemoryEntry[] = vector
                ? await ctx.findSimilarByEmbedding(ctx.vectorDb, ctx.factsDb, vector, 3)
                : [];
              if (similarFacts.length === 0) {
                similarFacts = ctx.factsDb.findSimilarForClassification(
                  textToStore, extracted.entity, extracted.key, 3,
                );
              }
              if (similarFacts.length > 0) {
                try {
                  const classification = await classifyMemoryOperation(
                    textToStore, extracted.entity, extracted.key, similarFacts,
                    ctx.openai, ctx.cfg.store.classifyModel, api.logger,
                  );
                  if (classification.action === "NOOP") continue;
                  if (classification.action === "DELETE" && classification.targetId) {
                    ctx.factsDb.supersede(classification.targetId, null);
                    api.logger.info?.(`memory-hybrid: auto-capture DELETE — retracted ${classification.targetId}`);
                    continue;
                  }
                  if (classification.action === "UPDATE" && classification.targetId) {
                    const oldFact = ctx.factsDb.getById(classification.targetId);
                    if (oldFact) {
                      const finalImportance = Math.max(0.7, oldFact.importance);
                      // vector already computed above for classification

                      const walEntryId = ctx.walWrite("update", {
                        text: textToStore, category, importance: finalImportance,
                        entity: extracted.entity || oldFact.entity, key: extracted.key || oldFact.key,
                        value: extracted.value || oldFact.value, source: "auto-capture",
                        decayClass: oldFact.decayClass, summary, tags: extractTags(textToStore, extracted.entity), vector,
                      }, api.logger);

                      const nowSec = Math.floor(Date.now() / 1000);
                      const newEntry = ctx.factsDb.store({
                        text: textToStore,
                        category,
                        importance: finalImportance,
                        entity: extracted.entity || oldFact.entity,
                        key: extracted.key || oldFact.key,
                        value: extracted.value || oldFact.value,
                        source: "auto-capture",
                        decayClass: oldFact.decayClass,
                        summary,
                        tags: extractTags(textToStore, extracted.entity),
                        validFrom: nowSec,
                        supersedesId: classification.targetId,
                      });
                      ctx.factsDb.supersede(classification.targetId, newEntry.id);
                      try {
                        if (vector && !(await ctx.vectorDb.hasDuplicate(vector))) {
                          await ctx.vectorDb.store({ text: textToStore, vector, importance: finalImportance, category, id: newEntry.id });
                        }
                      } catch (err) {
                        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                          operation: "auto-capture-vector-update",
                          subsystem: "auto-capture",
                        });
                        api.logger.warn(`memory-hybrid: vector capture failed: ${err}`);
                      }

                      ctx.walRemove(walEntryId, api.logger);

                      api.logger.info?.(
                        `memory-hybrid: auto-capture UPDATE — superseded ${classification.targetId} with ${newEntry.id}`,
                      );
                      stored++;
                      continue;
                    }
                  }
                  // ADD: fall through to normal store
                } catch (err) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    operation: "auto-capture-classification",
                    subsystem: "auto-capture",
                  });
                  api.logger.warn(`memory-hybrid: auto-capture classification failed: ${err}`);
                  // fall through to normal store on error
                }
              }
            }

            const walEntryId = ctx.walWrite("store", {
              text: textToStore, category, importance: CLI_STORE_IMPORTANCE,
              entity: extracted.entity, key: extracted.key, value: extracted.value,
              source: "auto-capture", summary, tags: extractTags(textToStore, extracted.entity), vector,
            }, api.logger);

            const storedEntry = ctx.factsDb.store({
              text: textToStore,
              category,
              importance: CLI_STORE_IMPORTANCE,
              entity: extracted.entity,
              key: extracted.key,
              value: extracted.value,
              source: "auto-capture",
              summary,
              tags: extractTags(textToStore, extracted.entity),
            });

            try {
              if (vector && !(await ctx.vectorDb.hasDuplicate(vector))) {
                await ctx.vectorDb.store({ text: textToStore, vector, importance: CLI_STORE_IMPORTANCE, category, id: storedEntry.id });
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: "auto-capture-vector-store",
                subsystem: "auto-capture",
              });
              api.logger.warn(`memory-hybrid: vector capture failed: ${err}`);
            }

            ctx.walRemove(walEntryId, api.logger);

            stored++;
          }

          if (stored > 0) {
            api.logger.info(
              `memory-hybrid: auto-captured ${stored} memories`,
            );
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "auto-capture",
            subsystem: "auto-capture",
          });
          api.logger.warn(`memory-hybrid: capture failed: ${String(err)}`);
        }
      });
    }

    // Credential auto-detect: when patterns found in conversation, persist hint for next turn
    if (ctx.cfg.credentials.enabled && ctx.cfg.credentials.autoDetect) {
      const pendingPath = join(dirname(ctx.resolvedSqlitePath), "credentials-pending.json");

      api.on("agent_end", async (event: unknown) => {
        const ev = event as { messages?: unknown[] };
        if (!ev.messages || ev.messages.length === 0) return;
        try {
          const texts: string[] = [];
          for (const msg of ev.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const content = msgObj.content;
            if (typeof content === "string") texts.push(content);
            else if (Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === "object" && "type" in block && (block as Record<string, unknown>).type === "text" && "text" in block) {
                  const t = (block as Record<string, unknown>).text;
                  if (typeof t === "string") texts.push(t);
                }
              }
            }
          }
          const allText = texts.join("\n");
          const detected = detectCredentialPatterns(allText);
          if (detected.length === 0) return;
          await mkdir(dirname(pendingPath), { recursive: true });
          await writeFile(
            pendingPath,
            JSON.stringify({
              hints: detected.map((d) => d.hint),
              at: Date.now(),
            }),
            "utf-8",
          );
          api.logger.info(`memory-hybrid: credential patterns detected (${detected.map((d) => d.hint).join(", ")}) — will prompt next turn`);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "credential-auto-detect",
            subsystem: "credentials",
          });
          api.logger.warn(`memory-hybrid: credential auto-detect failed: ${err}`);
        }
      });
    }

    // Tool-call credential auto-capture: scan tool call inputs for credential patterns; store in vault or in memory (no vault)
    if (ctx.cfg.credentials.enabled && ctx.cfg.credentials.autoCapture?.toolCalls) {
      const logCaptures = ctx.cfg.credentials.autoCapture.logCaptures !== false;

      api.on("agent_end", async (event: unknown) => {
        const ev = event as { messages?: unknown[] };
        if (!ev.messages || ev.messages.length === 0) return;
        try {
          for (const msg of ev.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            if (msgObj.role !== "assistant") continue;

            const toolCalls = msgObj.tool_calls;
            if (!Array.isArray(toolCalls)) continue;

            for (const tc of toolCalls) {
              if (!tc || typeof tc !== "object") continue;
              const tcObj = tc as Record<string, unknown>;
              const fn = tcObj.function as Record<string, unknown> | undefined;
              if (!fn) continue;
              const args = fn.arguments;
              if (typeof args !== "string" || args.length === 0) continue;

              // Parse JSON args to unescape quotes/spaces for reliable pattern matching
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(args);
              } catch (err) {
                capturePluginError(err as Error, {
                  operation: 'json-parse-tool-args',
                  severity: 'info',
                  subsystem: 'lifecycle'
                });
                // If args aren't valid JSON, scan the raw string as fallback
              }

              // Extract string fields from parsed args and scan them
              const argsToScan = Object.values(parsedArgs)
                .filter((v): v is string => typeof v === "string")
                .join(" ");

              const creds = extractCredentialsFromToolCalls(argsToScan || args);
              for (const cred of creds) {
                if (ctx.credentialsDb) {
                  ctx.credentialsDb.store({
                    service: cred.service,
                    type: cred.type,
                    value: cred.value,
                    url: cred.url,
                    notes: cred.notes,
                  });
                } else {
                  // Memory-only: store as fact (no vault)
                  const text = `Credential for ${cred.service} (${cred.type})${cred.url ? ` — ${cred.url}` : ""}${cred.notes ? `. ${cred.notes}` : ""}.`;
                  const entry = ctx.factsDb.store({
                    text,
                    category: "technical" as MemoryCategory,
                    importance: 0.9,
                    entity: "Credentials",
                    key: cred.service,
                    value: cred.value,
                    source: "conversation",
                    decayClass: "permanent",
                    tags: ["auth", "credential"],
                  });
                  try {
                    const vector = await ctx.embeddings.embed(text);
                    if (!(await ctx.vectorDb.hasDuplicate(vector))) {
                      await ctx.vectorDb.store({
                        text,
                        vector,
                        importance: 0.9,
                        category: "technical",
                        id: entry.id,
                      });
                    }
                  } catch (err) {
                    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                      operation: "tool-call-credential-vector-store",
                      subsystem: "credentials",
                    });
                    api.logger.warn(`memory-hybrid: vector store for credential fact failed: ${err}`);
                  }
                }
                if (logCaptures) {
                  api.logger.info(`memory-hybrid: auto-captured credential for ${cred.service} (${cred.type})`);
                }
              }
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "tool-call-credential-auto-capture",
            subsystem: "credentials",
          });
          const errMsg = err instanceof Error ? err.stack || err.message : String(err);
          api.logger.warn(`memory-hybrid: tool-call credential auto-capture failed: ${errMsg}`);
        }
      });
    }
  };

  return { onAgentStart, onAgentEnd };
}
