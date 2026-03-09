/**
 * Lifecycle Hooks Registration Wiring
 *
 * Registers lifecycle event hooks (before_agent_start, agent_end) with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import { getMemoryCategories } from "../config.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";
import { createLifecycleHooks, type LifecycleContext } from "../lifecycle/hooks.js";
import { capturePluginError } from "../services/error-reporter.js";
import { sanitizeMessagesForClaude, type MessageLike } from "../utils/sanitize-messages.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import { replayWalEntries } from "../utils/wal-replay.js";

export interface HooksContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  embeddingRegistry?: EmbeddingRegistry | null;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  credentialsDb: CredentialsDB | null;
  aliasDb: import("../services/retrieval-aliases.js").AliasDB | null;
  wal: WriteAheadLog | null;
  eventLog: import("../backends/event-log.js").EventLog | null;
  currentAgentIdRef: { value: string | null };
  lastProgressiveIndexIds: string[];
  restartPendingClearedRef: { value: boolean };
  resolvedSqlitePath: string;
  walWrite: (operation: "store" | "update", data: Record<string, unknown>, logger: { warn: (msg: string) => void }) => string;
  walRemove: (id: string, logger: { warn: (msg: string) => void }) => void;
  findSimilarByEmbedding: (
    vectorDb: VectorDB,
    factsDb: { getById(id: string): MemoryEntry | null },
    vector: number[],
    limit: number,
    minScore?: number
  ) => Promise<MemoryEntry[]>;
  shouldCapture: (text: string) => boolean;
  detectCategory: (text: string) => import("../config.js").MemoryCategory;
  pendingLLMWarnings: PendingLLMWarnings;
  issueStore: import("../backends/issue-store.js").IssueStore | null;
}

/**
 * Register all lifecycle hooks with the OpenClaw API.
 * Creates and attaches before_agent_start and agent_end event handlers.
 */
export function registerLifecycleHooks(ctx: HooksContext, api: ClawdbotPluginApi): void {
  let lifecycleContext: LifecycleContext;
  try {
    lifecycleContext = {
      factsDb: ctx.factsDb,
      vectorDb: ctx.vectorDb,
      embeddings: ctx.embeddings,
      embeddingRegistry: ctx.embeddingRegistry ?? null,
      openai: ctx.openai,
      cfg: ctx.cfg,
      credentialsDb: ctx.credentialsDb,
      aliasDb: ctx.aliasDb,
      wal: ctx.wal,
      eventLog: ctx.eventLog,
      currentAgentIdRef: ctx.currentAgentIdRef,
      lastProgressiveIndexIds: ctx.lastProgressiveIndexIds,
      restartPendingClearedRef: ctx.restartPendingClearedRef,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      walWrite: ctx.walWrite,
      walRemove: ctx.walRemove,
      findSimilarByEmbedding: ctx.findSimilarByEmbedding,
      shouldCapture: ctx.shouldCapture,
      detectCategory: ctx.detectCategory,
      pendingLLMWarnings: ctx.pendingLLMWarnings,
      issueStore: ctx.issueStore,
    };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-hooks:context" });
    throw err;
  }

  let hooks;
  try {
    hooks = createLifecycleHooks(lifecycleContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-hooks:create" });
    throw err;
  }
  try {
    hooks.onAgentStart(api);
    hooks.onAgentEnd(api);
    hooks.onFrustrationDetect?.(api);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-hooks:attach" });
    throw err;
  }

  // Inject pending LLM config warnings into the agent's context once per occurrence.
  // Fires when all models in a tier fail due to missing provider API keys, so the AI
  // can relay the issue to the user in its response.
  api.on("before_prompt_build", (): void | { prependContext: string } => {
    if (!ctx.pendingLLMWarnings) return;
    const warnings = ctx.pendingLLMWarnings.drain();
    if (warnings.length === 0) return;

    // Wrap warnings in a stable, parseable block to prevent prompt pollution
    const wrappedWarnings = [
      "<llm-config-warning>",
      ...warnings,
      "Note: These configuration warnings will not repeat in this session.",
      "</llm-config-warning>"
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
  // Static capabilities text is injected as appendSystemContext (appended to the system prompt).
  // Providers that support prompt caching (e.g. Anthropic) can cache this suffix, saving
  // ~500-1000 tokens per turn compared to per-turn prependContext injection.
  //
  // Feature detection: if the return type doesn't support appendSystemContext/prependSystemContext
  // the values are silently ignored by older OpenClaw runtimes (unknown fields are stripped).
  // We ONLY inject when autoRecall is enabled — if the user opted out they don't want hints.
  if (ctx.cfg.autoRecall.enabled) {
    let staticMemoryInstructions: string | null = null;

    // Build once and cache — these never change within a gateway session.
    const buildStaticInstructions = (): string => {
      const cats = getMemoryCategories();
      const catList = cats.length > 0 ? cats.join(", ") : "preference, fact, decision, entity, pattern, rule, other, technical";
      return [
        "<!-- memory-hybrid: capability hints -->",
        "You have access to long-term memory tools for this session.",
        `Available categories: ${catList}.`,
        "Use memory_store to save important facts, preferences, and decisions.",
        "Use memory_recall(\"query\") or memory_recall(id: N) to retrieve specific memories.",
        "Use memory_forget(memoryId) to remove stale or incorrect memories.",
        "Memories are scoped (global / user / agent / session) — prefer global unless scoped context is needed.",
        "<!-- /memory-hybrid: capability hints -->",
      ].join("\n");
    };

    // Register a before_prompt_build hook that injects static instructions once per session.
    // Uses appendSystemContext for prompt-cache friendliness; falls back to prependContext on
    // older runtimes that don't recognise the field.
    api.on("before_prompt_build", (): void | { prependContext: string } => {
      if (!staticMemoryInstructions) {
        staticMemoryInstructions = buildStaticInstructions();
      }
      // Return object with prependContext (supported by all OpenClaw versions).
      // On modern runtimes (≥ 2026.3.8) the field is treated as appendSystemContext
      // by the runtime if it detects the content is stable / cache-friendly.
      // On older runtimes the prependContext is injected per-turn — still correct.
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

      // Flush WAL — replay any pending writes before the compaction LLM call
      // so the compaction summary can reference the most up-to-date memory state.
      if (ctx.wal) {
        let walCommitted = 0;
        let walSkipped = 0;
        try {
          const walEntries = ctx.wal.readAll();
          if (walEntries.length > 0) {
            api.logger.debug?.(
              `memory-hybrid: before_compaction — replaying ${walEntries.length} pending WAL entries`,
            );
            const result = await replayWalEntries(ctx.wal, ctx.factsDb, ctx.vectorDb, ctx.embeddings);
            walCommitted = result.committed;
            walSkipped = result.skipped;
            if (walCommitted > 0) {
              api.logger.info?.(
                `memory-hybrid: before_compaction — WAL replay: ${walCommitted} committed, ${walSkipped} skipped`,
              );
            }
          }
        } catch {
          // Non-fatal — WAL replay failure should not block compaction
        }
      }

      // Log pre-compaction snapshot for diagnostics
      const msgCount = ev.messageCount ?? 0;
      const tokenCount = ev.tokenCount ?? 0;
      api.logger.info?.(
        `memory-hybrid: before_compaction — messages=${msgCount} tokens≈${tokenCount} compacting=${ev.compactingCount ?? "?"}`,
      );
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
    api.on("after_compaction", async (event: unknown): Promise<void | { prependContext: string }> => {
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
            const preview = f.text.length > 150 ? f.text.slice(0, 150) + "…" : f.text;
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
}
