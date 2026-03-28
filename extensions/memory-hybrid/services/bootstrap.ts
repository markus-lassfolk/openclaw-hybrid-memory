import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { FactsDB } from "../backends/facts-db.js";
import { EdictStore } from "../backends/edict-store.js";
import { VectorDB } from "../backends/vector-db.js";
import type { BootstrapPhaseConfig, EmbeddingModelConfig, HybridMemoryConfig } from "../config.js";
import { buildEmbeddingRegistry, type EmbeddingRegistry } from "./embedding-registry.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { join, dirname } from "node:path";

export interface CoreBootstrapContext {
  cfg: HybridMemoryConfig;
  api: ClawdbotPluginApi;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
}

export interface CoreBootstrapServices {
  factsDb: FactsDB;
  edictStore: EdictStore;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  embeddingRegistry: EmbeddingRegistry;
}

export type CoreBootstrapInstaller = BootstrapPhaseConfig & {
  id: string;
  install(context: CoreBootstrapContext): CoreBootstrapServices;
};

function resolveEmbeddingRegistryModels(
  embedding: HybridMemoryConfig["embedding"],
): EmbeddingModelConfig[] | undefined {
  if (Array.isArray(embedding.multiModels) && embedding.multiModels.length > 0) {
    return embedding.multiModels;
  }
  const rawModels = (embedding as unknown as { models?: unknown }).models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) return undefined;
  const hasObjectModels = rawModels.every((item) => item && typeof item === "object");
  if (!hasObjectModels) return undefined;
  return rawModels as EmbeddingModelConfig[];
}

export const coreBootstrapInstaller: CoreBootstrapInstaller = {
  id: "memoryCore",
  bootstrapPhase: "core",
  install({ cfg, api, resolvedSqlitePath, resolvedLancePath }) {
    let factsDb: FactsDB;
    try {
      factsDb = new FactsDB(resolvedSqlitePath, {
        fuzzyDedupe: cfg.store.fuzzyDedupe,
      });
    } catch (err) {
      api.logger.error(`memory-hybrid: core bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // EdictStore: separate SQLite file alongside facts DB, for verified ground-truth facts
    const edictStorePath = join(dirname(resolvedSqlitePath), "edicts.db");
    const edictStore = new EdictStore(edictStorePath);

    const vectorDb = new VectorDB(resolvedLancePath, cfg.embedding.dimensions, cfg.vector.autoRepair);
    vectorDb.setLogger(api.logger);

    const embeddings = createEmbeddingProvider(cfg.embedding, (err) => {
      api.logger.warn(
        `memory-hybrid: ${cfg.embedding.provider} embedding unavailable (${err}), switching to OpenAI fallback`,
      );
    });
    const embeddingRegistry = buildEmbeddingRegistry(
      embeddings,
      cfg.embedding.model,
      resolveEmbeddingRegistryModels(cfg.embedding),
    );

    return {
      factsDb,
      edictStore,
      vectorDb,
      embeddings,
      embeddingRegistry,
    };
  },
};

export function installCoreBootstrapServices(context: CoreBootstrapContext): CoreBootstrapServices {
  return coreBootstrapInstaller.install(context);
}
