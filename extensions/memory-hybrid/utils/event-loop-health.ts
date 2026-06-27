/**
 * Event-loop lag observability for gateway health RPCs and verify (#931 follow-up).
 *
 * Maeve production: gateway logged eventLoopMax=457ms during provider pre-warm while
 * workboard sync held the loop with sequential goal registry I/O.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { getEnv } from "./env-manager.js";

export type EventLoopHealthStatus = "healthy" | "degraded" | "unknown";

export type EventLoopLagSnapshot = {
  health: EventLoopHealthStatus;
  meanMs: number | null;
  maxMs: number | null;
  p99Ms: number | null;
  degradedThresholdMs: number;
};

const DEFAULT_DEGRADED_MS = 200;

let histogram: IntervalHistogram | null = null;

export function resolveEventLoopDegradedThresholdMs(): number {
  const raw = getEnv("OPENCLAW_HYBRID_MEM_EVENT_LOOP_DEGRADED_MS");
  if (!raw) return DEFAULT_DEGRADED_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEGRADED_MS;
}

export function classifyEventLoopLag(maxLagMs: number | null, thresholdMs = resolveEventLoopDegradedThresholdMs()): EventLoopHealthStatus {
  if (maxLagMs === null || !Number.isFinite(maxLagMs)) return "unknown";
  return maxLagMs > thresholdMs ? "degraded" : "healthy";
}

function nsToMs(ns: number): number {
  return ns / 1e6;
}

/** Start continuous lag sampling (safe to call multiple times). */
export function startEventLoopLagMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
}

/** Disable sampling and release the histogram (tests / CLI teardown). */
export function stopEventLoopLagMonitor(): void {
  if (!histogram) return;
  histogram.disable();
  histogram = null;
}

export function resetEventLoopLagMonitorForTests(): void {
  stopEventLoopLagMonitor();
}

export function getEventLoopLagSnapshot(): EventLoopLagSnapshot {
  const degradedThresholdMs = resolveEventLoopDegradedThresholdMs();
  if (!histogram) {
    return {
      health: "unknown",
      meanMs: null,
      maxMs: null,
      p99Ms: null,
      degradedThresholdMs,
    };
  }
  const maxMs = nsToMs(histogram.max);
  return {
    health: classifyEventLoopLag(maxMs, degradedThresholdMs),
    meanMs: nsToMs(histogram.mean),
    maxMs,
    p99Ms: nsToMs(histogram.percentile(99)),
    degradedThresholdMs,
  };
}

/** One-shot scheduler delay sample (CLI verify when monitor is not running). */
export async function sampleSchedulerDelayMs(): Promise<number> {
  const start = performance.now();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return performance.now() - start;
}
