import { toFloat32Array } from "../../services/embedding-registry.js";
import type { EmbeddingProvider } from "../../services/embeddings.js";
import type { FactsDB } from "../../backends/facts-db.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { embedCallWithTimeoutAndRetry } from "../../utils/embed-call.js";
import { getEnv } from "../../utils/env-manager.js";
import type { BuildToolScopeFilterFn, FindSimilarByEmbeddingFn } from "../../api/memory-plugin-api.js";
import type { MemoryToolsContext } from "./types.js";

export const SCOPE_PARAM_MAX_LENGTH = 256;

export function sanitizeScopeParam(
  paramName: "userId" | "agentId" | "sessionId",
  v: string | undefined,
): string | undefined {
  if (v === undefined) return undefined;
  if (v.length > SCOPE_PARAM_MAX_LENGTH) {
    throw new Error(`${paramName} must be <= ${SCOPE_PARAM_MAX_LENGTH} characters`);
  }
  return v;
}

type LegacyMemoryToolsContext = Omit<
  MemoryToolsContext,
  "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"
> & {
  wal?: unknown;
};

export function hasBoundMemoryToolHelpers(
  ctx: MemoryToolsContext | LegacyMemoryToolsContext,
): ctx is MemoryToolsContext {
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
  if (!factsDb) {
    logger.warn(`memory-hybrid: fact_embeddings store skipped (${operation}) — factsDb unavailable`);
    return;
  }
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
        `${operation}:${cfg.name}`,
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
        const vec = await embedCallWithTimeoutAndRetry(() => embeddingRegistry.embed(text), `${operation}:primary`);
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
      const vec = await embedCallWithTimeoutAndRetry(() => embeddingRegistry.embed(text), `${operation}:primary`);
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
      `memory-hybrid: embeddingRegistry produced no vectors for fact ${factId} (${operation}) — caller should treat as embedding failure`,
    );
    return;
  }
  for (const [model, vec] of vectors) {
    try {
      factsDb.storeEmbedding(factId, model, "canonical", vec, vec.length);
    } catch (err) {
      logger.warn(`memory-hybrid: fact_embeddings store failed (${model}): ${err}`);
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
