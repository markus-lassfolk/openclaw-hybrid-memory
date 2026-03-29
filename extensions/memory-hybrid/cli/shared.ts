/**
 * Shared CLI utilities
 *
 * Contains concurrency lock infrastructure and other utilities shared across
 * multiple CLI command modules.
 */

import { capturePluginError } from "../services/error-reporter.js";

/**
 * Format a timestamp in milliseconds as a human-readable relative time string.
 * e.g. "in 3h", "5m ago", "just now"
 */
export function relativeTime(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 60000) return future ? "in <1m" : "just now";
  if (abs < 3600000) {
    const m = Math.floor(abs / 60000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86400000) {
    const h = Math.floor(abs / 3600000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.floor(abs / 86400000);
  return future ? `in ${d}d` : `${d}d ago`;
}

export type Chainable = {
  command(name: string): Chainable;
  description(desc: string): Chainable;
  action(fn: (...args: any[]) => void | Promise<void>): Chainable;
  option(flags: string, desc?: string, defaultValue?: string): Chainable;
  requiredOption(flags: string, desc?: string, defaultValue?: string): Chainable;
  argument?(name: string, desc?: string): Chainable;
  alias?(name: string): Chainable;
};

/** Wrap async action to exit on completion (only for standalone CLI). */
export const withExit =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  (...args: A) => {
    const isStandaloneCli = process.argv.some((arg) => arg.includes("openclaw") || arg.includes("hybrid-mem"));
    Promise.resolve(fn(...args)).then(
      () => {
        if (isStandaloneCli) process.exit(process.exitCode ?? 0);
      },
      (err: unknown) => {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "cli-command",
        });
        console.error(err);
        if (isStandaloneCli) process.exit(1);
        else throw err;
      },
    );
  };

/** In-memory concurrency lock: prevents two simultaneous scans of the same type. */
const SCAN_IN_PROGRESS = new Map<string, boolean>();

/** 23-hour threshold for startup guard (milliseconds). */
const SCAN_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

/**
 * Apply the 23h startup guard and concurrency lock for a scan type.
 * Returns a skip reason string if the scan should be skipped, or null if it can proceed.
 * If it can proceed, marks the scan as in-progress (caller must call clearScanLock when done).
 */
export function acquireScanSlot(
  scanType: string,
  lastRunAt: number | undefined,
  logger: { info?: (s: string) => void },
): string | null {
  if (SCAN_IN_PROGRESS.get(scanType)) {
    const msg = `Skipping ${scanType}: already running`;
    logger.info?.(msg);
    return msg;
  }
  if (lastRunAt !== undefined && lastRunAt !== 0 && Date.now() - lastRunAt < SCAN_MIN_INTERVAL_MS) {
    const hoursAgo = ((Date.now() - lastRunAt) / 3_600_000).toFixed(1);
    const msg = `Skipping ${scanType}: last run was ${hoursAgo}h ago (threshold: 23h). Use --full to override.`;
    logger.info?.(msg);
    return msg;
  }
  SCAN_IN_PROGRESS.set(scanType, true);
  return null;
}

export function clearScanLock(scanType: string): void {
  SCAN_IN_PROGRESS.delete(scanType);
}
