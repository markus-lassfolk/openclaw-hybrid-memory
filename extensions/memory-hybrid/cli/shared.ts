/**
 * Shared utilities for CLI commands.
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
  if (abs < 3600000) { const m = Math.floor(abs / 60000); return future ? `in ${m}m` : `${m}m ago`; }
  if (abs < 86400000) { const h = Math.floor(abs / 3600000); return future ? `in ${h}h` : `${h}h ago`; }
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
export const withExit = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
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
