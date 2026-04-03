/**
 * Re-run a lightweight recall pipeline after OpenClaw context compaction (#957).
 * Uses the last user prompt captured during before_agent_start auto-recall.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { LifecycleContext } from "../lifecycle/types.js";
import type { ScopeFilter } from "../types/memory.js";
import { runRecallPipelineQuery, type RecallPipelineDeps } from "./recall-pipeline.js";
import { DEFAULT_INTERACTIVE_RECALL_POLICY } from "./retrieval-mode-policy.js";
import { capturePluginError } from "./error-reporter.js";
import { withTimeout } from "../utils/timeout.js";

const POST_COMPACTION_RECALL_TIMEOUT_MS = 22_000;

function buildScopeFilter(ctx: LifecycleContext): ScopeFilter | undefined {
  const { currentAgentIdRef } = ctx;
  if (currentAgentIdRef.value && currentAgentIdRef.value !== ctx.cfg.multiAgent.orchestratorId) {
    return {
      userId: ctx.cfg.autoRecall.scopeFilter?.userId ?? null,
      agentId: currentAgentIdRef.value,
      sessionId: ctx.cfg.autoRecall.scopeFilter?.sessionId ?? null,
    };
  }
  if (
    ctx.cfg.autoRecall.scopeFilter &&
    (ctx.cfg.autoRecall.scopeFilter.userId ||
      ctx.cfg.autoRecall.scopeFilter.agentId ||
      ctx.cfg.autoRecall.scopeFilter.sessionId)
  ) {
    return {
      userId: ctx.cfg.autoRecall.scopeFilter.userId ?? null,
      agentId: ctx.cfg.autoRecall.scopeFilter.agentId ?? null,
      sessionId: ctx.cfg.autoRecall.scopeFilter.sessionId ?? null,
    };
  }
  return undefined;
}

/**
 * Returns a `<recalled-context>` block for prependContext after compaction, or null if skipped/failed.
 */
export async function buildPostCompactionRecallSnippet(
  ctx: LifecycleContext,
  api: ClawdbotPluginApi,
  prompt: string,
): Promise<string | null> {
  const trimmed = prompt.trim();
  if (trimmed.length < 5) return null;

  return withTimeout(
    POST_COMPACTION_RECALL_TIMEOUT_MS,
    async () => {
      const scopeFilter = buildScopeFilter(ctx);
      const tierFilter: "warm" | "all" = ctx.cfg.memoryTiering.enabled ? "warm" : "all";
      const recallOpts = {
        tierFilter,
        scopeFilter,
        reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
        diversityWeight: ctx.cfg.reinforcement?.diversityWeight ?? 1.0,
        interactiveFtsFastPath: true,
      };
      const limit = Math.min(ctx.cfg.autoRecall.limit ?? 10, 15);
      const minScore = ctx.cfg.autoRecall.minScore ?? 0.3;
      const hydeUsedRef = { value: false };
      const pipelineDeps: RecallPipelineDeps = {
        factsDb: ctx.factsDb,
        vectorDb: ctx.vectorDb,
        embeddings: ctx.embeddings,
        openai: ctx.openai,
        cfg: {
          queryExpansion: ctx.cfg.queryExpansion,
          retrievalStrategies: ctx.cfg.retrieval.strategies,
          memoryTieringEnabled: ctx.cfg.memoryTiering.enabled,
          recallTiming: ctx.cfg.autoRecall.recallTiming,
          rawCfg: ctx.cfg,
        },
        recallOpts,
        minScore,
        pendingLLMWarnings: ctx.pendingLLMWarnings,
        logger: api.logger,
      };

      let candidates;
      try {
        candidates = await runRecallPipelineQuery(trimmed, limit, pipelineDeps, hydeUsedRef, {
          errorPrefix: "post-compaction-",
          policy: DEFAULT_INTERACTIVE_RECALL_POLICY,
          timingSpan: "post-compaction",
          timingOp: "post-compaction-recall",
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "auto-recall",
          operation: "post-compaction-recall",
        });
        return null;
      }

      if (candidates.length === 0) return null;

      const lines = candidates.slice(0, limit).map((r) => {
        const text = (r.entry.summary || r.entry.text).replace(/\s+/g, " ").trim();
        const preview = text.length > 220 ? `${text.slice(0, 220)}…` : text;
        return `- [${r.entry.category}] ${preview}`;
      });

      return [
        "<!-- memory-hybrid: post-compaction recall (re-matched to last user prompt; issue #957) -->",
        "<recalled-context>",
        "Recalled after context compaction (same query as your last turn):",
        ...lines,
        "</recalled-context>",
      ].join("\n");
    },
    null,
  );
}
