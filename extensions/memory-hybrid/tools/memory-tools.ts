/**
 * Memory Tool Registrations — orchestrator re-exporting split modules under tools/memory/.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { BuildToolScopeFilterFn, FindSimilarByEmbeddingFn } from "../api/memory-plugin-api.js";
import { buildMemoryToolRuntime } from "./memory/build-runtime.js";
import { registerCheckpointTools } from "./memory/register-checkpoint-tools.js";
import { registerDirectoryTools } from "./memory/register-directory-tools.js";
import { registerEdictTools } from "./memory/register-edict-tools.js";
import { registerEpisodeTools } from "./memory/register-episode-tools.js";
import { registerRecallTools } from "./memory/register-recall-tools.js";
import { registerAgentVerbTools } from "./memory/register-agent-verb-tools.js";
import { registerStoreTools } from "./memory/register-store-tools.js";
import { resolveMemoryToolsContext } from "./memory/helpers.js";
import type { BoundWalRemoveFn, BoundWalWriteFn, MemoryToolsContext } from "./memory/types.js";

export type { BoundWalRemoveFn, BoundWalWriteFn, MemoryToolsContext } from "./memory/types.js";

export function registerMemoryTools(ctx: MemoryToolsContext, api: ClawdbotPluginApi): void;
export function registerMemoryTools(
  ctx: Omit<MemoryToolsContext, "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"> & {
    wal?: unknown;
  },
  api: ClawdbotPluginApi,
  buildToolScopeFilter: BuildToolScopeFilterFn,
  walWrite: BoundWalWriteFn,
  walRemove: BoundWalRemoveFn,
  findSimilarByEmbedding: FindSimilarByEmbeddingFn,
): void;
export function registerMemoryTools(
  ctx:
    | MemoryToolsContext
    | (Omit<MemoryToolsContext, "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"> & {
        wal?: unknown;
      }),
  api: ClawdbotPluginApi,
  legacyBuildToolScopeFilter?: BuildToolScopeFilterFn,
  legacyWalWrite?: BoundWalWriteFn,
  legacyWalRemove?: BoundWalRemoveFn,
  legacyFindSimilarByEmbedding?: FindSimilarByEmbeddingFn,
): void {
  const resolvedContext = resolveMemoryToolsContext(
    ctx as Parameters<typeof resolveMemoryToolsContext>[0],
    legacyBuildToolScopeFilter,
    legacyWalWrite,
    legacyWalRemove,
    legacyFindSimilarByEmbedding,
  );
  const runtime = buildMemoryToolRuntime(resolvedContext, api);
  registerRecallTools(runtime);
  registerAgentVerbTools(runtime);
  registerStoreTools(runtime);
  registerDirectoryTools(runtime);
  registerCheckpointTools(runtime);
  registerEpisodeTools(runtime);
  registerEdictTools(runtime);
}
