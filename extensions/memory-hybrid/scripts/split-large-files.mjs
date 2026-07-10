#!/usr/bin/env node
/**
 * One-shot mechanical split for large source files.
 * Run from extensions/memory-hybrid: node scripts/split-large-files.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sliceLines(path, start, end) {
  const lines = readFileSync(join(root, path), "utf-8").split("\n");
  return lines.slice(start - 1, end).join("\n");
}

function write(path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
  console.log("wrote", path, `(${content.split("\n").length} lines)`);
}

// --- memory-tools: extract header (types + helpers + resolve) and body chunks ---
const memPath = "tools/memory-tools.ts";
const memFull = readFileSync(join(root, memPath), "utf-8");
const memLines = memFull.split("\n");

// One-shot migration (already run): tools/memory-tools.ts is now a thin orchestrator re-exporting
// the already-split tools/memory/*.ts modules, not the pre-split monolith this script's hardcoded
// line offsets assume. Re-running against the current file would unconditionally overwrite every
// tools/memory/*.ts module (and helpers.ts/types.ts/build-runtime.ts/runtime.ts) with near-empty
// stubs sliced from far past the orchestrator's end (#2067-followup). Refuse rather than silently
// destroy production files -- `existsSync` was already imported for exactly this kind of guard but
// never wired up.
const MIN_EXPECTED_LINES = 3612;
if (memLines.length < MIN_EXPECTED_LINES || !existsSync(join(root, "tools/memory/runtime.ts"))) {
  console.error(
    `split-large-files.mjs: ${memPath} has ${memLines.length} lines (expected >= ${MIN_EXPECTED_LINES}) or tools/memory/runtime.ts already exists. ` +
      "This one-shot migration already ran and the target files are already split -- re-running would overwrite them with near-empty stubs. Aborting.",
  );
  process.exit(1);
}

// Lines 1-77: imports only (keep in memory-tools.ts orchestrator + per-module)
const memImports = memLines.slice(0, 77).join("\n");

// Lines 79-250: types + helpers (before registerMemoryTools)
const memTypesHelpers = memLines.slice(78, 250).join("\n");

// registerMemoryTools: 252-384 setup, 386-3612 tool bodies
const memRegisterSetup = memLines.slice(251, 384).join("\n");

const MEMORY_CHUNKS = [
  { file: "tools/memory/register-recall-tools.ts", start: 386, end: 1578, fn: "registerRecallTools" },
  { file: "tools/memory/register-store-tools.ts", start: 1579, end: 2509, fn: "registerStoreTools" },
  { file: "tools/memory/register-directory-tools.ts", start: 2510, end: 2893, fn: "registerDirectoryTools" },
  { file: "tools/memory/register-checkpoint-tools.ts", start: 2894, end: 2994, fn: "registerCheckpointTools" },
  { file: "tools/memory/register-episode-tools.ts", start: 2995, end: 3280, fn: "registerEpisodeTools" },
  { file: "tools/memory/register-edict-tools.ts", start: 3281, end: 3612, fn: "registerEdictTools" },
];

const chunkImports = `${memImports}
import type { MemoryToolRuntime } from "./runtime.js";
`;

for (const chunk of MEMORY_CHUNKS) {
  const body = sliceLines(memPath, chunk.start, chunk.end);
  const content = `${chunkImports}

export function ${chunk.fn}(runtime: MemoryToolRuntime): void {
  const {
    factsDb,
    edictStore,
    vectorDb,
    cfg,
    embeddings,
    openai,
    credentialsDb,
    eventLog,
    narrativesDb,
    provenanceService,
    aliasDb,
    embeddingRegistry,
    verificationStore,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    variantQueue,
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    auditStore,
    api,
    auditAppend,
    agentIdForAudit,
    maybeRefreshProjectActiveTaskProjection,
    storeActiveCanonicalVector,
    storeRegistryEmbeddings,
    isEdictWriteToolEnabled,
    sanitizeScopeParam,
  } = runtime;

${body}
}
`;
  write(chunk.file, content);
}

write(
  "tools/memory/helpers.ts",
  `import type { EmbeddingRegistry } from "../../services/embedding-registry.js";
import { toFloat32Array } from "../../services/embedding-registry.js";
import type { EmbeddingProvider } from "../../services/embeddings.js";
import type { FactsDB } from "../../backends/facts-db.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { embedCallWithTimeoutAndRetry } from "../../utils/embed-call.js";
import { getEnv } from "../../utils/env-manager.js";
import type { BuildToolScopeFilterFn, FindSimilarByEmbeddingFn } from "../../api/memory-plugin-api.js";
import type { MemoryToolsContext } from "./types.js";

export const SCOPE_PARAM_MAX_LENGTH = 256;

export function sanitizeScopeParam(paramName: "userId" | "agentId" | "sessionId", v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v.length > SCOPE_PARAM_MAX_LENGTH) {
    throw new Error(\`\${paramName} must be <= \${SCOPE_PARAM_MAX_LENGTH} characters\`);
  }
  return v;
}

type LegacyMemoryToolsContext = Omit<
  MemoryToolsContext,
  "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"
> & {
  wal?: unknown;
};

export function hasBoundMemoryToolHelpers(ctx: MemoryToolsContext | LegacyMemoryToolsContext): ctx is MemoryToolsContext {
  const maybe = ctx as Partial<MemoryToolsContext> & { wal?: unknown };
  const hasAllNewHelpers =
    typeof maybe.buildToolScopeFilter === "function" &&
    typeof maybe.walWrite === "function" &&
    typeof maybe.walRemove === "function" &&
    typeof maybe.findSimilarByEmbedding === "function";
  const hasLegacyWal = typeof maybe.wal === "object" && maybe.wal !== null;
  return hasAllNewHelpers && !hasLegacyWal;
}

export function isEdictWriteToolEnabled(): boolean {
  const raw = getEnv("OPENCLAW_ENABLE_EDICT_WRITE_TOOL");
  return raw === "1" || raw?.toLowerCase() === "true";
}

export async function storeRegistryEmbeddings({
  factsDb,
  embeddingRegistry,
  embeddings,
  factId,
  text,
  vector,
  logger,
  operation,
}: {
  factsDb: FactsDB;
  embeddingRegistry: import("../../services/embedding-registry.js").EmbeddingRegistry | null | undefined;
  embeddings: EmbeddingProvider;
  factId: string;
  text: string;
  vector?: number[] | Float32Array;
  logger: { warn: (msg: string) => void };
  operation: string;
}): Promise<void> {
  if (!embeddingRegistry) return;
  const vectors = new Map<string, Float32Array>();
  if (vector && vector.length > 0) {
    vectors.set(embeddings.modelName, toFloat32Array(vector));
  }
  if (embeddingRegistry.isMultiModel()) {
    const models = embeddingRegistry.getModels();
    const tasks = models.map(async (cfg) => ({
      name: cfg.name,
      vec: await embedCallWithTimeoutAndRetry(
        () => embeddingRegistry.embed(text, cfg.name),
        \`\${operation}:\${cfg.name}\`,
      ),
    }));
    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === "fulfilled") {
        vectors.set(s.value.name, s.value.vec);
      } else {
        capturePluginError(s.reason instanceof Error ? s.reason : new Error(String(s.reason)), {
          subsystem: "embeddings",
          operation,
        });
      }
    }
    if (!vector) {
      try {
        const vec = await embedCallWithTimeoutAndRetry(() => embeddingRegistry.embed(text), \`\${operation}:primary\`);
        const modelName = embeddings.modelName || embeddingRegistry.getPrimaryModel().name;
        vectors.set(modelName, vec);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "embeddings",
          operation,
        });
      }
    }
  } else if (!vector) {
    try {
      const vec = await embedCallWithTimeoutAndRetry(() => embeddingRegistry.embed(text), \`\${operation}:primary\`);
      const modelName = embeddings.modelName || embeddingRegistry.getPrimaryModel().name;
      vectors.set(modelName, vec);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "embeddings",
        operation,
      });
    }
  }
  if (vectors.size === 0) {
    logger.warn(
      \`memory-hybrid: embeddingRegistry produced no vectors for fact \${factId} (\${operation}) — caller should treat as embedding failure\`,
    );
    return;
  }
  for (const [model, vec] of vectors) {
    try {
      factsDb.storeEmbedding(factId, model, "canonical", vec, vec.length);
    } catch (err) {
      logger.warn(\`memory-hybrid: fact_embeddings store failed (\${model}): \${err}\`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "fact-embeddings",
        operation,
      });
    }
  }
}

export function resolveMemoryToolsContext(
  ctx: MemoryToolsContext | LegacyMemoryToolsContext,
  legacyBuildToolScopeFilter?: BuildToolScopeFilterFn,
  legacyWalWrite?: import("./types.js").BoundWalWriteFn,
  legacyWalRemove?: import("./types.js").BoundWalRemoveFn,
  legacyFindSimilarByEmbedding?: FindSimilarByEmbeddingFn,
): MemoryToolsContext {
  if (hasBoundMemoryToolHelpers(ctx)) {
    return ctx;
  }
  if (
    typeof legacyBuildToolScopeFilter !== "function" ||
    typeof legacyWalWrite !== "function" ||
    typeof legacyWalRemove !== "function" ||
    typeof legacyFindSimilarByEmbedding !== "function"
  ) {
    throw new Error("registerMemoryTools: Missing required legacy helper functions for memory tools initialization.");
  }
  return {
    ...ctx,
    buildToolScopeFilter: legacyBuildToolScopeFilter,
    walWrite: legacyWalWrite,
    walRemove: legacyWalRemove,
    findSimilarByEmbedding: legacyFindSimilarByEmbedding,
  };
}
`,
);

// types.ts - only types from original
const typesOnly = memLines.slice(78, 139).join("\n");
write(
  "tools/memory/types.ts",
  `import type OpenAI from "openai";
import type { BuildToolScopeFilterFn, FindSimilarByEmbeddingFn } from "../../api/memory-plugin-api.js";
import type { AuditStore } from "../../backends/audit-store.js";
import type { CredentialsDB } from "../../backends/credentials-db.js";
import type { EdictStore } from "../../backends/edict-store.js";
import type { EventLog } from "../../backends/event-log.js";
import type { FactsDB } from "../../backends/facts-db.js";
import type { NarrativesDB } from "../../backends/narratives-db.js";
import type { VectorDB } from "../../backends/vector-db.js";
import type { HybridMemoryConfig } from "../../config.js";
import type { PendingLLMWarnings } from "../../services/chat.js";
import type { VariantGenerationQueue } from "../../services/contextual-variants.js";
import type { EmbeddingRegistry } from "../../services/embedding-registry.js";
import type { EmbeddingProvider } from "../../services/embeddings.js";
import type { ProvenanceService } from "../../services/provenance.js";
import type { AliasDB } from "../../services/retrieval-aliases.js";
import type { VerificationStore } from "../../services/verification-store.js";

${typesOnly}
`,
);

// build-runtime.ts - from memRegisterSetup adapted
write(
  "tools/memory/build-runtime.ts",
  `import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { TASK_LEDGER_CATEGORY, refreshActiveTaskProjectionBestEffort } from "../../services/task-ledger-facts.js";
import { storeCanonicalVectorForFact } from "../../services/vector-maintenance.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveWorkspacePath } from "../../utils/path.js";
import type { MemoryToolsContext } from "./types.js";
import type { MemoryToolRuntime } from "./runtime.js";
import {
  isEdictWriteToolEnabled,
  sanitizeScopeParam,
  storeRegistryEmbeddings,
} from "./helpers.js";

export function buildMemoryToolRuntime(
  resolvedContext: MemoryToolsContext,
  api: ClawdbotPluginApi,
): MemoryToolRuntime {
  const {
    factsDb,
    edictStore,
    vectorDb,
    cfg,
    embeddings,
    openai,
    credentialsDb,
    eventLog,
    narrativesDb,
    provenanceService,
    aliasDb,
    embeddingRegistry,
    verificationStore,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    variantQueue,
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    auditStore,
  } = resolvedContext;

  const agentIdForAudit = () => currentAgentIdRef.value || cfg.multiAgent.orchestratorId || "unknown";

  function auditAppend(input: import("../../backends/audit-store.js").AuditEventInput): void {
    if (!auditStore) return;
    try {
      auditStore.append(input);
    } catch {
      /* non-fatal */
    }
  }

  const activeTaskCfg = cfg.activeTask;
  const activeTaskProjectionPath = activeTaskCfg ? resolveWorkspacePath(activeTaskCfg.filePath) : null;
  const activeTaskStaleMinutes = (() => {
    if (!activeTaskCfg) return parseDuration("24h");
    try {
      return parseDuration(activeTaskCfg.staleThreshold);
    } catch {
      return parseDuration("24h");
    }
  })();

  const maybeRefreshProjectActiveTaskProjection = async (
    factCategory: string,
    factId: string,
    factScope: string | null | undefined,
  ): Promise<void> => {
    if (!activeTaskCfg || !activeTaskCfg.enabled || activeTaskCfg.ledger !== "facts" || !activeTaskProjectionPath)
      return;
    if (factCategory !== TASK_LEDGER_CATEGORY) return;
    if ((factScope ?? "global") !== "global") return;
    await refreshActiveTaskProjectionBestEffort({
      factsDb,
      staleMinutes: activeTaskStaleMinutes,
      filePath: activeTaskProjectionPath,
      projection: activeTaskCfg.projection,
      reason: "memory_store_project_fact_write",
      source: "memory_store",
      factId,
      logger: api.logger,
    });
  };

  const storeActiveCanonicalVector = async (options: {
    factId: string;
    text: string;
    why?: string | null;
    vector: number[];
    importance: number;
    category: string;
  }): Promise<void> => {
    await storeCanonicalVectorForFact({
      vectorDb,
      factsDb,
      factId: options.factId,
      text: options.text,
      why: options.why,
      vector: options.vector,
      importance: options.importance,
      category: options.category,
      embeddingModel: embeddings.modelName,
    });
  };

  return {
    ...resolvedContext,
    api,
    auditAppend,
    agentIdForAudit,
    maybeRefreshProjectActiveTaskProjection,
    storeActiveCanonicalVector,
    storeRegistryEmbeddings,
    isEdictWriteToolEnabled,
    sanitizeScopeParam,
  };
}
`,
);

// runtime.ts
write(
  "tools/memory/runtime.ts",
  `import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { MemoryToolsContext } from "./types.js";
import type {
  isEdictWriteToolEnabled,
  sanitizeScopeParam,
  storeRegistryEmbeddings,
} from "./helpers.js";

export type MemoryToolRuntime = MemoryToolsContext & {
  api: ClawdbotPluginApi;
  auditAppend: (input: import("../../backends/audit-store.js").AuditEventInput) => void;
  agentIdForAudit: () => string;
  maybeRefreshProjectActiveTaskProjection: (
    factCategory: string,
    factId: string,
    factScope: string | null | undefined,
  ) => Promise<void>;
  storeActiveCanonicalVector: (options: {
    factId: string;
    text: string;
    why?: string | null;
    vector: number[];
    importance: number;
    category: string;
  }) => Promise<void>;
  storeRegistryEmbeddings: typeof storeRegistryEmbeddings;
  isEdictWriteToolEnabled: typeof isEdictWriteToolEnabled;
  sanitizeScopeParam: typeof sanitizeScopeParam;
};
`,
);

// New memory-tools.ts orchestrator
write(
  "tools/memory-tools.ts",
  `/**
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
import { registerStoreTools } from "./memory/register-store-tools.js";
import { resolveMemoryToolsContext } from "./memory/helpers.js";
import type { BoundWalRemoveFn, BoundWalWriteFn, MemoryToolsContext } from "./memory/types.js";

export type { BoundWalRemoveFn, BoundWalWriteFn, MemoryToolsContext } from "./memory/types.js";

export function registerMemoryTools(ctx: MemoryToolsContext, api: ClawdbotPluginApi): void;
export function registerMemoryTools(
  ctx: Omit<
    MemoryToolsContext,
    "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"
  > & { wal?: unknown },
  api: ClawdbotPluginApi,
  buildToolScopeFilter: BuildToolScopeFilterFn,
  walWrite: BoundWalWriteFn,
  walRemove: BoundWalRemoveFn,
  findSimilarByEmbedding: FindSimilarByEmbeddingFn,
): void;
export function registerMemoryTools(
  ctx: MemoryToolsContext | (Omit<MemoryToolsContext, "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"> & { wal?: unknown }),
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
  registerStoreTools(runtime);
  registerDirectoryTools(runtime);
  registerCheckpointTools(runtime);
  registerEpisodeTools(runtime);
  registerEdictTools(runtime);
}
`,
);

console.log("memory-tools split done");
