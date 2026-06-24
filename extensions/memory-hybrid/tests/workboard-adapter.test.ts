import { describe, expect, it, vi } from "vitest";
import { createWorkboardAdapter } from "../services/workboard-adapter.js";
import type { TaskStatusUpdater } from "../services/workboard-adapter.js";
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

    vi.spyOn(await import("../services/workboard-rpc-client.js"), "createWorkboardRpcClient").mockReturnValue(client);

    const adapter = createWorkboardAdapter({
      cfg: {
        enabled: true,
        gatewayUrl: "http://localhost:18789",
        cardTag: "hybrid-memory",
        syncTasks: false,
        syncGoals: true,
        bidirectional: false,
        syncIntervalMinutes: 5,
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

    vi.spyOn(await import("../services/workboard-rpc-client.js"), "createWorkboardRpcClient").mockReturnValue(client);

    const adapter = createWorkboardAdapter({
      cfg: {
        enabled: true,
        gatewayUrl: "http://localhost:18789",
        cardTag: "hybrid-memory",
        syncTasks: true,
        syncGoals: false,
        bidirectional: false,
        syncIntervalMinutes: 5,
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

    vi.spyOn(await import("../services/workboard-rpc-client.js"), "createWorkboardRpcClient").mockReturnValue(client);

    const adapter = createWorkboardAdapter({
      cfg: {
        enabled: true,
        gatewayUrl: "http://localhost:18789",
        cardTag: "hybrid-memory",
        syncTasks: true,
        syncGoals: false,
        bidirectional: false,
        syncIntervalMinutes: 5,
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

describe("workboard adapter bidirectional sync", () => {
  it("pulls Workboard column changes before pushing card updates", async () => {
    let taskStatus: "In progress" | "Done" = "In progress";
    const task = {
      label: "my-task",
      description: "Do work",
      get status() {
        return taskStatus;
      },
      started: "2026-06-01T00:00:00Z",
      updated: "2026-06-05T00:00:00Z",
    };
    const taskCard: WorkboardRpcCard = {
      id: "card-task-1",
      title: "[Task] my-task",
      column: "Done",
      description: "Do work",
      externalId: taskExternalId("my-task"),
      tags: ["hybrid-memory"],
    };

    const updateTaskStatus = vi.fn(async (_label: string, newStatus: "In progress" | "Done") => {
      taskStatus = newStatus;
    });
    const client = {
      listCards: vi.fn(async () => [taskCard]),
      createCard: vi.fn(async () => null),
      updateCard: vi.fn(async () => taskCard),
      deleteCard: vi.fn(async () => false),
      findByExternalId: vi.fn(async () => null),
      isAvailable: vi.fn(async () => true),
    } as WorkboardRpcClient;

    vi.spyOn(await import("../services/workboard-rpc-client.js"), "createWorkboardRpcClient").mockReturnValue(client);

    const adapter = createWorkboardAdapter({
      cfg: {
        enabled: true,
        gatewayUrl: "http://localhost:18789",
        cardTag: "hybrid-memory",
        syncTasks: true,
        syncGoals: false,
        bidirectional: true,
        syncIntervalMinutes: 5,
        columns: DEFAULT_WORKBOARD_COLUMNS,
      },
      loadTasks: () => ({ active: [task], completed: [] }),
      loadGoals: () => [],
      updateTaskStatus: updateTaskStatus as TaskStatusUpdater,
    });

    const result = await adapter.sync();

    expect(updateTaskStatus).toHaveBeenCalledWith("my-task", "Done");
    expect(result.pullChanges).toBe(1);
    expect(client.updateCard).not.toHaveBeenCalled();
  });
});
