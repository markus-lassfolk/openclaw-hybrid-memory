/**
 * Error Tracking Utilities
 *
 * Higher-order wrapper to DRY up repetitive try/catch + capturePluginError patterns
 * across tool execution handlers.
 */

import { capturePluginError } from "../services/error-reporter.js";

/**
 * Context for error tracking - passed to capturePluginError
 */
export interface ErrorContext {
  operation: string;
  subsystem?: string;
  configShape?: Record<string, string>;
  phase?: string;
  backend?: string;
  retryAttempt?: number;
  memoryCount?: number;
  severity?: string;
  [key: string]: unknown;
}

/**
 * Wraps a function with error tracking.
 * Catches errors, reports them via capturePluginError, then re-throws.
 *
 * @param fn - The function to wrap (sync or async)
 * @param context - Error context to pass to capturePluginError
 * @returns Wrapped function with same signature
 *
 * @example
 * const safeFn = withErrorTracking(
 *   () => credentialsDb.store({...}),
 *   { subsystem: "credentials", operation: "credential-store", phase: "runtime", backend: "sqlite" }
 * );
 * await safeFn();
 */
export function withErrorTracking<T>(fn: () => T, context: ErrorContext): () => T {
  return () => {
    try {
      return fn();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), context);
      throw err;
    }
  };
}

/**
 * Async version of withErrorTracking.
 * Wraps an async function with error tracking.
 *
 * @param fn - The async function to wrap
 * @param context - Error context to pass to capturePluginError
 * @returns Wrapped async function with same signature
 *
 * @example
 * const safeFn = withErrorTrackingAsync(
 *   async () => await someAsyncOperation(),
 *   { subsystem: "issues", operation: "issue-create", phase: "runtime" }
 * );
 * await safeFn();
 */
export function withErrorTrackingAsync<T>(fn: () => Promise<T>, context: ErrorContext): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), context);
      throw err;
    }
  };
}
