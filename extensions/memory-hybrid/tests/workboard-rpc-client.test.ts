import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("../utils/process-runner.js", () => ({
  spawnSync: spawnSyncMock,
}));

import {
  createWorkboardGatewayCliRpcClient,
  createWorkboardHttpRpcClient,
  createWorkboardRpcClient,
} from "../services/workboard-rpc-client.js";

describe("workboard-rpc-client (#1925)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  it("createWorkboardRpcClient falls back to gateway CLI when HTTP /rpc returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404 }) as Response,
    );
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ cards: [{ id: "c1", title: "Task", column: "todo" }] }),
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
      error: undefined,
    });

    const client = createWorkboardRpcClient("http://127.0.0.1:18789");
    expect(await client.isAvailable()).toBe(true);
    const cards = await client.listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("c1");
    expect(spawnSyncMock).toHaveBeenCalled();
    const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("gateway");
    expect(args).toContain("workboard.cards.list");
    expect(args).not.toContain("--token");
  });

  it("createWorkboardGatewayCliRpcClient passes token via OPENCLAW_GATEWAY_TOKEN env", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ cards: [] }),
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
      error: undefined,
    });

    const client = createWorkboardGatewayCliRpcClient("secret-token");
    await client.isAvailable();
    const env = spawnSyncMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("secret-token");
    const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--token");
  });

  it("createWorkboardGatewayCliRpcClient parses cards from gateway call JSON", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ result: { cards: [{ id: "g1", title: "Goal", column: "done" }] } }),
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
      error: undefined,
    });

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
