/**
 * Lifecycle Hooks
 *
 * Extracted from index.ts - handles lifecycle events (before_agent_start, agent_end)
 * for auto-recall, auto-capture, tiering, credentials, and auth failure detection.
 */

import { existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import { getCronModelConfig, getDefaultCronModel, getLLMModelPreference } from "../config.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "../services/embeddings.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "../types/memory.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import { chatCompleteWithRetry, type PendingLLMWarnings } from "../services/chat.js";
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
import {
  readActiveTaskFile,
  buildActiveTaskInjection,
  buildStaleWarningInjection,
  writeActiveTaskFile,
  writeActiveTaskFileGuarded,
  readActiveTaskFileWithMtime,
  writeActiveTaskFileOptimistic,
  upsertTask,
  completeTask,
  flushCompletedTaskToMemory,
  readPendingSignals,
  deleteSignal,
  type ActiveTaskEntry,
  type PendingTaskSignal,
} from "../services/active-task.js";
import { parseDuration } from "../utils/duration.js";

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
  pendingLLMWarnings: PendingLLMWarnings;
}

// ---------------------------------------------------------------------------
// Signal consumption helper
// ---------------------------------------------------------------------------

/**
 * Read all pending task signals from `memory/task-signals/*.json` and apply
 * their status changes to ACTIVE-TASK.md.
 *
 * Called by the orchestrator after a subagent completes so that status updates
 * emitted by sub-agents during their work are merged into the working memory.
 *
 * @param activeTaskPath  Absolute path to ACTIVE-TASK.md
 * @param workspaceRoot   Workspace root (signals live in workspaceRoot/memory/task-signals/)
 * @param staleMinutes    Minutes before a task is considered stale (for consistent stale detection)
 * @param logger          Plugin logger (optional, for info/warn messages)
 */
async function consumePendingTaskSignals(
  activeTaskPath: string,
  workspaceRoot: string,
  staleMinutes: number,
  flushOnComplete: boolean,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<void> {
  const memoryDir = join(workspaceRoot, "memory");
  let signals: PendingTaskSignal[];
  try {
    signals = await readPendingSignals(memoryDir);
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to read pending task signals: ${err}`);
    return;
  }

  if (signals.length === 0) return;

  const signalTtlMs = Math.max(staleMinutes * 60 * 1000, 24 * 60 * 60 * 1000);
  const nowMs = Date.now();
  const isSignalExpired = (signal: PendingTaskSignal): boolean => {
    const parsed = Date.parse(signal.timestamp);
    // Treat unparseable timestamps as expired to prevent unbounded signal accumulation
    if (Number.isNaN(parsed)) return true;
    return nowMs - parsed > signalTtlMs;
  };

  signals = [...signals].sort((a, b) => {
    const at = Date.parse(a.timestamp);
    const bt = Date.parse(b.timestamp);
    if (Number.isNaN(at) || Number.isNaN(bt)) {
      return a._filePath.localeCompare(b._filePath);
    }
    return at === bt ? a._filePath.localeCompare(b._filePath) : at - bt;
  });

  // Re-read the task file once and apply all signals in a single write
  let taskFile;
  try {
    taskFile = await readActiveTaskFileWithMtime(activeTaskPath, staleMinutes);
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to read ACTIVE-TASK.md for signal consumption: ${err}`);
    return;
  }

  if (!taskFile) {
    const expiredSignals = signals.filter(isSignalExpired);
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) {
        await deleteSignal(signal._filePath).catch(() => {});
      }
      logger?.info?.(
        `memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) while ACTIVE-TASK.md is missing`,
      );
    }
    logger?.info?.("memory-hybrid: ACTIVE-TASK.md missing; deferring pending task signals");
    return;
  }

  const knownMtime = taskFile.mtime;

  const findMatchingTask = (
    activeEntries: ActiveTaskEntry[],
    signal: PendingTaskSignal,
  ): ActiveTaskEntry | null => {
    const byLabel = activeEntries.filter((t) => t.label === signal.taskRef);
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) {
      logger?.warn?.(
        `memory-hybrid: multiple active tasks share label ${signal.taskRef}; leaving signal pending`,
      );
      return null;
    }

    const byDescription = activeEntries.filter((t) => t.description === signal.taskRef);
    if (byDescription.length === 1) {
      // Description fallback — descriptions are not guaranteed unique and may change.
      // Sub-agents should use the task label (not description) in taskRef for reliable matching.
      logger?.warn?.(
        `memory-hybrid: matched signal for "${signal.taskRef}" by description (not label); ` +
        `sub-agents should use the exact task label in taskRef for reliable matching`,
      );
      return byDescription[0];
    }
    if (byDescription.length > 1) {
      logger?.warn?.(
        `memory-hybrid: multiple active tasks match description ${signal.taskRef}; leaving signal pending`,
      );
      return null;
    }

    return null;
  };

  const applySignals = (
    activeEntries: ActiveTaskEntry[],
    completedEntries: ActiveTaskEntry[],
  ): {
    active: ActiveTaskEntry[];
    completed: ActiveTaskEntry[];
    processedSignals: PendingTaskSignal[];
    expiredSignals: PendingTaskSignal[];
    completedToFlush: ActiveTaskEntry[];
  } => {
    let updatedActive = [...activeEntries];
    const updatedCompleted = [...completedEntries];
    const processedSignals: PendingTaskSignal[] = [];
    const expiredSignals: PendingTaskSignal[] = [];
    const completedToFlush: ActiveTaskEntry[] = [];

    for (const signal of signals) {
      try {
        const timestamp = Date.parse(signal.timestamp);
        const updatedTimestamp = Number.isNaN(timestamp)
          ? new Date().toISOString()
          : signal.timestamp;

        const existing = findMatchingTask(updatedActive, signal);
        if (!existing) {
          if (isSignalExpired(signal)) {
            expiredSignals.push(signal);
          } else {
            logger?.warn?.(
              `memory-hybrid: no matching active task for signal ${signal.taskRef}; leaving pending`,
            );
          }
          continue;
        }

        if (signal.signal === "completed") {
          const { updated, completed } = completeTask(updatedActive, existing.label);
          if (completed) {
            const completedEntry = { ...completed, updated: updatedTimestamp };
            updatedActive = updated;
            updatedCompleted.push(completedEntry);
            processedSignals.push(signal);
            completedToFlush.push(completedEntry);
          }
          continue;
        }

        if (signal.signal !== "blocked" && signal.signal !== "escalate" && signal.signal !== "update") {
          if (isSignalExpired(signal)) {
            expiredSignals.push(signal);
          } else {
            logger?.warn?.(
              `memory-hybrid: unhandled task signal "${signal.signal}" for ${signal.taskRef}; leaving pending`,
            );
          }
          continue;
        }

        const newStatus: ActiveTaskEntry["status"] =
          signal.signal === "blocked" ? "Stalled" :
          signal.signal === "escalate" ? "Waiting" :
          existing.status;

        const updatedEntry: ActiveTaskEntry = {
          ...existing,
          status: newStatus,
          next: signal.summary
            ? `[Signal: ${signal.signal}] ${signal.summary}`
            : existing.next,
          updated: updatedTimestamp,
        };
        updatedActive = upsertTask(updatedActive, updatedEntry, true);
        processedSignals.push(signal);
      } catch (err) {
        logger?.warn?.(`memory-hybrid: failed to process signal from ${signal._filePath}: ${err}`);
      }
    }

    return {
      active: updatedActive,
      completed: updatedCompleted,
      processedSignals,
      expiredSignals,
      completedToFlush,
    };
  };

  let latestResult = applySignals(taskFile.active, taskFile.completed);
  let processedSignals = latestResult.processedSignals;
  let expiredSignals = latestResult.expiredSignals;
  let completedToFlush = latestResult.completedToFlush;

  if (processedSignals.length === 0) {
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) {
        await deleteSignal(signal._filePath).catch(() => {});
      }
      logger?.info?.(
        `memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) with no matching task`,
      );
    }
    return;
  }

  let wrote = false;
  try {
    wrote = await writeActiveTaskFileOptimistic(
      activeTaskPath,
      latestResult.active,
      latestResult.completed,
      knownMtime,
      async (fresh) => {
        latestResult = applySignals(fresh.active, fresh.completed);
        processedSignals = latestResult.processedSignals;
        expiredSignals = latestResult.expiredSignals;
        completedToFlush = latestResult.completedToFlush;
        return [latestResult.active, latestResult.completed];
      },
      3,
      staleMinutes,
    );
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to write ACTIVE-TASK.md after signal consumption: ${err}`);
  }

  if (wrote) {
    for (const signal of processedSignals) {
      await deleteSignal(signal._filePath).catch(() => {});
    }
    for (const signal of expiredSignals) {
      await deleteSignal(signal._filePath).catch(() => {});
    }
    if (flushOnComplete && completedToFlush.length > 0) {
      const memoryDir = join(workspaceRoot, "memory");
      for (const completed of completedToFlush) {
        await flushCompletedTaskToMemory(completed, memoryDir).catch(() => {});
      }
    }
    logger?.info?.(
      `memory-hybrid: consumed ${processedSignals.length} pending task signal(s) from sub-agents`,
    );
  } else if (expiredSignals.length > 0) {
    for (const signal of expiredSignals) {
      await deleteSignal(signal._filePath).catch(() => {});
    }
    logger?.info?.(
      `memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) after write abort`,
    );
  }
}

export function createLifecycleHooks(ctx: LifecycleContext) {
  // Mutable refs that need to be updated across hooks
  // Note: currentAgentIdRef is already a mutable ref object from index.ts
  const currentAgentIdRef = ctx.currentAgentIdRef;
  let lastProgressiveIndexIds = ctx.lastProgressiveIndexIds;
  let restartPendingCleared = ctx.restartPendingCleared;

  // Track auth failures per target per session to avoid spam
  const authFailureRecallsThisSession = new Map<string, number>();
  // Track session starts for retrieval directives
  const sessionStartSeen = new Set<string>();

  const resolveSessionKey = (event: unknown, api?: ClawdbotPluginApi): string | null => {
    const ev = event as { session?: Record<string, unknown>; sessionKey?: string };
    const sessionId =
      ev?.session?.id ??
      ev?.session?.sessionId ??
      ev?.session?.key ??
      ev?.session?.label ??
      ev?.sessionKey ??
      api?.context?.sessionId ??
      null;
    return sessionId ? String(sessionId) : null;
  };

  // Resolve active task file path against workspace root (same logic as CLI context)
  const workspaceRoot = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  const resolvedActiveTaskPath = isAbsolute(ctx.cfg.activeTask.filePath)
    ? ctx.cfg.activeTask.filePath
    : join(workspaceRoot, ctx.cfg.activeTask.filePath);

  const onAgentStart = (api: ClawdbotPluginApi) => {
    // Agent detection must run independently of autoRecall
    // to support multi-agent scoping even when autoRecall is disabled
    api.on("before_agent_start", async (event: unknown) => {
      // Increment VectorDB refcount so a concurrent session teardown does not prematurely
      // close the shared singleton while this session is still active (fixes issue #106).
      ctx.vectorDb.open();

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

        api.logger.debug?.(`memory-hybrid: auto-recall start (prompt length ${e.prompt.length})`);

        try {
          // Use configurable candidate pool for progressive disclosure
          const fmt = ctx.cfg.autoRecall.injectionFormat;
          const isProgressive = fmt === "progressive" || fmt === "progressive_hybrid";
          const searchLimit = isProgressive
            ? (ctx.cfg.autoRecall.progressiveMaxCandidates ?? Math.max(ctx.cfg.autoRecall.limit, 15))
            : ctx.cfg.autoRecall.limit;
          const { minScore } = ctx.cfg.autoRecall;
          const limit = searchLimit;
          const tierFilter: "warm" | "all" = ctx.cfg.memoryTiering.enabled ? "warm" : "all";

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

          const VECTOR_STEP_TIMEOUT_MS = 30_000;
          let directiveHydeUsed = false;

          async function runRecallPipeline(
            query: string,
            limit: number,
            opts?: { entity?: string; hydeLabel?: string; errorPrefix?: string; limitHydeOnce?: boolean }
          ): Promise<SearchResult[]> {
            const trimmed = query.trim();
            if (!trimmed) return [];
            const recallOpts = {
              tierFilter,
              scopeFilter,
              reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
            };
            let sqliteResults: SearchResult[] = [];
            if (opts?.entity) {
              sqliteResults = ctx.factsDb.lookup(opts.entity, undefined, undefined, { scopeFilter }).slice(0, limit);
            }
            const ftsResults = ctx.factsDb.search(trimmed, limit, recallOpts);
            sqliteResults = [...sqliteResults, ...ftsResults];

            let lanceResults: SearchResult[] = [];
            const directiveAbort = new AbortController();
            try {
              const vectorStepPromise = (async (): Promise<SearchResult[]> => {
                let textToEmbed = trimmed;
                const allowHyde = ctx.cfg.search?.hydeEnabled && (!opts?.limitHydeOnce || !directiveHydeUsed);
                if (allowHyde) {
                  if (opts?.limitHydeOnce) directiveHydeUsed = true;
                  try {
                    const cronCfg = getCronModelConfig(ctx.cfg);
                    const pref = getLLMModelPreference(cronCfg, "nano");
                    const hydeModel = ctx.cfg.search?.hydeModel ?? pref[0];
                    const fallbackModels = ctx.cfg.search?.hydeModel ? [] : pref.slice(1);
                    const hydeContent = await chatCompleteWithRetry({
                      model: hydeModel,
                      fallbackModels,
                      content: `Write a short factual statement (1-2 sentences) that answers: ${trimmed}\n\nOutput only the statement, no preamble.`,
                      temperature: 0.3,
                      maxTokens: 150,
                      openai: ctx.openai,
                      label: opts?.hydeLabel ?? "HyDE",
                      timeoutMs: 25_000,
                      signal: directiveAbort.signal,
                      pendingWarnings: ctx.pendingLLMWarnings,
                    });
                    const hydeText = hydeContent.trim();
                    if (hydeText.length > 10) textToEmbed = hydeText;
                  } catch (err) {
                    if (!directiveAbort.signal.aborted) {
                      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                        operation: `${opts?.errorPrefix ?? ""}hyde-generation`,
                        subsystem: "auto-recall",
                      });
                      api.logger.warn(`memory-hybrid: ${opts?.errorPrefix ?? ""}HyDE generation failed, using raw query: ${err}`);
                    }
                  }
                }
                const vector = await ctx.embeddings.embed(textToEmbed);
                let results = await ctx.vectorDb.search(vector, limit * 2, minScore);
                results = filterByScope(results, (id, opts) => ctx.factsDb.getById(id, opts), scopeFilter);
                results = results.map((r) => {
                  const fullEntry = ctx.factsDb.getById(r.entry.id);
                  if (fullEntry) {
                    return { ...r, entry: fullEntry, score: computeDynamicSalience(r.score, fullEntry) };
                  }
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
              if (isTimeout) {
                api.logger.warn?.(`memory-hybrid: ${err.message}, using FTS-only recall`);
              } else {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: `${opts?.errorPrefix ?? ""}vector-recall`,
                  subsystem: "auto-recall",
                  backend: "lancedb",
                });
                api.logger.warn(`memory-hybrid: ${opts?.errorPrefix ?? ""}vector recall failed: ${err}`);
              }
            }

            let results = mergeResults(sqliteResults, lanceResults, limit, ctx.factsDb);
            if (ctx.cfg.memoryTiering.enabled && results.length > 0) {
              results = results.filter((r) => {
                const full = ctx.factsDb.getById(r.entry.id);
                return full && full.tier !== "cold";
              }).slice(0, limit);
            }
            return results;
          }

          let candidates = await runRecallPipeline(e.prompt, limit, { hydeLabel: "HyDE", errorPrefix: "auto-recall-" });

          const promptLower = e.prompt.toLowerCase();
          const { entityLookup } = ctx.cfg.autoRecall;
          if (entityLookup.enabled && entityLookup.entities.length > 0) {
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
          const directivesCfg = ctx.cfg.autoRecall.retrievalDirectives;
          const directiveLimit = directivesCfg.limit;
          const maxDirectiveCalls = directivesCfg.maxPerPrompt;
          const maxDirectiveCandidates = limit + directiveLimit * maxDirectiveCalls;
          const directiveSeenIds = new Set(candidates.map((c) => c.entry.id));
          const directivePriorityIds = new Set<string>();
          const directiveMatches: string[] = [];
          let directiveCalls = 0;

          function addDirectiveResults(results: SearchResult[], label: string): void {
            if (results.length === 0) return;
            for (const r of results) {
              if (directiveSeenIds.has(r.entry.id)) continue;
              directiveSeenIds.add(r.entry.id);
              directivePriorityIds.add(r.entry.id);
              candidates.push(r);
            }
            directiveMatches.push(label);
          }

          function canRunDirective(): boolean {
            if (directiveCalls >= maxDirectiveCalls) return false;
            if (candidates.length >= maxDirectiveCandidates) return false;
            return true;
          }

          if (directivesCfg.enabled) {
            try {
              if (directivesCfg.entityMentioned && entityLookup.enabled && entityLookup.entities.length > 0) {
                for (const entity of entityLookup.entities) {
                  if (!promptLower.includes(entity.toLowerCase())) continue;
                  if (!canRunDirective()) break;
                  const results = await runRecallPipeline(entity, directiveLimit, { entity, hydeLabel: "HyDE", errorPrefix: "directive-", limitHydeOnce: true });
                  directiveCalls += 1;
                  addDirectiveResults(results, `entity:${entity}`);
                }
              }

              if (directivesCfg.keywords.length > 0) {
                for (const keyword of directivesCfg.keywords) {
                  if (!promptLower.includes(keyword.toLowerCase())) continue;
                  if (!canRunDirective()) break;
                  const results = await runRecallPipeline(keyword, directiveLimit, { hydeLabel: "HyDE", errorPrefix: "directive-", limitHydeOnce: true });
                  directiveCalls += 1;
                  addDirectiveResults(results, `keyword:${keyword}`);
                }
              }

              const taskTypeEntries = Object.entries(directivesCfg.taskTypes);
              if (taskTypeEntries.length > 0) {
                for (const [taskType, triggers] of taskTypeEntries) {
                  const hit = triggers.some((t) => promptLower.includes(t.toLowerCase()));
                  if (!hit) continue;
                  if (!canRunDirective()) break;
                  const results = await runRecallPipeline(taskType, directiveLimit, { hydeLabel: "HyDE", errorPrefix: "directive-", limitHydeOnce: true });
                  directiveCalls += 1;
                  addDirectiveResults(results, `taskType:${taskType}`);
                }
              }

              if (directivesCfg.sessionStart) {
                const sessionKey = resolveSessionKey(e, api) ?? currentAgentIdRef.value ?? "default";
                if (!sessionStartSeen.has(sessionKey)) {
                  if (canRunDirective()) {
                    const results = await runRecallPipeline("session start", directiveLimit, { hydeLabel: "HyDE", errorPrefix: "directive-", limitHydeOnce: true });
                    directiveCalls += 1;
                    addDirectiveResults(results, "sessionStart");
                    sessionStartSeen.add(sessionKey);
                  }
                }
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: "directive-recall",
                subsystem: "auto-recall",
              });
              api.logger.warn(`memory-hybrid: directive recall failed, continuing with main recall results: ${err}`);
            }
          }

          if (directiveMatches.length > 0) {
            // Apply directive priority boost before sorting to ensure directive results stay competitive
            candidates = candidates.map((r) => {
              if (directivePriorityIds.has(r.entry.id)) {
                return { ...r, score: r.score * 1.25 };
              }
              return r;
            });
            // Keep ordering deterministic and ensure directive results are meaningfully represented.
            candidates.sort((a, b) => {
              const s = b.score - a.score;
              if (s !== 0) return s;
              const da = a.entry.sourceDate ?? a.entry.createdAt;
              const db = b.entry.sourceDate ?? b.entry.createdAt;
              return db - da;
            });
            candidates = candidates.slice(0, limit);
            api.logger.info?.(`memory-hybrid: retrieval directives matched (${directiveMatches.join(", ")})`);
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
              `memory-hybrid: injecting ${lines.length} memories (~${usedTokens} tokens)`,
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

    // Active task working memory injection — if ACTIVE-TASK.md exists with non-Done tasks,
    // inject a compact summary into the system prompt so the agent knows what was in flight.
    // When staleWarning.enabled, also surface stale-task warnings and subagent hints.
    if (ctx.cfg.activeTask.enabled) {
      api.on("before_agent_start", async () => {
        try {
          const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
          const taskFile = await readActiveTaskFile(
            resolvedActiveTaskPath,
            staleMinutes,
          );
          if (!taskFile || taskFile.active.length === 0) return undefined;

          const injection = buildActiveTaskInjection(
            taskFile.active,
            ctx.cfg.activeTask.injectionBudget,
          );

          // Build stale warning block (empty string when nothing to report)
          // Apply remaining budget after accounting for active task injection
          let staleWarningBlock = "";
          if (ctx.cfg.activeTask.staleWarning.enabled) {
            const injectionChars = injection.length;
            const budgetChars = ctx.cfg.activeTask.injectionBudget * 4;
            const remainingChars = Math.max(0, budgetChars - injectionChars);
            staleWarningBlock = buildStaleWarningInjection(
              taskFile.active,
              staleMinutes,
              remainingChars,
            );
          }

          if (!injection && !staleWarningBlock) return undefined;

          const context = [
            injection,
            staleWarningBlock,
          ]
            .filter(Boolean)
            .join("\n\n");

          const staleCount = taskFile.active.filter((t) => t.stale).length;
          api.logger.info?.(
            `memory-hybrid: injecting ${taskFile.active.length} active task(s) from ACTIVE-TASK.md` +
            (staleCount > 0 ? ` (${staleCount} stale)` : ""),
          );
          return { prependContext: context + "\n\n" };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "active-task-injection",
            subsystem: "active-task",
          });
          api.logger.warn(`memory-hybrid: active task injection failed: ${err}`);
        }
      });
    }

    // Auto-checkpoint: write ACTIVE-TASK.md on subagent spawn/complete events
    if (ctx.cfg.activeTask.enabled && ctx.cfg.activeTask.autoCheckpoint) {
      // Subagent spawned → auto-create/update task entry
      api.on("subagent_start", async (event: unknown) => {
        try {
          const ev = event as {
            sessionKey?: string;
            label?: string;
            task?: string;
            agentId?: string;
          };
          const label = ev.label ?? ev.sessionKey ?? `subagent-${Date.now()}`;
          const description = ev.task ?? `Subagent task (session: ${ev.sessionKey ?? "unknown"})`;
          const taskFile = await readActiveTaskFile(
            resolvedActiveTaskPath,
            parseDuration(ctx.cfg.activeTask.staleThreshold),
          );
          const now = new Date().toISOString();
          const existingActive = taskFile?.active ?? [];
          const existingCompleted = taskFile?.completed ?? [];
          const existing = existingActive.find((t) => t.label === label);
          const entry: ActiveTaskEntry = {
            label,
            description,
            status: "In progress",
            subagent: ev.sessionKey,
            started: existing?.started ?? now,
            updated: now,
          };
          const updated = upsertTask(existingActive, entry);
          const writeResult = await writeActiveTaskFileGuarded(resolvedActiveTaskPath, updated, existingCompleted, api.context?.sessionKey);
          if (writeResult.skipped) {
            api.logger.debug?.(`memory-hybrid: skipped ACTIVE-TASK.md write in subagent_start: ${writeResult.reason}`);
          } else {
            api.logger.info?.(
              `memory-hybrid: auto-checkpoint — created active task [${label}] for subagent spawn`,
            );
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "active-task-subagent-start",
            subsystem: "active-task",
          });
          api.logger.debug?.(`memory-hybrid: active task auto-checkpoint on subagent_start failed: ${err}`);
        }
      });

      // Subagent completed → auto-update task status
      api.on("subagent_end", async (event: unknown) => {
        try {
          const ev = event as {
            sessionKey?: string;
            label?: string;
            success?: boolean;
            error?: string;
          };
          const label = ev.label ?? ev.sessionKey;
          const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
          if (!label) {
            // Consume pending signals even when label is missing
            await consumePendingTaskSignals(
              resolvedActiveTaskPath,
              workspaceRoot,
              staleMinutes,
              ctx.cfg.activeTask.flushOnComplete,
              api.logger,
            );
            return;
          }

          const taskFile = await readActiveTaskFile(
            resolvedActiveTaskPath,
            staleMinutes,
          );
          if (!taskFile) {
            // Consume pending signals even when task file doesn't exist
            await consumePendingTaskSignals(
              resolvedActiveTaskPath,
              workspaceRoot,
              staleMinutes,
              ctx.cfg.activeTask.flushOnComplete,
              api.logger,
            );
            return;
          }

          const existingTask = taskFile.active.find((t) => t.label === label);
          if (!existingTask) {
            // Task not tracked — skip checkpoint but still consume signals
            await consumePendingTaskSignals(
              resolvedActiveTaskPath,
              workspaceRoot,
              staleMinutes,
              ctx.cfg.activeTask.flushOnComplete,
              api.logger,
            );
            return;
          }

          const now = new Date().toISOString();
          const newStatus = ev.success === false ? "Failed" : "Done";

          if (newStatus === "Done") {
            const { updated, completed } = completeTask(taskFile.active, label);
            if (completed) {
              const writeResult = await writeActiveTaskFileGuarded(
                resolvedActiveTaskPath,
                updated,
                [...taskFile.completed, completed],
                api.context?.sessionKey,
              );
              if (writeResult.skipped) {
                api.logger.debug?.(`memory-hybrid: skipped ACTIVE-TASK.md write in subagent_end (Done): ${writeResult.reason}`);
              } else {
                if (ctx.cfg.activeTask.flushOnComplete) {
                  const memoryDir = join(workspaceRoot, "memory");
                  await flushCompletedTaskToMemory(completed, memoryDir).catch(() => {});
                }
                api.logger.info?.(
                  `memory-hybrid: auto-checkpoint — updated task [${label}] to ${newStatus} on subagent_end`,
                );
              }
            }
          } else {
            // Failed — update status
            const updatedEntry: ActiveTaskEntry = {
              ...existingTask,
              status: "Failed",
              updated: now,
              next: ev.error ? `Fix: ${ev.error.slice(0, 100)}` : existingTask.next,
            };
            const updated = upsertTask(taskFile.active, updatedEntry);
            const writeResult = await writeActiveTaskFileGuarded(resolvedActiveTaskPath, updated, taskFile.completed, api.context?.sessionKey);
            if (writeResult.skipped) {
              api.logger.debug?.(`memory-hybrid: skipped ACTIVE-TASK.md write in subagent_end (Failed): ${writeResult.reason}`);
            } else {
              api.logger.info?.(
                `memory-hybrid: auto-checkpoint — updated task [${label}] to ${newStatus} on subagent_end`,
              );
            }
          }

          // Consume any pending task signals emitted by sub-agents
          await consumePendingTaskSignals(
            resolvedActiveTaskPath,
            workspaceRoot,
            staleMinutes,
            ctx.cfg.activeTask.flushOnComplete,
            api.logger,
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "active-task-subagent-end",
            subsystem: "active-task",
          });
          api.logger.debug?.(`memory-hybrid: active task auto-checkpoint on subagent_end failed: ${err}`);
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
          // ENOENT: file missing (race after access() or optional file) — do not report to Sentry
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "credential-hint-read",
              subsystem: "credentials",
            });
          }
          await unlink(pendingPath).catch(() => {});
        }
      });
    }
  };

  const onAgentEnd = (api: ClawdbotPluginApi) => {
    // Clear session-start dedup state on session end to avoid unbounded growth over long-lived gateways.
    if (ctx.cfg.autoRecall.enabled) {
      api.on("agent_end", async (event: unknown) => {
        const sessionKey = resolveSessionKey(event, api) ?? currentAgentIdRef.value ?? "default";
        sessionStartSeen.delete(sessionKey);
      });
    }

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
                    ctx.openai, ctx.cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "nano"), api.logger,
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
                  const stored = ctx.credentialsDb.storeIfNew({
                    service: cred.service,
                    type: cred.type,
                    value: cred.value,
                    url: cred.url,
                    notes: cred.notes,
                  });
                  if (stored && logCaptures) {
                    api.logger.info(`memory-hybrid: auto-captured credential for ${cred.service} (${cred.type})`);
                  }
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
                  if (logCaptures) {
                    api.logger.info(`memory-hybrid: auto-captured credential for ${cred.service} (${cred.type})`);
                  }
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

    // Decrement VectorDB refcount on session end. Uses removeSession() instead of close() so the
    // shared singleton stays open while other concurrent sessions are still active (fixes issue #106).
    // Registered last so all agent_end handlers that use vectorDb (auto-capture, credential
    // auto-detect, tool-call credential) run first; otherwise the last session would close the DB
    // before they run, causing an unnecessary close-reconnect cycle and DB left open with refcount zero.
    // OpenClaw's event emitter awaits each handler in registration order, so being registered last
    // guarantees this fires only after the async handlers above have fully resolved.
    api.on("agent_end", async () => {
      ctx.vectorDb.removeSession();
    });
  };

  return { onAgentStart, onAgentEnd };
}
