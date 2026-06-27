/**
 * Memory Tool Registrations
 *
 * Tool definitions for memory recall, storage, promotion, and deletion.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import { capturePluginError } from "../../services/error-reporter.js";
import { guardAgainstWrapperArgsDropped } from "../../services/tool-args-guard.js";
import { runActiveTaskCheckpoint } from "../../services/active-task-checkpoint.js";
import type { MemoryToolRuntime } from "./runtime.js";

export function registerCheckpointTools(runtime: MemoryToolRuntime): void {
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

  // ---------------------------------------------------------------------------
  // Active-task checkpoint tool (#1270)
  // ---------------------------------------------------------------------------

  {
    const _activeTaskCheckpointParams = Type.Object({
      entity: Type.String({ description: "Stable task entity/label (category:project row key)." }),
      status: Type.Optional(
        Type.String({
          description:
            "Task status: open|in_progress|blocked|waiting|done|completed|closed|cancelled|abandoned|failed.",
        }),
      ),
      owner: Type.Optional(Type.String({ description: "Task owner (free-form, e.g. subagent/session/role)." })),
      next: Type.Optional(Type.String({ description: "Next concrete action for safe resume." })),
      relatedSession: Type.Optional(Type.String({ description: "Related OpenClaw session key/id." })),
      relatedGoal: Type.Optional(
        Type.String({ description: "Registered goal id to link (writes project fact related_goal for goal_assess guard)." }),
      ),
      title: Type.Optional(
        Type.String({ description: "Human-readable task title (defaults to existing or Project task)." }),
      ),
      resumeAt: Type.Optional(
        Type.String({
          description: "Optional future ISO timestamp for wake/reminder scheduling via cron jobs store.",
        }),
      ),
      state: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Structured checkpoint state object (serialized into facts + episode context).",
        }),
      ),
      scheduleWake: Type.Optional(
        Type.Boolean({ description: "When true (default), schedule wake job when resumeAt is supplied." }),
      ),
      refreshProjection: Type.Optional(
        Type.Boolean({
          description:
            "When true, refresh ACTIVE-TASKS.md from facts. Default true when activeTask.ledger=facts; pass false to skip.",
        }),
      ),
      recordEpisode: Type.Optional(
        Type.Boolean({ description: "When true (default), record an episode audit trail for the checkpoint." }),
      ),
    });
    const _activeTaskCheckpointDesc =
      "Best-effort checkpoint active task state for reliable resume. One call updates project facts (status/next/owner/related_session/related_goal/task_updated/title), records an episode audit trail, optionally schedules wake/reminder from resumeAt, and refreshes ACTIVE-TASKS.md when ledger=facts (default) unless refreshProjection:false. Returns structured partial-failure details when later steps fail.";
    const _execActiveTaskCheckpoint = async (_toolCallId: string, params: Record<string, unknown>) => {
      const dropped = guardAgainstWrapperArgsDropped("active_task_checkpoint", params, api.logger);
      if (dropped) return dropped;
      const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
      try {
        const result = await runActiveTaskCheckpoint(
          {
            factsDb,
            vectorDb,
            embeddings,
            cfg,
            logger: api.logger,
            episodeScopeFilter: scopeFilter,
          },
          params as {
            entity?: string;
            status?: string;
            owner?: string;
            next?: string;
            relatedSession?: string;
            relatedGoal?: string;
            title?: string;
            resumeAt?: string;
            state?: Record<string, unknown>;
            scheduleWake?: boolean;
            refreshProjection?: boolean;
            recordEpisode?: boolean;
          },
        );

        return {
          content: [{ type: "text", text: result.message }],
          details: result,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "active_task_checkpoint",
          phase: "runtime",
        });
        return {
          content: [{ type: "text", text: `active_task_checkpoint failed: ${String(err)}` }],
          details: {
            ok: false,
            partial: false,
            error: String(err),
          },
        };
      }
    };
    api.registerTool(
      {
        name: "active_task_checkpoint",
        description: _activeTaskCheckpointDesc,
        parameters: _activeTaskCheckpointParams,
        execute: _execActiveTaskCheckpoint,
      },
      { name: "active_task_checkpoint" },
    );
  }
}
