import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import type OpenAI from "openai";

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "../services/embeddings.js";
import type { HybridMemoryConfig } from "../config.js";
import type { WriteAheadLog } from "../backends/wal.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface PluginContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  wal: WriteAheadLog | null;
  resolvedSqlitePath: string;
}

// Helper function types (exported for register-tools ToolsContext)
export type RunReflectionFn = (
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  config: { defaultWindow: number; minObservations: number; enabled?: boolean },
  opts: { window: number; dryRun: boolean; model: string; fallbackModels?: string[]; geminiApiKey?: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
) => Promise<{ factsAnalyzed: number; patternsExtracted: number; patternsStored: number; window: number }>;

export type RunReflectionRulesFn = (
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string; fallbackModels?: string[]; geminiApiKey?: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
) => Promise<{ rulesExtracted: number; rulesStored: number }>;

export type RunReflectionMetaFn = (
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string; fallbackModels?: string[]; geminiApiKey?: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
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
  const { factsDb, vectorDb, embeddings, openai, cfg } = ctx;

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

        if (mode === "hard" || mode === "both") {
          hardPruned = factsDb.pruneExpired();
        }
        if (mode === "soft" || mode === "both") {
          softPruned = factsDb.decayConfidence();
        }

        const breakdown = factsDb.statsBreakdown();
        const expired = factsDb.countExpired();

        return {
          content: [
            {
              type: "text",
              text: `Pruned: ${hardPruned} expired + ${softPruned} low-confidence.\nRemaining by class: ${JSON.stringify(breakdown)}\nPending expired: ${expired}`,
            },
          ],
          details: { hardPruned, softPruned, breakdown, pendingExpired: expired },
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
        try {
          const result = await runReflection(
            factsDb,
            vectorDb,
            embeddings,
            openai,
            { defaultWindow: reflectionCfg.defaultWindow, minObservations: reflectionCfg.minObservations },
            { window, dryRun: false, model: reflectionCfg.model, fallbackModels: cfg.distill?.fallbackModels, geminiApiKey: cfg.distill?.apiKey },
            api.logger,
          );
          return {
            content: [
              {
                type: "text",
                text: `Reflection complete: ${result.factsAnalyzed} facts analyzed, ${result.patternsExtracted} patterns extracted, ${result.patternsStored} stored (window: ${result.window} days).`,
              },
            ],
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
        try {
          const result = await runReflectionRules(
            factsDb,
            vectorDb,
            embeddings,
            openai,
            { dryRun: false, model: reflectionCfg.model, fallbackModels: cfg.distill?.fallbackModels, geminiApiKey: cfg.distill?.apiKey },
            api.logger,
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
        try {
          const result = await runReflectionMeta(
            factsDb,
            vectorDb,
            embeddings,
            openai,
            { dryRun: false, model: reflectionCfg.model, fallbackModels: cfg.distill?.fallbackModels, geminiApiKey: cfg.distill?.apiKey },
            api.logger,
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
}
