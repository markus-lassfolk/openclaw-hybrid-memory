import { describe, expect, it, vi } from "vitest";
import { createWorkboardAdapter } from "../services/workboard-adapter.js";
import type { WorkboardRpcCard, WorkboardRpcClient } from "../services/workboard-rpc-client.js";
import { goalExternalId, taskExternalId } from "../services/workboard-card-mapper.js";
import { DEFAULT_WORKBOARD_COLUMNS } from "../config/types/workboard.js";

function mockClient(cards: WorkboardRpcCard[]): WorkboardRpcClient {
  const deleted: string[] = [];
  return {
    listCards: vi.fn(async () => cards),
    createCard: vi.fn(async () => null),
    updateCard: vi.fn(async () => null),
    deleteCard: vi.fn(async (id: string) => {
      deleted.push(id);
      return true;
    }),
    findByExternalId: vi.fn(async () => null),
    isAvailable: vi.fn(async () => true),
    _deleted: deleted,
  } as WorkboardRpcClient & { _deleted: string[] };
}

describe("workboard adapter stale card removal", () => {
  it("does not delete task cards when syncTasks is disabled", async () => {
    const taskCard: WorkboardRpcCard = {
      id: "card-task-1",
      title: "[Task] old-task",
      column: "todo",
      externalId: taskExternalId("old-task"),
      tags: ["hybrid-memory"],
    };
    const client = mockClient([taskCard]);

    vi.spyOn(await import("../services/workboard-rpc-client.js"), "createWorkboardHttpRpcClient").mockReturnValue(
      client,
    );

    const adapter = createWorkboardAdapter({
      cfg: {
        enabled: true,
        gatewayUrl: "http://localhost:18789",
        cardTag: "hybrid-memory",
        syncTasks: false,
        syncGoals: true,
        bidirectional: false,
        columns: DEFAULT_WORKBOARD_COLUMNS,
      },
      loadTasks: () => ({ active: [], completed: [] }),
      loadGoals: () => [],
    });

    const result = await adapter.sync();
    expect(result.cardsRemoved).toBe(0);
    expect(client.deleteCard).not.toHaveBeenCalled();
  });

  it("removes stale task cards when syncTasks is enabled", async () => {
    const taskCard: WorkboardRpcCard = {
      id: "card-task-1",
      title: "[Task] old-task",
      column: "todo",
      externalId: taskExternalId("old-task"),
      tags: ["hybrid-memory"],
    };
    const client = mockClient([taskCard]);

    vi.spyOn(await import("../services/workboard-rpc-client.js"), "createWorkboardHttpRpcClient").mockReturnValue(
      client,
    );

    const adapter = createWorkboardAdapter({
      cfg: {
        enabled: true,
        gatewayUrl: "http://localhost:18789",
        cardTag: "hybrid-memory",
        syncTasks: true,
        syncGoals: false,
        bidirectional: false,
        columns: DEFAULT_WORKBOARD_COLUMNS,
      },
      loadTasks: () => ({ active: [], completed: [] }),
      loadGoals: () => [],
    });

    const result = await adapter.sync();
    expect(result.cardsRemoved).toBe(1);
    expect(client.deleteCard).toHaveBeenCalledWith("card-task-1");
  });

  it("does not delete goal cards when syncGoals is disabled", async () => {
    const goalCard: WorkboardRpcCard = {
      id: "card-goal-1",
      title: "[Goal] ship-it",
      column: "todo",
      externalId: goalExternalId("goal-1"),
      tags: ["hybrid-memory"],
    };
    const client = mockClient([goalCard]);

    vi.spyOn(await import("../services/workboard-rpc-client.js"), "createWorkboardHttpRpcClient").mockReturnValue(
      client,
    );

    const adapter = createWorkboardAdapter({
      cfg: {
        enabled: true,
        gatewayUrl: "http://localhost:18789",
        cardTag: "hybrid-memory",
        syncTasks: true,
        syncGoals: false,
        bidirectional: false,
        columns: DEFAULT_WORKBOARD_COLUMNS,
      },
      loadTasks: () => ({ active: [], completed: [] }),
      loadGoals: () => [],
    });

    const result = await adapter.sync();
    expect(result.cardsRemoved).toBe(0);
    expect(client.deleteCard).not.toHaveBeenCalled();
  });
});
