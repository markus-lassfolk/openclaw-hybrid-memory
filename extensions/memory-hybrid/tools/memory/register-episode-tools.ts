/**
 * Memory Tool Registrations
 *
 * Tool definitions for memory recall, storage, promotion, and deletion.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../utils/typebox.js";

import { buildEpisodeCausalChain } from "../../services/episode-causal-inference.js";
import { detectEpisodeFailureContradictions } from "../../backends/facts-db/contradictions.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { emitFeatureTelemetry } from "../../services/feature-telemetry.js";
import type { EpisodeOutcome } from "../../types/memory.js";
import { formatTimestampUtc } from "../../utils/dates.js";

import type { MemoryToolRuntime } from "./runtime.js";

export function registerEpisodeTools(runtime: MemoryToolRuntime): void {
  const { factsDb, cfg, currentAgentIdRef, buildToolScopeFilter, api } = runtime;
  // ---------------------------------------------------------------------------
  // Episodic Memory tools (#781)
  // ---------------------------------------------------------------------------

  /** memory_record_episode — store a structured event with explicit outcome. */
  {
    const _recordEpisodeParams = Type.Object({
      event: Type.String({ description: "What happened (e.g. 'deployed openclaw to production')." }),
      outcome: stringEnum(["success", "failure", "partial", "unknown"] as const, {
        description: "Outcome of the event.",
      }),
      timestamp: Type.Optional(
        Type.Number({ description: "Unix epoch seconds when the event occurred. Defaults to now." }),
      ),
      duration: Type.Optional(
        Type.Number({ description: "Duration in milliseconds (e.g. how long a deployment took)." }),
      ),
      context: Type.Optional(Type.String({ description: "Context: environment state, what led up to it, etc." })),
      relatedFactIds: Type.Optional(
        Type.Array(Type.String(), { description: "IDs of related memory facts to link to this episode." }),
      ),
      procedureId: Type.Optional(
        Type.String({ description: "ID of the procedure that triggered this episode, if any." }),
      ),
      importance: Type.Optional(
        Type.Number({ description: "Importance 0–1 (default 0.5). Failures are auto-boosted to ≥0.8." }),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Topic tags for filtering." })),
      scope: Type.Optional(
        stringEnum(["global", "user", "agent", "session"] as const, {
          description: "Memory scope. Default: global.",
        }),
      ),
      agentId: Type.Optional(Type.String()),
      userId: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
    });
    const _recordEpisodeDesc =
      "Record a structured episodic memory: a significant event with an explicit outcome (success/failure/partial/unknown), timestamp, and optional context. Use after deployments, migrations, incidents, or other notable events to build a queryable history of what happened and how it turned out.";
    const _execRecordEpisode = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const episodeStarted = Date.now();
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
        const recorded = factsDb.recordEpisodeWithCausalLinks({
          event: params.event as string,
          outcome: params.outcome as EpisodeOutcome,
          timestamp: params.timestamp as number | undefined,
          duration: params.duration as number | undefined,
          context: params.context as string | undefined,
          relatedFactIds: params.relatedFactIds as string[] | undefined,
          procedureId: params.procedureId as string | undefined,
          importance: params.importance as number | undefined,
          tags: params.tags as string[] | undefined,
          decayClass: "normal",
          scope: params.scope as "global" | "user" | "agent" | "session" | undefined,
          scopeTarget: scopeFilter?.sessionId ?? scopeFilter?.userId ?? scopeFilter?.agentId ?? null,
          agentId: (params.agentId as string | undefined) ?? scopeFilter?.agentId ?? undefined,
          userId: (params.userId as string | undefined) ?? scopeFilter?.userId ?? undefined,
          sessionId: (params.sessionId as string | undefined) ?? scopeFilter?.sessionId ?? undefined,
        });
        const episode = recorded.episode;

        const contradictions =
          params.outcome === "failure"
            ? detectEpisodeFailureContradictions(
                factsDb.getRawDb(),
                params.event as string,
                params.procedureId as string | undefined,
              )
            : [];

        emitFeatureTelemetry(api.logger, {
          feature: "episode_causal",
          operation: "memory_record_episode",
          durationMs: Date.now() - episodeStarted,
          warnBudgetMs: cfg.retrieval.episodeCausalLatencyWarnMs,
          outcome: "ok",
          fields: {
            inferred_links: recorded.causallyInferredLinks.length,
            contradiction_hits: contradictions.length,
            outcome: episode.outcome,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Episode recorded: [${episode.outcome}] "${episode.event}" at ${formatTimestampUtc(episode.timestamp)} (id: ${episode.id})`,
            },
          ],
          details: {
            episode,
            causally_inferred_links: recorded.causallyInferredLinks.map((l) => ({
              episode_id: l.episodeId,
              event_preview: l.eventPreview,
              outcome: l.outcome,
              score: l.score,
              confidence: l.confidence,
              score_breakdown: l.scoreBreakdown,
            })),
            ...(contradictions.length > 0 ? { contradictions } : {}),
          },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "record_episode",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_record_episode",
        description: _recordEpisodeDesc,
        parameters: _recordEpisodeParams,
        execute: _execRecordEpisode,
      },
      { name: "memory_record_episode" },
    );
  }

  /** memory_search_episodes — search structured episodic memories with filters. */
  {
    const _searchEpisodesParams = Type.Object({
      query: Type.Optional(Type.String({ description: "Full-text search over event and context fields." })),
      outcome: Type.Optional(Type.Array(stringEnum(["success", "failure", "partial", "unknown"] as const))),
      since: Type.Optional(Type.Number({ description: "Unix epoch seconds — only events after this time." })),
      until: Type.Optional(Type.Number({ description: "Unix epoch seconds — only events before this time." })),
      procedureId: Type.Optional(Type.String({ description: "Filter to episodes linked to a specific procedure." })),
      limit: Type.Optional(Type.Number({ description: "Max results to return (default 50, max 200)." })),
    });
    const _searchEpisodesDesc =
      "Search episodic memories — structured records of events with outcomes and timestamps. Filter by outcome (success/failure/partial/unknown), time range, or procedure. Returns events ordered by most recent first.";
    const _execSearchEpisodes = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
        const episodes = factsDb.searchEpisodes({
          query: params.query as string | undefined,
          outcome: params.outcome as EpisodeOutcome[] | undefined,
          since: params.since as number | undefined,
          until: params.until as number | undefined,
          procedureId: params.procedureId as string | undefined,
          limit: Math.min((params.limit as number | undefined) ?? 50, 200),
          scopeFilter,
        });

        if (episodes.length === 0) {
          return {
            content: [{ type: "text", text: "No episodes found matching the criteria." }],
            details: { found: 0, episodes: [] },
          };
        }

        const lines = episodes.map((e) => {
          const ts = new Date(e.timestamp * 1000).toLocaleString();
          const tagStr = e.tags.length > 0 ? ` #${e.tags.join(" #")}` : "";
          return `- [${e.outcome}] ${ts}: ${e.event}${tagStr} (id: ${e.id})`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Found ${episodes.length} episode(s):\n${lines.join("\n")}`,
            },
          ],
          details: { found: episodes.length, episodes },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "search_episodes",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_search_episodes",
        description: _searchEpisodesDesc,
        parameters: _searchEpisodesParams,
        execute: _execSearchEpisodes,
      },
      { name: "memory_search_episodes" },
    );
  }

  api.registerTool(
    {
      name: "memory_episode_causal_chain",
      description:
        "Walk inferred and explicit causal links from an episode to build an upstream causal chain (BFS, deduped by max confidence).",
      parameters: Type.Object({
        episodeId: Type.String({ description: "Starting episode id." }),
        depth: Type.Optional(Type.Number({ description: "Max traversal depth (default 5)." })),
        includeExplicitOnly: Type.Optional(
          Type.Boolean({ description: "When true, use only explicit memory_link/episode_relations links." }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const episodeId = typeof params.episodeId === "string" ? params.episodeId.trim() : "";
        if (!episodeId) throw new Error("episodeId is required");
        const depth = typeof params.depth === "number" && params.depth > 0 ? Math.min(10, Math.floor(params.depth)) : 5;
        const includeExplicitOnly = params.includeExplicitOnly === true;
        const chain = buildEpisodeCausalChain(factsDb.getRawDb(), episodeId, depth, includeExplicitOnly);
        return {
          content: [
            {
              type: "text",
              text:
                chain.length === 0
                  ? `No causal chain found for episode ${episodeId}.`
                  : chain
                      .map(
                        (c) =>
                          `- [d=${c.depth}] ${c.eventPreview} (${c.outcome}, ${c.linkType}, conf=${c.confidence.toFixed(2)})`,
                      )
                      .join("\n"),
            },
          ],
          details: { episodeId, depth, includeExplicitOnly, chain },
        };
      },
    },
    { name: "memory_episode_causal_chain" },
  );

  // ---------------------------------------------------------------------------
}
