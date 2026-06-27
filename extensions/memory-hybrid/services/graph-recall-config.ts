import type { HybridMemoryConfig } from "../config.js";

/** Warn when graph recall settings overlap or legacy keys are used. */
export function warnGraphRecallConfigMisconfiguration(
  cfg: HybridMemoryConfig,
  logWarn?: (message: string) => void,
): void {
  if (!logWarn || !cfg.graph.enabled) return;

  if (
    cfg.graphRetrieval.enabled &&
    cfg.graphRetrieval.defaultExpand &&
    cfg.graph.useInRecall
  ) {
    logWarn(
      "memory-hybrid: graph.useInRecall is redundant when graphRetrieval.defaultExpand is true — set useInRecall to false to avoid confusion (legacy flat traversal is skipped).",
    );
  }

  if (cfg.graph.autoLink && !cfg.retrieval.strategies.includes("graph")) {
    logWarn(
      'memory-hybrid: graph.autoLink is on but retrieval.strategies omits "graph" — explicit memory_recall will not run orchestrator GraphRAG expansion.',
    );
  }
}
