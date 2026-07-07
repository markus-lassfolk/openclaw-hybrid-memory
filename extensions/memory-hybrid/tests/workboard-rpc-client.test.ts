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
  normalizeWorkboardCardFromApi,
} from "../services/workboard-rpc-client.js";

function mockSpawnJson(stdout: unknown, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setTimeout(() => {
      if (stderr) child.stderr.emit("data", stderr);
      child.stdout.emit("data", JSON.stringify(stdout));
      child.emit("close", exitCode);
    }, 0);
    return child;
  });
}

describe("normalizeWorkboardCardFromApi", () => {
  it("maps OpenClaw workboard status/labels/notes and idempotencyKey", () => {
    const card = normalizeWorkboardCardFromApi({
      id: "c1",
      title: "[Task] foo",
      status: "backlog",
      labels: ["hybrid-memory"],
      notes: "hello",
      metadata: { automation: { idempotencyKey: "hm-task:foo" } },
    });
    expect(card).toEqual({
      id: "c1",
      title: "[Task] foo",
      column: "backlog",
      description: "hello",
      tags: ["hybrid-memory"],
      externalId: "hm-task:foo",
      metadata: { automation: { idempotencyKey: "hm-task:foo" } },
      createdAt: undefined,
      updatedAt: undefined,
    });
  });
});

describe("workboard-rpc-client (#1925)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it("createWorkboardRpcClient falls back to gateway CLI when HTTP /rpc returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }) as Response);
    mockSpawnJson({ cards: [{ id: "c1", title: "Task", status: "todo" }] });

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
  });

  it("createWorkboardGatewayCliRpcClient passes token via OPENCLAW_GATEWAY_TOKEN env", async () => {
    mockSpawnJson({ cards: [] });

    const client = createWorkboardGatewayCliRpcClient("secret-token");
    await client.isAvailable();
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("secret-token");
  });

  it("createWorkboardGatewayCliRpcClient unwraps { card } on create", async () => {
    mockSpawnJson({
      card: {
        id: "new1",
        title: "[Task] x",
        status: "backlog",
        labels: ["hybrid-memory"],
        metadata: { automation: { idempotencyKey: "hm-task:x" } },
      },
    });

    const client = createWorkboardGatewayCliRpcClient();
    const created = await client.createCard({
      title: "[Task] x",
      column: "backlog",
      tags: ["hybrid-memory"],
      externalId: "hm-task:x",
    });
    expect(created?.id).toBe("new1");
    expect(created?.externalId).toBe("hm-task:x");
    const params = JSON.parse((spawnMock.mock.calls[0]?.[1] as string[])[4]);
    expect(params.status).toBe("backlog");
    expect(params.idempotencyKey).toBe("hm-task:x");
    expect(params.labels).toEqual(["hybrid-memory"]);
  });

  it("createWorkboardHttpRpcClient uses HTTP when available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ cards: [] }), { status: 200 }) as Response,
    );

    const client = createWorkboardHttpRpcClient("http://127.0.0.1:18789");
    expect(await client.isAvailable()).toBe(true);
  });

  it("createWorkboardRpcClient re-probes after the pin's TTL expires instead of pinning forever (loop iteration 11 regression)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }) as Response);
      mockSpawnJson({ cards: [] });

      const client = createWorkboardRpcClient("http://127.0.0.1:18789");
      await client.listCards();
      // HTTP unavailable (404) -> falls back to CLI: one spawn for the isAvailable probe,
      // one for the actual listCards call.
      expect(spawnMock).toHaveBeenCalledTimes(2);

      // Jump past the 5-minute pin TTL and let HTTP recover.
      vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ cards: [] }), { status: 200 }) as Response,
      );

      await client.listCards();
      // Without the TTL fix, the client stays pinned to the CLI fallback forever and this
      // call would add two more spawn invocations instead of switching back to HTTP.
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("createWorkboardHttpRpcClient.isAvailable() skips its network probe when shouldAbort() is true (shutdown)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createWorkboardHttpRpcClient("http://127.0.0.1:18789", undefined, { shouldAbort: () => true });
    expect(await client.isAvailable()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createWorkboardGatewayCliRpcClient.isAvailable() skips its process spawn when shouldAbort() is true (shutdown)", async () => {
    const client = createWorkboardGatewayCliRpcClient(undefined, { shouldAbort: () => true });
    expect(await client.isAvailable()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
