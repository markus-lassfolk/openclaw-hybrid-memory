import { afterEach, describe, expect, it } from "vitest";
import {
  classifyEventLoopLag,
  getEventLoopLagSnapshot,
  resetEventLoopLagMonitorForTests,
  resolveEventLoopDegradedThresholdMs,
  sampleSchedulerDelayMs,
  startEventLoopLagMonitor,
} from "../utils/event-loop-health.js";
import { setEnv } from "../utils/env-manager.js";

describe("event-loop-health", () => {
  afterEach(() => {
    resetEventLoopLagMonitorForTests();
    setEnv("OPENCLAW_HYBRID_MEM_EVENT_LOOP_DEGRADED_MS", undefined);
  });

  it("classifyEventLoopLag uses threshold env override", () => {
    setEnv("OPENCLAW_HYBRID_MEM_EVENT_LOOP_DEGRADED_MS", "100");
    expect(resolveEventLoopDegradedThresholdMs()).toBe(100);
    expect(classifyEventLoopLag(50)).toBe("healthy");
    expect(classifyEventLoopLag(150)).toBe("degraded");
  });

  it("getEventLoopLagSnapshot is unknown before monitor starts", () => {
    const snap = getEventLoopLagSnapshot();
    expect(snap.health).toBe("unknown");
    expect(snap.maxMs).toBeNull();
  });

  it("startEventLoopLagMonitor records lag after yield", async () => {
    startEventLoopLagMonitor();
    await sampleSchedulerDelayMs();
    const snap = getEventLoopLagSnapshot();
    expect(snap.health).toBe("healthy");
    expect(snap.maxMs).not.toBeNull();
    expect(snap.meanMs).not.toBeNull();
    expect(snap.degradedThresholdMs).toBe(200);
  });

  it("sampleSchedulerDelayMs completes promptly on idle loop", async () => {
    const delay = await sampleSchedulerDelayMs();
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(500);
  });
});
