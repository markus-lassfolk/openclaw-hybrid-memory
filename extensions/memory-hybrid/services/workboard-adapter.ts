/**
 * Workboard Adapter — bidirectional sync between hybrid-memory active tasks/goals
 * and OpenClaw's Workboard Kanban UI.
 *
 * Push: reads active tasks + goals from hybrid-memory, upserts corresponding Workboard cards.
 * Pull: reads Workboard cards tagged with our cardTag, applies column changes back to tasks/goals.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { WorkboardConfig } from "../config/types/workboard.js";
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
  createWorkboardHttpRpcClient,
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
  const client = createWorkboardHttpRpcClient(ctx.cfg.gatewayUrl, ctx.gatewayToken);
  let syncInFlight = false;

  return {
    async sync(): Promise<WorkboardSyncResult> {
      if (syncInFlight) {
        return {
          cardsCreated: 0,
          cardsUpdated: 0,
          cardsRemoved: 0,
          pullChanges: 0,
          errors: ["sync already in progress"],
        };
      }

      syncInFlight = true;
      const result: WorkboardSyncResult = {
        cardsCreated: 0,
        cardsUpdated: 0,
        cardsRemoved: 0,
        pullChanges: 0,
        errors: [],
      };

      try {
        const existingCards = await client.listCards({ tag: ctx.cfg.cardTag });
        const cardsByExternalId = new Map<string, WorkboardRpcCard>();
        for (const card of existingCards) {
          if (card.externalId && isHybridMemoryCard(card)) {
            cardsByExternalId.set(card.externalId, card);
          }
        }

        // Pull Workboard column moves before push so user edits are not overwritten.
        if (ctx.cfg.bidirectional) {
          await pullChanges(client, ctx, cardsByExternalId, result);
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
            await upsertCard(client, card, cardsByExternalId, result);
          }
        }

        // Push goals
        if (ctx.cfg.syncGoals) {
          const goals = await ctx.loadGoals();
          for (const goal of goals) {
            const card = goalToCard(goal, ctx.cfg.columns, ctx.cfg.cardTag);
            if (!card) continue;
            desiredExternalIds.add(card.externalId);
            await upsertCard(client, card, cardsByExternalId, result);
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
          if (deleted) result.cardsRemoved++;
        }
      } catch (err) {
        const msg = `Workboard sync failed: ${err instanceof Error ? err.message : String(err)}`;
        pluginLogger.warn(`memory-hybrid: ${msg}`);
        result.errors.push(msg);
      } finally {
        syncInFlight = false;
      }

      if (result.cardsCreated + result.cardsUpdated + result.cardsRemoved + result.pullChanges > 0) {
        pluginLogger.info(
          `memory-hybrid: workboard sync — created=${result.cardsCreated} updated=${result.cardsUpdated} removed=${result.cardsRemoved} pulled=${result.pullChanges}`,
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
      } else {
        result.errors.push(`Failed to update card ${existingCard.id} (${payload.externalId})`);
      }
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
    } else {
      result.errors.push(`Failed to create card for ${payload.externalId}`);
    }
  }
}

async function pullChanges(
  client: WorkboardRpcClient,
  ctx: WorkboardAdapterContext,
  cardsByExternalId: Map<string, WorkboardRpcCard>,
  result: WorkboardSyncResult,
): Promise<void> {
  const { active: activeTasks, completed: completedTasks } = ctx.loadTasks();
  const taskByLabel = new Map([...activeTasks, ...completedTasks].map((t) => [t.label, t]));
  const goals = await ctx.loadGoals();
  const goalById = new Map(goals.map((g) => [g.id, g]));

  for (const [extId, card] of cardsByExternalId) {
    const parsed = parseExternalId(extId);
    if (!parsed) continue;

    if (parsed.type === "task" && ctx.updateTaskStatus) {
      const task = taskByLabel.get(parsed.label);
      if (!task) continue;

      const expectedColumn = taskToCard(task, ctx.cfg.columns, ctx.cfg.cardTag)?.column;
      if (expectedColumn && card.column !== expectedColumn) {
        const newStatus = columnToTaskStatus(card.column, ctx.cfg.columns);
        if (newStatus && newStatus !== task.status) {
          try {
            await ctx.updateTaskStatus(parsed.label, newStatus);
            result.pullChanges++;
            pluginLogger.info(
              `memory-hybrid: workboard pull — task "${parsed.label}" status changed to "${newStatus}" from column "${card.column}"`,
            );
          } catch (err) {
            result.errors.push(
              `Failed to update task ${parsed.label}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    if (parsed.type === "goal" && ctx.updateGoalStatus) {
      const goal = goalById.get(parsed.goalId);
      if (!goal) continue;

      const expectedColumn = goalToCard(goal, ctx.cfg.columns, ctx.cfg.cardTag)?.column;
      if (expectedColumn && card.column !== expectedColumn) {
        const newStatus = columnToGoalStatus(card.column, ctx.cfg.columns);
        if (newStatus && newStatus !== goal.status) {
          try {
            await ctx.updateGoalStatus(parsed.goalId, newStatus);
            result.pullChanges++;
            pluginLogger.info(
              `memory-hybrid: workboard pull — goal "${goal.label}" status changed to "${newStatus}" from column "${card.column}"`,
            );
          } catch (err) {
            result.errors.push(
              `Failed to update goal ${parsed.goalId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  }
}
