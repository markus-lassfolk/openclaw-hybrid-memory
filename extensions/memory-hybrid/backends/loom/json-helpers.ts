import { capturePluginError } from "../../services/error-reporter.js";

/** Parse a JSON column, falling back (and reporting) on corruption instead of throwing. */
export function parseJsonColumn<T>(value: string | null | undefined, fallback: T, subsystem: string): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "json-parse",
      subsystem,
      severity: "info",
    });
    return fallback;
  }
}

export function clamp01(value: number | undefined, fallback = 0.5): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}
