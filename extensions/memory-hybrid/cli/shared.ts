/**
 * Shared utilities for CLI commands.
 */

import { capturePluginError } from "../services/error-reporter.js";

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
