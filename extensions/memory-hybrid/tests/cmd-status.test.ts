import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const collectStatusMock = vi.fn();

vi.mock("../routes/dashboard-server.js", () => ({
  collectStatus: (...args: unknown[]) => collectStatusMock(...args),
}));

import { runStatusForCli } from "../cli/cmd-status.js";

function makeCtx() {
  return {
    factsDb: {} as never,
    vectorDb: {} as never,
    resolvedSqlitePath: "/tmp/facts.db",
    resolvedLancePath: "/tmp/lance",
    pluginId: "openclaw-hybrid-memory",
    cfg: { dashboard: { port: 7788 } },
  };
}

describe("runStatusForCli", () => {
  beforeEach(() => {
    collectStatusMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints text output with needs-attention guidance", async () => {
    collectStatusMock.mockResolvedValue({
      memory: { activeFacts: 1234, expiredFacts: 7, vectorCount: 1240, totalSizeBytes: 2048 },
      cronJobs: [
        { name: "prune", enabled: true, consecutiveErrors: 2, lastRunAt: null },
        { name: "compact", enabled: true, consecutiveErrors: 0, lastRunAt: "2026-05-11T08:00:00Z" },
      ],
      audit: { recentFailures: [{ id: "a1" }] },
      agentHealth: { alerts: [{ id: "h1" }] },
      taskQueue: { current: { title: "Repair cron drift" } },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStatusForCli(makeCtx(), { format: "text" });

    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("Hybrid Memory status");
    expect(output).toContain("Dashboard: http://127.0.0.1:7788/");
    expect(output).toContain("Cron jobs: 2 total, 1 needing attention");
    expect(output).toContain("Audit failures (24h): 1");
    expect(output).toContain("Agent alerts: 1");
    expect(output).toContain("Current task: Repair cron drift");
    expect(output).toContain("Run `openclaw hybrid-mem verify`");
  });

  it("prints healthy text guidance when no alerts exist", async () => {
    collectStatusMock.mockResolvedValue({
      memory: { activeFacts: 1, expiredFacts: 0, vectorCount: 1, totalSizeBytes: 512 },
      cronJobs: [{ name: "prune", enabled: true, consecutiveErrors: 0, lastRunAt: "2026-05-11T08:00:00Z" }],
      audit: { recentFailures: [] },
      agentHealth: { alerts: [] },
      taskQueue: { current: null },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStatusForCli(makeCtx(), { format: "text" });

    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("Current task: none");
    expect(output).toContain("Everything looks healthy. Open Mission Control for deeper inspection.");
  });

  it("emits full JSON payload when format=json", async () => {
    const statusPayload = {
      memory: { activeFacts: 3, expiredFacts: 1, vectorCount: 3, totalSizeBytes: 1024 },
      cronJobs: [],
      audit: { recentFailures: [] },
      agentHealth: { alerts: [] },
      taskQueue: { current: null },
    };
    collectStatusMock.mockResolvedValue(statusPayload);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStatusForCli(makeCtx(), { format: "json" });

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0] ?? "{}")) as {
      dashboardUrl: string;
      status: typeof statusPayload;
    };
    expect(payload.dashboardUrl).toBe("http://127.0.0.1:7788/");
    expect(payload.status).toEqual(statusPayload);
  });
});
