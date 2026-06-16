/**
 * Lifecycle Hooks Registration Wiring
 *
 * Registers lifecycle event hooks (before_agent_start, agent_end) with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import { resolveOpenclawJsonPathForWorkspace } from "../cli/cmd-install.js";
import { getMemoryCategories } from "../config.js";
import { withHookResolutionApi } from "../lifecycle/hook-resolution-api.js";
import { type LifecycleContext, createLifecycleHooks } from "../lifecycle/hooks.js";
import { resolveRecallScopeFilter } from "../lifecycle/stage-recall/degraded-recall.js";
import { resolveSessionKeyFromHookEvent } from "../lifecycle/session-state.js";
import { capturePluginError } from "../services/error-reporter.js";
import { trimBlockToBudget } from "../services/context-block-trim.js";
import { applyPrependBudget, getRemainingPrependTokens } from "../services/prepend-budget.js";
import { shouldPinFactForInjection } from "../services/pinned-recall-policy.js";
import { buildPostCompactionRecallSnippet } from "../services/post-compaction-recall.js";
import {
  assembleRecallPrependContext,
  DEFAULT_EDICT_BUDGET_FRACTION,
  edictMaxTokensForBudget,
  formatSanitizedMemoryPreview,
  wrapUntrustedMemoryContent,
} from "../services/recalled-context-assembler.js";
import { runPreConsolidationFlush } from "../services/pre-consolidation-flush.js";
import { sanitizePromptInjection } from "../services/skill-prompt-injection.js";
import { estimateTokens } from "../utils/text.js";
import { recordStartupMemoryCheckpoint } from "../services/startup-memory-attribution.js";
import { initHmVerboseFromEnv } from "../services/recall-verbose-log.js";
import { WorkflowTracker } from "../services/workflow-tracker.js";
import {
  buildUnsupportedPerAgentCompactionWarning,
  buildCompactionWatchdogAlert,
  buildCompactionModelWatchdogWarning,
  describeCompactionFallbackScope,
  resolveCompactionHookIdentity,
  resolveCompactionHookModelMetadata,
  resolveCompactionModelSelection,
  type CompactionWatchdogContext,
} from "../utils/compaction-model-watchdog.js";
import {
  type MessageLike,
  sanitizeMessagesForClaude,
  sanitizeMessagesForOpenAIResponses,
} from "../utils/sanitize-messages.js";

/** Lifecycle hooks receive the stable plugin API (Phase 3). */
type HooksContext = MemoryPluginAPI;

/** Issue #463: Returned handle for lifecycle hook cleanup. */
export interface LifecycleHooksHandle {
  /** Dispose all timers and clear per-session state (call on plugin stop). */
  dispose: () => void;
}

function emitCompactionModelWatchdogAlert(
  api: ClawdbotPluginApi,
  context: CompactionWatchdogContext,
  opts?: { event?: unknown; hookCtx?: unknown },
): void {
  const configPath = resolveOpenclawJsonPathForWorkspace();
  let selectionUnknownReason: string | null = null;
  const identity = resolveCompactionHookIdentity(opts?.event, opts?.hookCtx, api.context);
  const scopeNote = describeCompactionFallbackScope(identity);
  let selection = resolveCompactionModelSelection(undefined, { fallbackPolicy: "inherit-defaults-primary" });
  if (!existsSync(configPath)) {
    selectionUnknownReason = `config file not found at ${configPath}`;
  } else {
    try {
      const root = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      selection = resolveCompactionModelSelection(root, { fallbackPolicy: "inherit-defaults-primary" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      selectionUnknownReason = `failed reading ${configPath}: ${message}`;
      api.logger.debug?.(`memory-hybrid: ${context} watchdog — failed reading ${configPath}: ${err}; ${scopeNote}`);
    }
  }
  if (selectionUnknownReason) {
    api.logger.warn?.(
      `memory-hybrid: ${context} watchdog — compaction routing unknown (${selectionUnknownReason}); ${scopeNote}`,
    );
    return;
  }
  if (selection.routingUnknownFromConfig) {
    api.logger.warn?.(
      `memory-hybrid: ${context} watchdog — compaction routing unknown (neither agents.defaults.compaction.model nor agents.defaults.model.primary set; session chat model may apply); ${scopeNote}`,
    );
    return;
  }
  const unsupportedWarning = buildUnsupportedPerAgentCompactionWarning(selection, { context });
  if (unsupportedWarning) {
    api.logger.warn?.(`memory-hybrid: ${unsupportedWarning} ${scopeNote}`);
  }
  const warning = buildCompactionModelWatchdogWarning(selection, { context });
  if (warning) {
    api.logger.warn?.(`memory-hybrid: ${warning} ${scopeNote}`);
  } else {
    api.logger.debug?.(
      `memory-hybrid: ${context} watchdog — compaction model safe (provider=${selection.provider}, model=${selection.model}, reason=${selection.reason}); ${scopeNote}`,
    );
  }
}

/**
 * Register all lifecycle hooks with the OpenClaw API.
 * Creates and attaches before_agent_start and agent_end event handlers.
 * Returns a handle for cleanup (dispose).
 */
export function registerLifecycleHooks(ctx: HooksContext, api: ClawdbotPluginApi): LifecycleHooksHandle {
  initHmVerboseFromEnv();
  let firstAgentEndCompactionCaptured = false;
  const registrationGeneration = ctx.registrationGeneration ?? -1;
  const currentRegistrationGenerationRef = ctx.currentRegistrationGenerationRef;
  if (!currentRegistrationGenerationRef) {
    api.logger.error?.(
      "memory-hybrid: lifecycle generation ref missing; stale hooks will NOT be blocked on re-registration. This is a critical registration bug.",
    );
    throw new Error("currentRegistrationGenerationRef is required for safe hook registration but was not provided");
  }
  const effectiveRegistrationGenerationRef = currentRegistrationGenerationRef;
  const hookUnsubscribers: Array<() => void> = [];
  const trackUnsubscribe = (unsubscribe: unknown): void => {
    if (typeof unsubscribe === "function") {
      hookUnsubscribers.push(unsubscribe as () => void);
    }
  };
  const registerGuardedHook = (event: unknown, handler: unknown): void => {
    if (typeof handler !== "function") return;
    const guardedHandler = (...args: unknown[]): unknown => {
      if (effectiveRegistrationGenerationRef.value !== registrationGeneration) return undefined;
      return (handler as (...inner: unknown[]) => unknown)(...args);
    };
    const unsubscribe = (api.on as (eventName: unknown, callback: unknown) => unknown)(event, guardedHandler);
    trackUnsubscribe(unsubscribe);
  };
  const disposeRegisteredHooks = (): void => {
    const pendingUnsubscribers = [...hookUnsubscribers];
    hookUnsubscribers.length = 0;
    for (const unsubscribe of pendingUnsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "registration",
          operation: "register-hooks:unsubscribe",
          severity: "warning",
        });
      }
    }
  };
  const guardedApi = {
    ...api,
    on: ((event: unknown, handler: unknown) => registerGuardedHook(event, handler)) as ClawdbotPluginApi["on"],
  } as ClawdbotPluginApi;
  let lifecycleContext: LifecycleContext;
  try {
    lifecycleContext = {
      factsDb: ctx.factsDb,
      edictStore: ctx.edictStore,
      vectorDb: ctx.vectorDb,
      embeddings: ctx.embeddings,
      embeddingRegistry: ctx.embeddingRegistry ?? null,
      openai: ctx.openai,
      cfg: ctx.cfg,
      credentialsDb: ctx.credentialsDb,
      aliasDb: ctx.aliasDb,
      wal: ctx.wal,
      eventLog: ctx.eventLog,
      narrativesDb: ctx.narrativesDb,
      workflowStore: ctx.workflowStore,
      // Issue #742: instantiate WorkflowTracker and wire into lifecycle so tool sequences
      // are recorded to workflow-traces.db (was implemented but never connected).
      workflowTracker:
        ctx.workflowStore && ctx.cfg.workflowTracking?.enabled
          ? new WorkflowTracker(ctx.workflowStore, ctx.cfg.workflowTracking)
          : undefined,
      currentAgentIdRef: ctx.currentAgentIdRef,
      lastProgressiveIndexIds: ctx.lastProgressiveIndexIds,
      progressiveIndexBySession: ctx.progressiveIndexBySession,
      lastAutoRecallPromptBySession: ctx.lastAutoRecallPromptBySession,
      injectedFactIdsBySession: ctx.injectedFactIdsBySession,
      restartPendingClearedRef: ctx.restartPendingClearedRef,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      walWrite: (operation, data, logger, supersedeTargetId) =>
        ctx.walWrite(ctx.wal, operation, data, logger, supersedeTargetId),
      walRemove: (id, logger) => ctx.walRemove(ctx.wal, id, logger),
      findSimilarByEmbedding: ctx.findSimilarByEmbedding,
      shouldCapture: ctx.shouldCapture,
      detectCategory: ctx.detectCategory,
      pendingLLMWarnings: ctx.pendingLLMWarnings,
      auditStore: ctx.auditStore ?? null,
      issueStore: ctx.issueStore,
      recallInFlightRef: ctx.recallInFlightRef,
      lastAutoRecallPromptRef: ctx.lastAutoRecallPromptRef,
      prependBudgetRef: ctx.prependBudgetRef,
      changeFeed: ctx.changeFeed ?? null,
      proposalsDb: ctx.proposalsDb ?? null,
      crystallizationStore: ctx.crystallizationStore ?? null,
      toolProposalStore: ctx.toolProposalStore ?? null,
      registrationGeneration,
      currentRegistrationGenerationRef,
      resolveAllVaults: ctx.resolveAllVaults,
    };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-hooks:context",
    });
    throw err;
  }

  let hooks;
  try {
    hooks = createLifecycleHooks(lifecycleContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-hooks:create",
    });
    throw err;
  }
  if (ctx.sessionStateRef) {
    ctx.sessionStateRef.value = hooks.sessionState;
  }
  try {
    hooks.onAgentStart(guardedApi);
    hooks.onAgentEnd(guardedApi);
    hooks.onFrustrationDetect?.(guardedApi);
    hooks.onChangeNotify?.(guardedApi);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-hooks:attach",
    });
    disposeRegisteredHooks();
    hooks.dispose();
    throw err;
  }

  // Inject pending LLM config warnings into the agent's context once per occurrence.
  // Fires when all models in a tier fail due to missing provider API keys, so the AI
  // can relay the issue to the user in its response.
  guardedApi.on("before_prompt_build", (): undefined | { prependContext: string } => {
    if (!ctx.pendingLLMWarnings) return;
    const warnings = ctx.pendingLLMWarnings.drain();
    if (warnings.length === 0) return;

    // Wrap warnings in a stable, parseable block to prevent prompt pollution
    const wrappedWarnings = [
      "<llm-config-warning>",
      ...warnings.map((w) => sanitizePromptInjection(String(w))),
      "Note: These configuration warnings will not repeat in this session.",
      "</llm-config-warning>",
    ].join("\n");

    const prepend = applyPrependBudget(lifecycleContext.prependBudgetRef, wrappedWarnings);
    if (!prepend) return;
    return { prependContext: prepend };
  });

  // Temporary fix: ensure every tool_use has a tool_result immediately after (Claude API requirement).
  // Strip OpenAI Responses `reasoning` blocks (rs_*) so replay does not 400 (openclaw-maeve#23).
  // Mutates event.historyMessages in place so OpenClaw core uses the sanitized array.
  guardedApi.on("llm_input", (ev: unknown) => {
    const event = ev as { historyMessages?: unknown[] };
    if (!event?.historyMessages || !Array.isArray(event.historyMessages)) return;
    let sanitized = sanitizeMessagesForClaude(event.historyMessages as MessageLike[]);
    sanitized = sanitizeMessagesForOpenAIResponses(sanitized);
    if (sanitized !== event.historyMessages) {
      event.historyMessages.length = 0;
      for (const m of sanitized) event.historyMessages.push(m);
    }
  });

  // Issue #274 — Static memory instructions via prependSystemContext / appendSystemContext
  //
  // SDK investigation (checked types/openclaw-plugin-sdk.d.ts and grep across the plugin):
  //   - The current OpenClaw plugin SDK only exposes `prependContext` in the before_prompt_build
  //     hook return type. Neither `prependSystemContext` nor `appendSystemContext` exist in the
  //     SDK's ClawdbotPluginApi.on() handler signature.
  //
  //   - TODO(#274): When the OpenClaw SDK adds `prependSystemContext` or `appendSystemContext`
  //     to the before_prompt_build return type, switch this hook to return:
  //       { appendSystemContext: staticMemoryInstructions }
  //     This would enable Anthropic prompt-cache to cache the stable system suffix, saving
  //     ~500-1000 tokens per turn. Until then, `prependContext` is the correct approach —
  //     it is supported by all OpenClaw versions and produces the correct runtime behaviour.
  //
  // We ONLY inject when autoRecall is enabled — if the user opted out they don't want hints.
  // Silent mode suppresses capability hints (VerbosityLevel docs) regardless of explicit capabilityHints setting.
  const capabilityHintsMode = ctx.cfg.autoRecall.capabilityHints ?? "off";
  if (ctx.cfg.autoRecall.enabled && capabilityHintsMode !== "off" && ctx.cfg.verbosity !== "silent") {
    let staticMemoryInstructions: string | null = null;

    // Build once and cache — these never change within a gateway session.
    const buildStaticInstructions = (): string => {
      const cats = getMemoryCategories();
      const catList =
        cats.length > 0 ? cats.join(", ") : "preference, fact, decision, entity, pattern, rule, other, technical";
      return [
        "<!-- memory-hybrid: capability hints -->",
        "You have access to long-term memory tools for this session.",
        `Available categories: ${catList}.`,
        "Use memory_store to save important facts, preferences, and decisions.",
        'Use memory_recall("query") or memory_recall(id: N) to retrieve specific memories.',
        "Use memory_forget(memoryId) to remove stale or incorrect memories.",
        "Memories are scoped (global / user / agent / session) — prefer global unless scoped context is needed.",
        "<!-- /memory-hybrid: capability hints -->",
      ].join("\n");
    };

    // Current SDKs only support `prependContext` for injecting additional context into
    // the prompt build. When a reliable capability signal for `appendSystemContext`
    // becomes available in the plugin SDK, this hook can be extended to prefer that
    // field without risking duplicate instructions.
    guardedApi.on("before_prompt_build", (event: unknown, hookCtx: unknown): undefined | { prependContext: string } => {
      if (!staticMemoryInstructions) {
        staticMemoryInstructions = buildStaticInstructions();
      }
      if (capabilityHintsMode === "session") {
        const rApi = withHookResolutionApi(api, hookCtx);
        const sessionKey =
          resolveSessionKeyFromHookEvent(event, rApi) ?? lifecycleContext.currentAgentIdRef.value ?? "default";
        if (hooks.sessionState.capabilityHintsSessionsSeen.has(sessionKey)) return;
        hooks.sessionState.capabilityHintsSessionsSeen.add(sessionKey);
        hooks.sessionState.touchSession(sessionKey);
        hooks.sessionState.pruneSessionMaps(ctx.injectedFactIdsBySession);
      }
      const remaining = getRemainingPrependTokens(lifecycleContext.prependBudgetRef);
      if (remaining !== undefined && remaining < 120) return;
      const prepend = applyPrependBudget(lifecycleContext.prependBudgetRef, staticMemoryInstructions);
      if (!prepend) return;
      return { prependContext: prepend };
    });
  }

  // Issue #275 — Compaction Lifecycle Hooks
  //
  // Hook into before_compaction / after_compaction to:
  //   before: flush WAL state, log pre-compaction snapshot
  //   after:  verify persistence, log compaction stats
  //
  // Feature detection: if the hook name is not recognised by this OpenClaw version
  // the api.on() call will silently no-op (unknown hooks are ignored by the registry).
  try {
    guardedApi.on("before_compaction", async (event: unknown, hookCtx: unknown) => {
      const ev = event as {
        messageCount?: number;
        tokenCount?: number;
        compactingCount?: number;
        sessionFile?: string;
      };

      const hookModel = resolveCompactionHookModelMetadata(event, hookCtx);
      if (hookModel) {
        const alert = buildCompactionWatchdogAlert({
          stage: "before_compaction",
          model: hookModel.model,
          provider: hookModel.provider,
          source: hookModel.source,
        });
        if (alert) api.logger.warn?.(alert);
      } else {
        api.logger.debug?.(
          "memory-hybrid: before_compaction watchdog — compaction provider/model metadata not exposed",
        );
        emitCompactionModelWatchdogAlert(api, "before_compaction", { event, hookCtx });
      }

      const flush = await runPreConsolidationFlush(
        { wal: ctx.wal, factsDb: ctx.factsDb, vectorDb: ctx.vectorDb, embeddings: ctx.embeddings },
        api.logger,
        "before_compaction",
      );
      if (flush.failed) {
        api.logger.error?.(
          "memory-hybrid: before_compaction — WAL pre-flush failed; compaction may proceed on stale SQLite state",
        );
      }

      // Log pre-compaction snapshot for diagnostics
      const msgCount = ev.messageCount ?? 0;
      const tokenCount = ev.tokenCount ?? 0;
      api.logger.info?.(
        `memory-hybrid: before_compaction — messages=${msgCount} tokens≈${tokenCount} compacting=${ev.compactingCount ?? "?"}`,
      );
      if (!firstAgentEndCompactionCaptured) {
        firstAgentEndCompactionCaptured = true;
        recordStartupMemoryCheckpoint({
          logger: api.logger,
          subsystem: "compaction",
          operation: "first-agent-end-compaction",
          phase: "startup.first-agent-end-compaction",
          onceKey: "startup.first-agent-end-compaction",
          tags: {
            messageCount: msgCount,
            tokenCount,
            compactingCount: ev.compactingCount ?? "unknown",
          },
        });
      }

      let injectedContext = "";

      try {
        const fs = await import("node:fs");
        if (typeof api.resolvePath === "function") {
          const agentsMdPath = api.resolvePath("AGENTS.md");
          if (fs.existsSync(agentsMdPath)) {
            const content = sanitizePromptInjection(fs.readFileSync(agentsMdPath, "utf-8"));
            const agentsBlock = `\n<!-- Workspace Agent Rules (AGENTS.md) -->\n${content}\n`;
            injectedContext += trimBlockToBudget(agentsBlock, 1500).text;
          }
        }
      } catch (err) {
        api.logger.debug?.(`memory-hybrid: failed to read AGENTS.md for pre-compaction: ${err}`);
      }

      try {
        const scopeFilter = {
          sessionId: api.context?.sessionId,
          agentId: api.context?.agentId,
          userId: api.context?.userId,
        };
        const hotFacts = ctx.factsDb.getHotFacts(4000, scopeFilter);
        const pinnedRecallThreshold = ctx.cfg.autoRecall?.progressivePinnedRecallCount ?? 3;

        const pinnedFacts = hotFacts.filter((x) => shouldPinFactForInjection(x.entry, pinnedRecallThreshold));

        if (pinnedFacts.length > 0) {
          const lines = pinnedFacts
            .map((f) => {
              const raw = sanitizePromptInjection(f.entry.summary || f.entry.text);
              return raw ? `- ${raw}` : "";
            })
            .filter(Boolean);
          if (lines.length > 0) {
            const wrappedPinned = wrapUntrustedMemoryContent(lines.join("\n"));
            const pinnedBlock = `\n<!-- Pinned Session Constraints / Memories -->\n${wrappedPinned}\n`;
            injectedContext += trimBlockToBudget(pinnedBlock, 800).text;
          }
        }
      } catch (err) {
        api.logger.debug?.(`memory-hybrid: failed to fetch pinned facts for pre-compaction: ${err}`);
      }

      if (injectedContext.trim().length > 0) {
        return {
          prependContext: `\n=== CRITICAL CONSTRAINTS (DO NOT SUMMARISE AWAY) ===\nThe following rules and pinned memories must be preserved and remain active in your ongoing context:\n${injectedContext}====================================================\n`,
        };
      }
      return undefined;
    });
  } catch (err) {
    // Older runtimes may throw on unknown hook names
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "lifecycle",
      operation: "register-before_compaction",
    });
    api.logger.debug?.(`memory-hybrid: before_compaction hook not available (${err})`);
  }

  // Issue #966: Do not register `before_consolidation` — it is not in OpenClaw's PLUGIN_HOOK_NAMES (ignored + noisy).
  // WAL flush before compaction-style work is handled solely by `before_compaction` above (runPreConsolidationFlush).

  try {
    guardedApi.on(
      "after_compaction",
      async (event: unknown, hookCtx: unknown): Promise<undefined | { prependContext: string }> => {
        const ev = event as {
          messageCount?: number;
          tokenCount?: number;
          compactedCount?: number;
          sessionFile?: string;
        };

        const hookModel = resolveCompactionHookModelMetadata(event, hookCtx);
        if (hookModel) {
          const alert = buildCompactionWatchdogAlert({
            stage: "after_compaction",
            model: hookModel.model,
            provider: hookModel.provider,
            source: hookModel.source,
          });
          if (alert) api.logger.warn?.(alert);
        } else {
          api.logger.debug?.(
            "memory-hybrid: after_compaction watchdog — compaction provider/model metadata not exposed",
          );
          emitCompactionModelWatchdogAlert(api, "after_compaction", { event, hookCtx });
        }

        const msgCount = ev.messageCount ?? 0;
        const compacted = ev.compactedCount ?? 0;
        const tokenCount = ev.tokenCount ?? 0;

        api.logger.info?.(
          `memory-hybrid: after_compaction — messages=${msgCount} tokens≈${tokenCount} compacted=${compacted}`,
        );

        // Silent mode: skip memory summary injection entirely (no DB queries, no prependContext).
        if (ctx.cfg.verbosity === "silent") return;

        // Verify SQLite is still accessible after compaction
        let factCount = 0;
        try {
          factCount = ctx.factsDb.getCount();
          api.logger.debug?.(`memory-hybrid: after_compaction — SQLite health OK, ${factCount} facts in store`);
        } catch (dbErr) {
          api.logger.warn?.(
            `memory-hybrid: after_compaction — SQLite health check failed: ${dbErr}. Memory may be unavailable until restart.`,
          );
          // No summary injection if DB is unavailable
          return;
        }

        // Build post-compaction memory summary to help the agent resume with full context.
        // Inject the top-N most recent/important facts so the agent's first post-compaction
        // response references the right state.
        //
        // Issue #957: When auto-recall is on, re-run the recall pipeline against the last user
        // prompt (see lastAutoRecallPromptRef) so semantic/FTS matches are not lost after compaction.
        //
        // NOTE: `after_compaction` may not support prependContext in all OpenClaw versions.
        // The return value is a best-effort injection — older runtimes will silently ignore it.
        try {
          const postCompactionBudget = Math.min(
            ctx.cfg.autoRecall.maxTokens ?? 800,
            ctx.cfg.retrieval.ambientBudgetTokens ?? 2000,
            Math.max(400, Math.floor((ev.tokenCount ?? 800) * 0.15)),
          );
          const blocks: string[] = [];
          let usedRecallSnippet = false;
          const compactionSessionKey =
            resolveSessionKeyFromHookEvent(event, hookCtx) ?? lifecycleContext.currentAgentIdRef.value ?? "default";
          const lastPrompt =
            lifecycleContext.lastAutoRecallPromptBySession.get(compactionSessionKey)?.trim() ??
            (typeof lifecycleContext.lastAutoRecallPromptRef.value === "string"
              ? lifecycleContext.lastAutoRecallPromptRef.value.trim()
              : "");

          if (ctx.cfg.autoRecall.enabled) {
            if (lastPrompt.length >= 5) {
              const recallBlock = await buildPostCompactionRecallSnippet(
                lifecycleContext,
                api,
                lastPrompt,
                postCompactionBudget,
              );
              if (recallBlock) {
                blocks.push(recallBlock);
                usedRecallSnippet = true;
                api.logger.debug?.("memory-hybrid: after_compaction — injecting post-compaction recall snippet (#957)");
              }
            }
          }

          const summaryInner: string[] = [];

          if (!usedRecallSnippet) {
            const scopeFilter = resolveRecallScopeFilter(lifecycleContext);
            const tierFilter = ctx.cfg.memoryTiering.enabled ? ("warm" as const) : ("all" as const);
            const summaryFacts =
              lastPrompt.length >= 5
                ? ctx.factsDb
                    .search(lastPrompt, 8, { scopeFilter, tierFilter, deferAccessRefresh: true })
                    .map((r) => r.entry)
                : ctx.cfg.memoryTiering.enabled
                  ? ctx.factsDb.getHotFacts(8, scopeFilter).map((r) => r.entry)
                  : ctx.factsDb.list(8);
            if (summaryFacts.length > 0) {
              summaryInner.push("Key memories retained across compaction:");
              for (const f of summaryFacts) {
                const line = formatSanitizedMemoryPreview(f.text, {
                  entity: f.entity,
                  maxChars: 150,
                });
                if (line) summaryInner.push(line);
              }
            }
          }

          if (ctx.issueStore) {
            try {
              const openIssues = ctx.issueStore.list({
                status: ["open", "diagnosed", "fix-attempted"],
                limit: 5,
              });
              if (openIssues.length > 0) {
                if (summaryInner.length > 0) summaryInner.push("");
                summaryInner.push("Open issues:");
                for (const issue of openIssues) {
                  const title = sanitizePromptInjection(issue.title);
                  const severity = sanitizePromptInjection(issue.severity);
                  const status = sanitizePromptInjection(issue.status);
                  summaryInner.push(`- [${severity}] ${title} (${status})`);
                }
              }
            } catch {
              // Non-fatal
            }
          }

          if (summaryInner.length > 0) {
            const remaining = Math.max(0, postCompactionBudget - blocks.reduce((sum, b) => sum + estimateTokens(b), 0));
            const wrapped = assembleRecallPrependContext(lifecycleContext, summaryInner.join("\n"), {
              edictMaxTokens: edictMaxTokensForBudget(remaining, DEFAULT_EDICT_BUDGET_FRACTION),
            });
            if (wrapped) {
              const summaryBlock = [
                "<!-- memory-hybrid: post-compaction memory summary -->",
                trimBlockToBudget(wrapped, remaining).text,
                "<!-- /memory-hybrid: post-compaction memory summary -->",
              ].join("\n");
              blocks.push(summaryBlock);
            }
          }

          const combined = blocks.filter((b) => b.trim().length > 0).join("\n\n");
          const trimmed = trimBlockToBudget(combined, postCompactionBudget).text;
          if (trimmed) {
            api.logger.debug?.(
              `memory-hybrid: after_compaction — injecting post-compaction context (~${estimateTokens(trimmed)} tokens, recall=${usedRecallSnippet})`,
            );
            return { prependContext: trimmed };
          }
        } catch {
          // Non-fatal — summary injection failure should not disrupt normal operation
        }
      },
    );
  } catch (err) {
    // Older runtimes may throw on unknown hook names
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "lifecycle",
      operation: "register-after_compaction",
    });
    api.logger.debug?.(`memory-hybrid: after_compaction hook not available (${err})`);
  }

  // Update context refs from hooks (they may have been mutated)
  // Note: This is a workaround for the fact that the hooks need to update these values
  // but we can't easily pass them by reference in TypeScript without using objects.
  // The hooks update ctx.currentAgentId and ctx.lastProgressiveIndexIds internally.

  // Issue #463: Return handle for cleanup
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeRegisteredHooks();
      hooks.dispose();
    },
  };
}
