/**
 * Structured telemetry for #1901–#1904 feature paths.
 *
 * Emits grep-friendly `memory-hybrid: feature-telemetry` lines at info/warn levels.
 * Warnings fire when latency exceeds configured budgets so Maeve logs surface regressions.
 */

export type FeatureTelemetryLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type FeatureTelemetryEvent = {
  feature: "recall" | "contradiction" | "episode_causal" | "worker_lease" | "contradiction_repair";
  operation: string;
  durationMs?: number;
  warnBudgetMs?: number;
  outcome?: "ok" | "degraded" | "skipped" | "error";
  fields?: Record<string, string | number | boolean | null | undefined>;
};

function sanitize(value: string): string {
  return value.replace(/\s+/g, "_");
}

function formatEvent(event: FeatureTelemetryEvent): string {
  const parts = [`feature=${sanitize(event.feature)}`, `op=${sanitize(event.operation)}`];
  if (event.outcome) parts.push(`outcome=${event.outcome}`);
  if (event.durationMs != null) parts.push(`duration_ms=${event.durationMs}`);
  if (event.warnBudgetMs != null) parts.push(`budget_ms=${event.warnBudgetMs}`);
  if (event.fields) {
    for (const [key, value] of Object.entries(event.fields)) {
      if (value === undefined || value === null) continue;
      parts.push(`${sanitize(key)}=${sanitize(String(value))}`);
    }
  }
  return `memory-hybrid: feature-telemetry ${parts.join(" ")}`;
}

export function emitFeatureTelemetry(logger: FeatureTelemetryLogger | undefined, event: FeatureTelemetryEvent): void {
  if (!logger) return;
  const line = formatEvent(event);
  const overBudget =
    event.durationMs != null &&
    event.warnBudgetMs != null &&
    event.warnBudgetMs > 0 &&
    event.durationMs > event.warnBudgetMs;
  if (overBudget || event.outcome === "error" || event.outcome === "degraded") {
    logger.warn?.(line);
  } else {
    logger.info?.(line);
  }
}

export function withFeatureTiming<T>(
  logger: FeatureTelemetryLogger | undefined,
  event: Omit<FeatureTelemetryEvent, "durationMs">,
  fn: () => T,
): T {
  const started = Date.now();
  try {
    const result = fn();
    emitFeatureTelemetry(logger, {
      ...event,
      durationMs: Date.now() - started,
      outcome: event.outcome ?? "ok",
    });
    return result;
  } catch (err) {
    emitFeatureTelemetry(logger, {
      ...event,
      durationMs: Date.now() - started,
      outcome: "error",
      fields: { ...event.fields, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

export async function withFeatureTimingAsync<T>(
  logger: FeatureTelemetryLogger | undefined,
  event: Omit<FeatureTelemetryEvent, "durationMs">,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    emitFeatureTelemetry(logger, {
      ...event,
      durationMs: Date.now() - started,
      outcome: event.outcome ?? "ok",
    });
    return result;
  } catch (err) {
    emitFeatureTelemetry(logger, {
      ...event,
      durationMs: Date.now() - started,
      outcome: "error",
      fields: { ...event.fields, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
