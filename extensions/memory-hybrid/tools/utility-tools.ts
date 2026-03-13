import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import type OpenAI from "openai";

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { HybridMemoryConfig } from "../config.js";
import { resolveReflectionModelAndFallbacks, isCompactVerbosity } from "../config.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { ProvenanceService } from "../services/provenance.js";
import { capturePluginError } from "../services/error-reporter.js";
import { detectClusters } from "../services/topic-clusters.js";
import { analyzeKnowledgeGaps } from "../services/knowledge-gaps.js";

export interface PluginContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  wal: WriteAheadLog | null;
  resolvedSqlitePath: string;
  provenanceService?: ProvenanceService | null;
}

// Helper function types (exported for register-tools ToolsContext)
export type RunReflectionFn = (
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  config: { defaultWindow: number; minObservations: number; enabled?: boolean },
  opts: { window: number; dryRun: boolean; model: string; fallbackModels?: string[] },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  provenanceService?: ProvenanceService | null
) => Promise<{ factsAnalyzed: number; patternsExtracted: number; patternsStored: number; window: number }>;

export type RunReflectionRulesFn = (
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string; fallbackModels?: string[] },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  provenanceService?: ProvenanceService | null
) => Promise<{ rulesExtracted: number; rulesStored: number }>;

export type RunReflectionMetaFn = (
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string; fallbackModels?: string[] },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  provenanceService?: ProvenanceService | null
) => Promise<{ metaExtracted: number; metaStored: number }>;

export function registerUtilityTools(
  ctx: PluginContext,
  api: ClawdbotPluginApi,
  runReflection: RunReflectionFn,
  runReflectionRules: RunReflectionRulesFn,
  runReflectionMeta: RunReflectionMetaFn,
  walWrite: (operation: "store" | "update", data: Record<string, unknown>) => string,
  walRemove: (id: string) => void,
): void {
  const { factsDb, vectorDb, embeddings, openai, cfg, provenanceService } = ctx;

  // memory_checkpoint
  api.registerTool(
    {
      name: "memory_checkpoint",
      label: "Memory Checkpoint",
      description:
        "Save or restore pre-flight checkpoints before risky/long operations. Auto-expires after 4 hours.",
      parameters: Type.Object({
        action: stringEnum(["save", "restore"] as const),
        intent: Type.Optional(
          Type.String({ description: "What you're about to do (for save)" }),
        ),
        state: Type.Optional(
          Type.String({ description: "Current state/context (for save)" }),
        ),
        expectedOutcome: Type.Optional(
          Type.String({ description: "What should happen if successful" }),
        ),
        workingFiles: Type.Optional(
          Type.Array(Type.String(), {
            description: "Files being modified",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { action, intent, state, expectedOutcome, workingFiles } =
          params as {
            action: "save" | "restore";
            intent?: string;
            state?: string;
            expectedOutcome?: string;
            workingFiles?: string[];
          };

        if (action === "save") {
          if (!intent || !state) {
            return {
              content: [
                {
                  type: "text",
                  text: "Checkpoint save requires 'intent' and 'state'.",
                },
              ],
              details: { error: "missing_param" },
            };
          }
          const id = factsDb.saveCheckpoint({
            intent,
            state,
            expectedOutcome,
            workingFiles,
          });
          return {
            content: [
              {
                type: "text",
                text: `Checkpoint saved (id: ${id.slice(0, 8)}..., TTL: 4h). Intent: ${intent.slice(0, 80)}`,
              },
            ],
            details: { action: "saved", id },
          };
        }

        const checkpoint = factsDb.restoreCheckpoint();
        if (!checkpoint) {
          return {
            content: [
              {
                type: "text",
                text: "No active checkpoint found (may have expired).",
              },
            ],
            details: { action: "not_found" },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Restored checkpoint (saved: ${checkpoint.savedAt}):\n- Intent: ${checkpoint.intent}\n- State: ${checkpoint.state}${checkpoint.expectedOutcome ? `\n- Expected: ${checkpoint.expectedOutcome}` : ""}${checkpoint.workingFiles?.length ? `\n- Files: ${checkpoint.workingFiles.join(", ")}` : ""}`,
            },
          ],
          details: { action: "restored", checkpoint },
        };
      },
    },
    { name: "memory_checkpoint" },
  );

  // memory_prune
  api.registerTool(
    {
      name: "memory_prune",
      label: "Memory Prune",
      description:
        "Prune expired memories and decay confidence of aging facts.",
      parameters: Type.Object({
        mode: Type.Optional(
          stringEnum(["hard", "soft", "both"] as const),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { mode = "both" } = params as { mode?: "hard" | "soft" | "both" };

        let hardPruned = 0;
        let softPruned = 0;
        let linksPruned = 0;

        if (mode === "hard" || mode === "both") {
          hardPruned = factsDb.pruneExpired();
        }
        if (mode === "soft" || mode === "both") {
          softPruned = factsDb.decayConfidence();
        }

        // Always prune orphaned links (fast, no-op if none exist)
        linksPruned = factsDb.pruneOrphanedLinks();

        const breakdown = factsDb.statsBreakdown();
        const expired = factsDb.countExpired();

        const verbosity = cfg.verbosity ?? "normal";
        let text: string;
        if (isCompactVerbosity(verbosity)) {
          // Quiet: compact one-liner — statsBreakdown and countExpired are still computed above
          // and included in the `details` field for programmatic consumers; they're intentionally
          // omitted from the human-readable text to reduce noise in quiet sessions.
          const linksNote = linksPruned > 0 ? ` ${linksPruned} orphaned links.` : "";
          text = `Pruned: ${hardPruned + softPruned} (${hardPruned} expired, ${softPruned} low-confidence).${linksNote}`;
        } else {
          const linksNote = linksPruned > 0 ? `\nOrphaned links removed: ${linksPruned}` : "";
          const baseText = `Pruned: ${hardPruned} expired + ${softPruned} low-confidence.${linksNote}\nRemaining by class: ${JSON.stringify(breakdown)}\nPending expired: ${expired}`;
          const verboseExtra = verbosity === "verbose" ? `\nMode: ${mode}` : "";
          text = baseText + verboseExtra;
        }

        return {
          content: [{ type: "text", text }],
          details: { hardPruned, softPruned, linksPruned, breakdown, pendingExpired: expired },
        };
      },
    },
    { name: "memory_prune" },
  );

  // memory_reflect
  api.registerTool(
    {
      name: "memory_reflect",
      label: "Memory Reflect",
      description:
        "Run reflection on recent facts to synthesize behavioral patterns. Analyzes facts from the last N days, sends to LLM to extract patterns, stores new patterns (permanent, high importance) for better agent alignment.",
      parameters: Type.Object({
        window: Type.Optional(
          Type.Number({
            description: "Time window in days (1–90, default from config)",
            minimum: 1,
            maximum: 90,
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const reflectionCfg = cfg.reflection;
        if (!reflectionCfg.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "Reflection is disabled. Enable reflection.enabled in plugin config to use memory_reflect.",
              },
            ],
            details: { error: "reflection_disabled" },
          };
        }
        const window = Math.min(
          90,
          Math.max(1, typeof params.window === "number" ? params.window : reflectionCfg.defaultWindow),
        );
        const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
        try {
          const result = await runReflection(
            factsDb,
            vectorDb,
            embeddings,
            openai,
            { defaultWindow: reflectionCfg.defaultWindow, minObservations: reflectionCfg.minObservations },
            { window, dryRun: false, model: defaultModel, fallbackModels },
            api.logger,
            provenanceService,
          );
          const verbosity = cfg.verbosity ?? "normal";
          let reflectText: string;
          if (isCompactVerbosity(verbosity)) {
            reflectText = `Reflected: ${result.patternsStored} patterns stored.`;
          } else if (verbosity === "verbose") {
            reflectText = `Reflection complete: ${result.factsAnalyzed} facts analyzed, ${result.patternsExtracted} patterns extracted, ${result.patternsStored} stored (window: ${result.window} days, model: ${defaultModel}).`;
          } else {
            reflectText = `Reflection complete: ${result.factsAnalyzed} facts analyzed, ${result.patternsExtracted} patterns extracted, ${result.patternsStored} stored (window: ${result.window} days).`;
          }
          return {
            content: [{ type: "text", text: reflectText }],
            details: {
              factsAnalyzed: result.factsAnalyzed,
              patternsExtracted: result.patternsExtracted,
              patternsStored: result.patternsStored,
              window: result.window,
            },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "reflection",
            operation: "memory_reflect",
          });
          throw err;
        }
      },
    },
    { name: "memory_reflect" },
  );

  // memory_reflect_rules
  api.registerTool(
    {
      name: "memory_reflect_rules",
      label: "Memory Reflect Rules",
      description:
        "Synthesize existing behavioral patterns into actionable one-line rules (category rule). Run after memory_reflect when you have enough patterns.",
      parameters: Type.Object({}),
      async execute() {
        const reflectionCfg = cfg.reflection;
        if (!reflectionCfg.enabled) {
          return {
            content: [{ type: "text", text: "Reflection is disabled. Enable reflection.enabled in plugin config." }],
            details: { error: "reflection_disabled" },
          };
        }
        const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
        try {
          const result = await runReflectionRules(
            factsDb,
            vectorDb,
            embeddings,
            openai,
            { dryRun: false, model: defaultModel, fallbackModels },
            api.logger,
            provenanceService,
          );
          return {
            content: [
              {
                type: "text",
                text: `Rules synthesis: ${result.rulesExtracted} rules extracted, ${result.rulesStored} stored.`,
              },
            ],
            details: { rulesExtracted: result.rulesExtracted, rulesStored: result.rulesStored },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "reflection",
            operation: "memory_reflect_rules",
          });
          throw err;
        }
      },
    },
    { name: "memory_reflect_rules" },
  );

  // memory_reflect_meta
  api.registerTool(
    {
      name: "memory_reflect_meta",
      label: "Memory Reflect Meta",
      description:
        "Synthesize existing patterns into 1-3 higher-level meta-patterns (working style, principles). Run after memory_reflect when you have enough patterns.",
      parameters: Type.Object({}),
      async execute() {
        const reflectionCfg = cfg.reflection;
        if (!reflectionCfg.enabled) {
          return {
            content: [{ type: "text", text: "Reflection is disabled. Enable reflection.enabled in plugin config." }],
            details: { error: "reflection_disabled" },
          };
        }
        const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
        try {
          const result = await runReflectionMeta(
            factsDb,
            vectorDb,
            embeddings,
            openai,
            { dryRun: false, model: defaultModel, fallbackModels },
            api.logger,
            provenanceService,
          );
          return {
            content: [
              {
                type: "text",
                text: `Meta-pattern synthesis: ${result.metaExtracted} extracted, ${result.metaStored} stored.`,
              },
            ],
            details: { metaExtracted: result.metaExtracted, metaStored: result.metaStored },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "reflection",
            operation: "memory_reflect_meta",
          });
          throw err;
        }
      },
    },
    { name: "memory_reflect_meta" },
  );

  // memory_clusters
  api.registerTool(
    {
      name: "memory_clusters",
      label: "Memory Clusters",
      description:
        "Detect and return topic clusters — groups of densely interconnected facts forming natural knowledge domains. Runs BFS connected-component analysis on the memory graph. Returns cluster labels, sizes, and member fact IDs.",
      parameters: Type.Object({
        minClusterSize: Type.Optional(
          Type.Number({
            description: "Minimum facts to form a cluster (default from config, typically 3)",
            minimum: 2,
          }),
        ),
        save: Type.Optional(
          Type.Boolean({
            description: "Persist detected clusters to the database (default: true)",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const clustersCfg = cfg.clusters;
        if (!clustersCfg.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "Topic cluster detection is disabled. Set clusters.enabled: true in plugin config.",
              },
            ],
            details: { error: "clusters_disabled" },
          };
        }

        const minClusterSize =
          typeof params.minClusterSize === "number" && params.minClusterSize >= 2
            ? Math.floor(params.minClusterSize)
            : clustersCfg.minClusterSize;

        const shouldSave = params.save !== false;

        try {
          // Build existingClusterIds map for stable IDs across re-runs
          const existingClusters = factsDb.getClusters();
          const existingClusterIds = new Map<string, { id: string; createdAt: number }>();
          for (const cluster of existingClusters) {
            const members = factsDb.getClusterMembers(cluster.id);
            const componentKey = [...members].sort().join(",");
            existingClusterIds.set(componentKey, { id: cluster.id, createdAt: cluster.createdAt });
          }

          const result = detectClusters(factsDb, { minClusterSize, existingClusterIds });

          if (shouldSave) {
            factsDb.saveClusters(result.clusters);
          }

          const summary = result.clusters
            .map((c) => `  • ${c.label} (${c.factCount} facts)`)
            .join("\n");

          const text =
            result.clusters.length === 0
              ? `No topic clusters found (need at least ${minClusterSize} interconnected facts per cluster). Total linked facts: ${result.totalLinkedFacts}.`
              : `Found ${result.clusters.length} topic cluster(s) from ${result.totalLinkedFacts} linked facts (${result.isolatedFacts} below threshold):\n${summary}`;

          return {
            content: [{ type: "text", text }],
            details: {
              clusterCount: result.clusters.length,
              totalLinkedFacts: result.totalLinkedFacts,
              isolatedFacts: result.isolatedFacts,
              clusters: result.clusters.map((c) => ({
                id: c.id,
                label: c.label,
                factCount: c.factCount,
                factIds: c.factIds,
              })),
            },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "clusters",
            operation: "memory_clusters",
          });
          throw err;
        }
      },
    },
    { name: "memory_clusters" },
  );

  // memory_gaps
  api.registerTool(
    {
      name: "memory_gaps",
      label: "Memory Gaps",
      description:
        "Analyze the memory graph to surface knowledge gaps (orphans, weakly linked facts, suggested links).",
      parameters: Type.Object({
        mode: Type.Optional(
          Type.Union(
            [Type.Literal("orphans"), Type.Literal("weak"), Type.Literal("all")],
            { description: "Which gap types to return (default: all)." },
          ),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max items per category (default: 20).",
            minimum: 1,
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        if (!cfg.gaps.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "Knowledge gap analysis is disabled. Set gaps.enabled: true in plugin config.",
              },
            ],
            details: { error: "gaps_disabled" },
          };
        }

        const mode =
          params.mode === "orphans" || params.mode === "weak" || params.mode === "all"
            ? params.mode
            : "all";
        const limit =
          typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
            ? Math.min(200, Math.floor(params.limit))
            : 20;

        try {
          const report = await analyzeKnowledgeGaps(
            factsDb,
            vectorDb,
            embeddings,
            mode,
            limit,
            cfg.gaps.similarityThreshold,
          );

          const lines: string[] = [
            `Knowledge gaps (${mode})`,
            `  Orphans: ${report.orphans.length}`,
            `  Weak links: ${report.weak.length}`,
            `  Suggested links: ${report.suggestedLinks.length}`,
          ];

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: report,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "gaps",
            operation: "memory_gaps",
          });
          throw err;
        }
      },
    },
    { name: "memory_gaps" },
  );
}
