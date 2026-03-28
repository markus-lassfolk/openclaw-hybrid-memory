/**
 * Lifecycle Hooks Registration Wiring
 *
 * Registers lifecycle event hooks (before_agent_start, agent_end) with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import { getMemoryCategories } from "../config.js";
import { createLifecycleHooks, type LifecycleContext } from "../lifecycle/hooks.js";
import { capturePluginError } from "../services/error-reporter.js";
import { sanitizeMessagesForClaude, type MessageLike } from "../utils/sanitize-messages.js";
import { runPreConsolidationFlush } from "../services/pre-consolidation-flush.js";
import { WorkflowTracker } from "../services/workflow-tracker.js";

/** Lifecycle hooks receive the stable plugin API (Phase 3). */
export type HooksContext = MemoryPluginAPI;

/** Issue #463: Returned handle for lifecycle hook cleanup. */
export interface LifecycleHooksHandle {
  /** Dispose all timers and clear per-session state (call on plugin stop). */
  dispose: () => void;
}

/**
 * Register all lifecycle hooks with the OpenClaw API.
 * Creates and attaches before_agent_start and agent_end event handlers.
 * Returns a handle for cleanup (dispose).
 */
export function registerLifecycleHooks(ctx: HooksContext, api: ClawdbotPluginApi): LifecycleHooksHandle {
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
      restartPendingClearedRef: ctx.restartPendingClearedRef,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      walWrite: (operation, data, logger) => ctx.walWrite(ctx.wal, operation, data, logger),
      walRemove: (id, logger) => ctx.walRemove(ctx.wal, id, logger),
      findSimilarByEmbedding: ctx.findSimilarByEmbedding,
      shouldCapture: ctx.shouldCapture,
      detectCategory: ctx.detectCategory,
      pendingLLMWarnings: ctx.pendingLLMWarnings,
      issueStore: ctx.issueStore,
      recallInFlightRef: ctx.recallInFlightRef,
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
  try {
    hooks.onAgentStart(api);
    hooks.onAgentEnd(api);
    hooks.onFrustrationDetect?.(api);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-hooks:attach",
    });
    hooks.dispose();
    throw err;
  }

  // Inject pending LLM config warnings into the agent's context once per occurrence.
  // Fires when all models in a tier fail due to missing provider API keys, so the AI
  // can relay the issue to the user in its response.
  api.on("before_prompt_build", (): undefined | { prependContext: string } => {
    if (!ctx.pendingLLMWarnings) return;
    const warnings = ctx.pendingLLMWarnings.drain();
    if (warnings.length === 0) return;

    // Wrap warnings in a stable, parseable block to prevent prompt pollution
    const wrappedWarnings = [
      "<llm-config-warning>",
      ...warnings,
      "Note: These configuration warnings will not repeat in this session.",
      "</llm-config-warning>",
    ].join("\n");

    return { prependContext: wrappedWarnings };
  });

  // Temporary fix: ensure every tool_use has a tool_result immediately after (Claude API requirement).
  // Mutates event.historyMessages in place so OpenClaw core uses the sanitized array.
  api.on("llm_input", (ev: unknown) => {
    const event = ev as { historyMessages?: unknown[] };
    if (!event?.historyMessages || !Array.isArray(event.historyMessages)) return;
    const sanitized = sanitizeMessagesForClaude(event.historyMessages as MessageLike[]);
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
  // Silent mode suppresses all unsolicited output including capability hints (Issue #317).
  if (ctx.cfg.autoRecall.enabled && ctx.cfg.verbosity !== "silent") {
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

    // Register a before_prompt_build hook that injects static memory instructions.
    // Uses prependContext — the only field supported by the current SDK (see TODO above).
    // The content is built once and cached to minimise per-turn overhead.
    api.on("before_prompt_build", (): undefined | { prependContext: string } => {
      if (!staticMemoryInstructions) {
        staticMemoryInstructions = buildStaticInstructions();
      }
      return { prependContext: staticMemoryInstructions };
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
    api.on("before_compaction", async (event: unknown) => {
      const ev = event as {
        messageCount?: number;
        tokenCount?: number;
        compactingCount?: number;
        sessionFile?: string;
      };

      await runPreConsolidationFlush(
        { wal: ctx.wal, factsDb: ctx.factsDb, vectorDb: ctx.vectorDb, embeddings: ctx.embeddings },
        api.logger,
        "before_compaction",
      );

      // Log pre-compaction snapshot for diagnostics
      const msgCount = ev.messageCount ?? 0;
      const tokenCount = ev.tokenCount ?? 0;
      api.logger.info?.(
        `memory-hybrid: before_compaction — messages=${msgCount} tokens≈${tokenCount} compacting=${ev.compactingCount ?? "?"}`,
      );

      let injectedContext = "";

      try {
        const fs = await import("node:fs");
        if (typeof api.resolvePath === "function") {
          const agentsMdPath = api.resolvePath("AGENTS.md");
          if (fs.existsSync(agentsMdPath)) {
            const content = fs.readFileSync(agentsMdPath, "utf-8");
            injectedContext += `\n<!-- Workspace Agent Rules (AGENTS.md) -->\n${content}\n`;
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

        const pinnedFacts = hotFacts.filter(
          (x) => x.entry.decayClass === "permanent" || (x.entry.recallCount ?? 0) >= pinnedRecallThreshold,
        );

        if (pinnedFacts.length > 0) {
          injectedContext += "\n<!-- Pinned Session Constraints / Memories -->\n";
          injectedContext += `${pinnedFacts.map((f) => `- ${f.entry.summary || f.entry.text}`).join("\n")}\n`;
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

  try {
    api.on("before_consolidation", async (event: unknown) => {
      const ev = event as {
        candidateCount?: number;
        source?: string;
        sessionFile?: string;
      };

      await runPreConsolidationFlush(
        { wal: ctx.wal, factsDb: ctx.factsDb, vectorDb: ctx.vectorDb, embeddings: ctx.embeddings },
        api.logger,
        "before_consolidation",
      );

      api.logger.info?.(
        `memory-hybrid: before_consolidation — candidates=${ev.candidateCount ?? "?"} source=${ev.source ?? "?"}`,
      );
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "lifecycle",
      operation: "register-before_consolidation",
    });
    api.logger.debug?.(`memory-hybrid: before_consolidation hook not available (${err})`);
  }

  try {
    api.on("after_compaction", async (event: unknown): Promise<undefined | { prependContext: string }> => {
      const ev = event as {
        messageCount?: number;
        tokenCount?: number;
        compactedCount?: number;
        sessionFile?: string;
      };

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
      // NOTE: `after_compaction` may not support prependContext in all OpenClaw versions.
      // The return value is a best-effort injection — older runtimes will silently ignore it.
      try {
        const summaryFacts = ctx.factsDb.list(8);
        const summaryLines: string[] = [];

        if (summaryFacts.length > 0) {
          summaryLines.push("<!-- memory-hybrid: post-compaction memory summary -->");
          summaryLines.push("Key memories retained across compaction:");
          for (const f of summaryFacts) {
            const entityPrefix = f.entity ? `[${f.entity}] ` : "";
            const preview = f.text.length > 150 ? `${f.text.slice(0, 150)}…` : f.text;
            summaryLines.push(`- ${entityPrefix}${preview}`);
          }
        }

        // Append open issues summary if IssueStore is available
        if (ctx.issueStore) {
          try {
            const openIssues = ctx.issueStore.list({
              status: ["open", "diagnosed", "fix-attempted"],
              limit: 5,
            });
            if (openIssues.length > 0) {
              summaryLines.push("");
              summaryLines.push("Open issues:");
              for (const issue of openIssues) {
                summaryLines.push(`- [${issue.severity}] ${issue.title} (${issue.status})`);
              }
            }
          } catch {
            // Non-fatal
          }
        }

        if (summaryLines.length > 0) {
          summaryLines.push("<!-- /memory-hybrid: post-compaction memory summary -->");
          api.logger.debug?.(
            `memory-hybrid: after_compaction — injecting memory summary (${summaryFacts.length} facts)`,
          );
          return { prependContext: summaryLines.join("\n") };
        }
      } catch {
        // Non-fatal — summary injection failure should not disrupt normal operation
      }
    });
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
  return {
    dispose: hooks.dispose,
  };
}
