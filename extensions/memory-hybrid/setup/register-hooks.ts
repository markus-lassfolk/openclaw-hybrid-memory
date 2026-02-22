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
import type { Embeddings } from "../services/embeddings.js";
import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";
import { createLifecycleHooks, type LifecycleContext } from "../lifecycle/hooks.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface HooksContext {
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
    minScore?: number
  ) => Promise<MemoryEntry[]>;
  shouldCapture: (text: string) => boolean;
  detectCategory: (text: string) => import("../config.js").MemoryCategory;
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
      openai: ctx.openai,
      cfg: ctx.cfg,
      credentialsDb: ctx.credentialsDb,
      wal: ctx.wal,
      currentAgentIdRef: ctx.currentAgentIdRef,
      lastProgressiveIndexIds: ctx.lastProgressiveIndexIds,
      restartPendingCleared: ctx.restartPendingCleared,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      walWrite: ctx.walWrite,
      walRemove: ctx.walRemove,
      findSimilarByEmbedding: ctx.findSimilarByEmbedding,
      shouldCapture: ctx.shouldCapture,
      detectCategory: ctx.detectCategory,
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
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-hooks:attach" });
    throw err;
  }

  // Update context refs from hooks (they may have been mutated)
  // Note: This is a workaround for the fact that the hooks need to update these values
  // but we can't easily pass them by reference in TypeScript without using objects.
  // The hooks update ctx.currentAgentId and ctx.lastProgressiveIndexIds internally.
}
