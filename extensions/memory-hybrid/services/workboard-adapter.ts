/**
 * Workboard Adapter — bidirectional sync between hybrid-memory active tasks/goals
 * and OpenClaw's Workboard Kanban UI.
 *
 * Push: reads active tasks + goals from hybrid-memory, upserts corresponding Workboard cards.
 * Pull: reads Workboard cards tagged with our cardTag, applies column changes back to tasks/goals.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { WorkboardConfig } from "../config/types/workboard.js";
import { traceIntegration } from "../utils/integration-trace.js";
import { pluginLogger } from "../utils/logger.js";
import type { ActiveTaskEntry } from "./active-task.js";
import type { Goal } from "./goal-stewardship-types.js";
import {
  type WorkboardCardPayload,
  columnToGoalStatus,
  columnToTaskStatus,
  goalExternalId,
  goalToCard,
  isHybridMemoryCard,
  parseExternalId,
  taskExternalId,
  taskToCard,
} from "./workboard-card-mapper.js";
import {
  type WorkboardRpcCard,
  type WorkboardRpcClient,
  createWorkboardRpcClient,
} from "./workboard-rpc-client.js";

export type TaskLoader = () => { active: ActiveTaskEntry[]; completed: ActiveTaskEntry[] };
export type GoalLoader = () => Goal[] | Promise<Goal[]>;
export type TaskStatusUpdater = (label: string, newStatus: string) => void | Promise<void>;
export type GoalStatusUpdater = (goalId: string, newStatus: string) => void | Promise<void>;

export interface WorkboardAdapterContext {
  cfg: WorkboardConfig;
  loadTasks: TaskLoader;
  loadGoals: GoalLoader;
  updateTaskStatus?: TaskStatusUpdater;
  updateGoalStatus?: GoalStatusUpdater;
  gatewayToken?: string;
  /** When true, emit per-card push/pull trace lines (hybrid-memory verbosity=verbose). */
  verbose?: boolean;
}

export interface WorkboardAdapter {
  sync(): Promise<WorkboardSyncResult>;
  isAvailable(): Promise<boolean>;
}

export type WorkboardSyncResult = {
  cardsCreated: number;
  cardsUpdated: number;
  cardsRemoved: number;
  pullChanges: number;
  errors: string[];
};

export function createWorkboardAdapter(ctx: WorkboardAdapterContext): WorkboardAdapter {
  const client = createWorkboardRpcClient(ctx.cfg.gatewayUrl, ctx.gatewayToken);
  let syncInFlight = false;

  return {
    async sync(): Promise<WorkboardSyncResult> {
      const verbose = ctx.verbose ?? false;
      if (syncInFlight) {
        traceIntegration(verbose, "workboard sync skipped — already in progress");
        return {
          cardsCreated: 0,
          cardsUpdated: 0,
          cardsRemoved: 0,
          pullChanges: 0,
          errors: ["sync already in progress"],
        };
      }

      const syncRunId = Date.now().toString(36);
      syncInFlight = true;
      const result: WorkboardSyncResult = {
        cardsCreated: 0,
        cardsUpdated: 0,
        cardsRemoved: 0,
        pullChanges: 0,
        errors: [],
      };

      try {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] start — bidirectional=${ctx.cfg.bidirectional} syncTasks=${ctx.cfg.syncTasks} syncGoals=${ctx.cfg.syncGoals}`,
        );

        const existingCards = await client.listCards({ tag: ctx.cfg.cardTag });
        const cardsByExternalId = new Map<string, WorkboardRpcCard>();
        for (const card of existingCards) {
          if (card.externalId && isHybridMemoryCard(card)) {
            cardsByExternalId.set(card.externalId, card);
          }
        }
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] listed ${existingCards.length} card(s), ${cardsByExternalId.size} hybrid-memory tagged`,
        );

        // Pull Workboard column moves before push so user edits are not overwritten.
        if (ctx.cfg.bidirectional) {
          await pullChanges(client, ctx, cardsByExternalId, result, syncRunId, verbose);
        } else {
          traceIntegration(verbose, `workboard sync [${syncRunId}] pull skipped — bidirectional=false`);
        }

        const desiredExternalIds = new Set<string>();

        // Push tasks
        if (ctx.cfg.syncTasks) {
          const { active, completed } = ctx.loadTasks();
          const allTasks = [...active, ...completed];
          for (const task of allTasks) {
            const card = taskToCard(task, ctx.cfg.columns, ctx.cfg.cardTag);
            if (!card) continue;
            desiredExternalIds.add(card.externalId);
            await upsertCard(client, card, cardsByExternalId, result, syncRunId, verbose);
          }
        }

        // Push goals
        if (ctx.cfg.syncGoals) {
          const goals = await ctx.loadGoals();
          for (const goal of goals) {
            const card = goalToCard(goal, ctx.cfg.columns, ctx.cfg.cardTag);
            if (!card) continue;
            desiredExternalIds.add(card.externalId);
            await upsertCard(client, card, cardsByExternalId, result, syncRunId, verbose);
          }
        }

        // Remove stale cards only for sync dimensions enabled this run
        for (const [extId, card] of cardsByExternalId) {
          if (desiredExternalIds.has(extId)) continue;
          const parsed = parseExternalId(extId);
          if (!parsed) continue;
          if (parsed.type === "task" && !ctx.cfg.syncTasks) continue;
          if (parsed.type === "goal" && !ctx.cfg.syncGoals) continue;
          const deleted = await client.deleteCard(card.id);
          if (deleted) {
            result.cardsRemoved++;
            traceIntegration(verbose, `workboard sync [${syncRunId}] push delete ${extId} (card ${card.id})`);
          } else {
            const msg = `Failed to delete stale card ${card.id} (${extId})`;
            result.errors.push(msg);
            pluginLogger.warn(`memory-hybrid: ${msg}`);
          }
        }
      } catch (err) {
        const msg = `Workboard sync failed: ${err instanceof Error ? err.message : String(err)}`;
        pluginLogger.warn(`memory-hybrid: workboard sync [${syncRunId}] ${msg}`);
        result.errors.push(msg);
      } finally {
        syncInFlight = false;
      }

      if (
        verbose ||
        result.cardsCreated + result.cardsUpdated + result.cardsRemoved + result.pullChanges > 0 ||
        result.errors.length > 0
      ) {
        pluginLogger.info(
          `memory-hybrid: workboard sync [${syncRunId}] — created=${result.cardsCreated} updated=${result.cardsUpdated} removed=${result.cardsRemoved} pulled=${result.pullChanges} errors=${result.errors.length}`,
        );
      }

      return result;
    },

    async isAvailable() {
      return client.isAvailable();
    },
  };
}

async function upsertCard(
  client: WorkboardRpcClient,
  payload: WorkboardCardPayload,
  existing: Map<string, WorkboardRpcCard>,
  result: WorkboardSyncResult,
  syncRunId: string,
  verbose: boolean,
): Promise<void> {
  const existingCard = existing.get(payload.externalId);

  if (existingCard) {
    const needsUpdate =
      existingCard.column !== payload.column ||
      existingCard.title !== payload.title ||
      existingCard.description !== payload.description;

    if (needsUpdate) {
      const updated = await client.updateCard(existingCard.id, {
        title: payload.title,
        column: payload.column,
        description: payload.description,
        tags: payload.tags,
        metadata: payload.metadata,
      });
      if (updated) {
        result.cardsUpdated++;
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] push update ${payload.externalId} → column "${payload.column}"`,
        );
      } else {
        const msg = `Failed to update card ${existingCard.id} (${payload.externalId})`;
        result.errors.push(msg);
        pluginLogger.warn(`memory-hybrid: ${msg}`);
      }
    } else {
      traceIntegration(verbose, `workboard sync [${syncRunId}] push noop ${payload.externalId} (already in sync)`);
    }
  } else {
    const created = await client.createCard({
      title: payload.title,
      column: payload.column,
      description: payload.description,
      tags: payload.tags,
      externalId: payload.externalId,
      metadata: payload.metadata,
    });
    if (created) {
      result.cardsCreated++;
      traceIntegration(
        verbose,
        `workboard sync [${syncRunId}] push create ${payload.externalId} → column "${payload.column}"`,
      );
    } else {
      const msg = `Failed to create card for ${payload.externalId}`;
      result.errors.push(msg);
      pluginLogger.warn(`memory-hybrid: ${msg}`);
    }
  }
}

async function pullChanges(
  _client: WorkboardRpcClient,
  ctx: WorkboardAdapterContext,
  cardsByExternalId: Map<string, WorkboardRpcCard>,
  result: WorkboardSyncResult,
  syncRunId: string,
  verbose: boolean,
): Promise<void> {
  const { active: activeTasks, completed: completedTasks } = ctx.loadTasks();
  const taskByLabel = new Map([...activeTasks, ...completedTasks].map((t) => [t.label, t]));
  const goals = await ctx.loadGoals();
  const goalById = new Map(goals.map((g) => [g.id, g]));

  for (const [extId, card] of cardsByExternalId) {
    const parsed = parseExternalId(extId);
    if (!parsed) continue;

    if (parsed.type === "task") {
      if (!ctx.updateTaskStatus) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull skip task ${extId} — no updateTaskStatus handler`,
        );
        continue;
      }
      const task = taskByLabel.get(parsed.label);
      if (!task) {
        traceIntegration(verbose, `workboard sync [${syncRunId}] pull skip task ${extId} — task not in ledger`);
        continue;
      }

      const expectedColumn = taskToCard(task, ctx.cfg.columns, ctx.cfg.cardTag)?.column;
      if (!expectedColumn) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull skip task ${extId} — unmapped status "${task.status}"`,
        );
        continue;
      }
      if (card.column === expectedColumn) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull noop task ${extId} — column "${card.column}" matches memory`,
        );
        continue;
      }

      const newStatus = columnToTaskStatus(card.column, ctx.cfg.columns);
      if (!newStatus) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull skip task ${extId} — unknown column "${card.column}"`,
        );
        continue;
      }
      if (newStatus === task.status) continue;

      try {
        await ctx.updateTaskStatus(parsed.label, newStatus);
        result.pullChanges++;
        pluginLogger.info(
          `memory-hybrid: workboard pull [${syncRunId}] — task "${parsed.label}" ${task.status} → "${newStatus}" (column "${card.column}")`,
        );
      } catch (err) {
        const msg = `Failed to update task ${parsed.label}: ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(msg);
        pluginLogger.warn(`memory-hybrid: ${msg}`);
      }
    }

    if (parsed.type === "goal") {
      if (!ctx.updateGoalStatus) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull skip goal ${extId} — no updateGoalStatus handler`,
        );
        continue;
      }
      const goal = goalById.get(parsed.goalId);
      if (!goal) {
        traceIntegration(verbose, `workboard sync [${syncRunId}] pull skip goal ${extId} — goal not found`);
        continue;
      }

      const expectedColumn = goalToCard(goal, ctx.cfg.columns, ctx.cfg.cardTag)?.column;
      if (!expectedColumn) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull skip goal ${extId} — unmapped status "${goal.status}"`,
        );
        continue;
      }
      if (card.column === expectedColumn) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull noop goal ${extId} — column "${card.column}" matches memory`,
        );
        continue;
      }

      const newStatus = columnToGoalStatus(card.column, ctx.cfg.columns);
      if (!newStatus) {
        traceIntegration(
          verbose,
          `workboard sync [${syncRunId}] pull skip goal ${extId} — unknown column "${card.column}"`,
        );
        continue;
      }
      if (newStatus === goal.status) continue;

      try {
        await ctx.updateGoalStatus(parsed.goalId, newStatus);
        result.pullChanges++;
        pluginLogger.info(
          `memory-hybrid: workboard pull [${syncRunId}] — goal "${goal.label}" ${goal.status} → "${newStatus}" (column "${card.column}")`,
        );
      } catch (err) {
        const msg = `Failed to update goal ${parsed.goalId}: ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(msg);
        pluginLogger.warn(`memory-hybrid: ${msg}`);
      }
    }
  }
}
