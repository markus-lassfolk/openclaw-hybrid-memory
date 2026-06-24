import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("../utils/process-runner.js", () => ({
  spawn: spawnMock,
}));

import {
  createWorkboardGatewayCliRpcClient,
  createWorkboardHttpRpcClient,
  createWorkboardRpcClient,
  normalizeWorkboardApiCard,
} from "../services/workboard-rpc-client.js";

function mockSpawnSuccess(stdout: unknown) {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      child.stdout.emit("data", JSON.stringify(stdout));
      child.emit("close", 0);
    });
    return child;
  });
}

describe("workboard-rpc-client (#1925)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it("createWorkboardRpcClient falls back to gateway CLI when HTTP /rpc returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404 }) as Response,
    );
    mockSpawnSuccess({ cards: [{ id: "c1", title: "Task", status: "todo" }] });

    const client = createWorkboardRpcClient("http://127.0.0.1:18789");
    expect(await client.isAvailable()).toBe(true);
    const cards = await client.listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("c1");
    expect(cards[0]?.column).toBe("todo");
    expect(spawnMock).toHaveBeenCalled();
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("gateway");
    expect(args).toContain("workboard.cards.list");
    expect(args).not.toContain("--token");
  });

  it("createWorkboardGatewayCliRpcClient passes token via OPENCLAW_GATEWAY_TOKEN env", async () => {
    mockSpawnSuccess({ cards: [] });

    const client = createWorkboardGatewayCliRpcClient("secret-token");
    await client.isAvailable();
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("secret-token");
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--token");
  });

  it("createWorkboardGatewayCliRpcClient parses cards from gateway call JSON", async () => {
    mockSpawnSuccess({ result: { cards: [{ id: "g1", title: "Goal", status: "done" }] } });

    const client = createWorkboardGatewayCliRpcClient();
    const cards = await client.listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.column).toBe("done");
  });

  it("createWorkboardHttpRpcClient uses HTTP when available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ cards: [] }), { status: 200 }) as Response,
    );

    const client = createWorkboardHttpRpcClient("http://127.0.0.1:18789");
    expect(await client.isAvailable()).toBe(true);
  });
});

describe("workboard-rpc-client (#1927)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it("normalizeWorkboardApiCard maps OpenClaw 6.8 fields to hybrid-memory shape", () => {
    const card = normalizeWorkboardApiCard({
      id: "wb-1",
      title: "[Task] demo",
      status: "In Progress",
      notes: "Do the thing",
      labels: ["hybrid-memory"],
      metadata: {
        automation: { idempotencyKey: "hm-task:demo" },
        type: "active-task",
      },
    });

    expect(card).toEqual({
      id: "wb-1",
      title: "[Task] demo",
      column: "In Progress",
      description: "Do the thing",
      tags: ["hybrid-memory"],
      externalId: "hm-task:demo",
      metadata: { type: "active-task" },
      createdAt: undefined,
      updatedAt: undefined,
    });
  });

  it("createWorkboardGatewayCliRpcClient maps create params to Workboard API fields", async () => {
    mockSpawnSuccess({
      card: {
        id: "wb-2",
        title: "[Goal] ship",
        status: "Active",
        labels: ["hybrid-memory"],
        metadata: { automation: { idempotencyKey: "hm-goal:g1" } },
      },
    });

    const client = createWorkboardGatewayCliRpcClient();
    const created = await client.createCard({
      title: "[Goal] ship",
      column: "Active",
      description: "Ship it",
      tags: ["hybrid-memory"],
      externalId: "hm-goal:g1",
    });

    expect(created?.id).toBe("wb-2");
    expect(created?.externalId).toBe("hm-goal:g1");
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const paramsIndex = args.indexOf("--params");
    const params = JSON.parse(args[paramsIndex + 1] ?? "{}") as Record<string, unknown>;
    expect(params).toEqual({
      title: "[Goal] ship",
      status: "Active",
      notes: "Ship it",
      labels: ["hybrid-memory"],
      idempotencyKey: "hm-goal:g1",
    });
  });

  it("createWorkboardGatewayCliRpcClient finds cards by metadata.automation.idempotencyKey", async () => {
    mockSpawnSuccess({
      cards: [
        {
          id: "wb-3",
          title: "[Task] existing",
          status: "Done",
          metadata: { automation: { idempotencyKey: "hm-task:existing" } },
        },
      ],
    });

    const client = createWorkboardGatewayCliRpcClient();
    const found = await client.findByExternalId("hm-task:existing");
    expect(found?.id).toBe("wb-3");
    expect(found?.column).toBe("Done");
  });

  it("createWorkboardGatewayCliRpcClient unwraps { card } create responses", async () => {
    mockSpawnSuccess({
      card: { id: "wb-4", title: "Created", status: "todo", idempotencyKey: "hm-task:new" },
    });

    const client = createWorkboardGatewayCliRpcClient();
    const created = await client.createCard({
      title: "Created",
      column: "todo",
      externalId: "hm-task:new",
    });

    expect(created).toEqual({
      id: "wb-4",
      title: "Created",
      column: "todo",
      description: undefined,
      tags: undefined,
      externalId: "hm-task:new",
      metadata: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
  });
});
