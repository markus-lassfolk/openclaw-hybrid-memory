/**
 * Plugin logger abstraction.
 *
 * Provides a structured logger for all runtime code (services, backends, lifecycle, tools).
 * Routes through `api.logger` which respects verbosity and OpenClaw's log pipeline.
 *
 * Usage:
 *   1. Call `initPluginLogger(api.logger)` once at plugin registration time (index.ts register()).
 *   2. Import `pluginLogger` in services/backends/lifecycle/tools and use it instead of console.*.
 *
 * CLI code that outputs directly to the terminal (user-visible command output) should continue
 * using `console.*` — CLI output is intentional user communication, not runtime telemetry.
 *
 * Allow-list for console.* (enforced by biome noConsole rule):
 *   - cli/**
 *   - index.ts (bootstrap only, top-level startup messages)
 *
 * Before initPluginLogger is called (e.g. during unit tests without plugin setup),
 * the logger is a silent no-op so tests do not emit noise unless they opt in.
 */

/** Logger interface matching api.logger from ClawdbotPluginApi */
export interface PluginLoggerApi {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

/** Silent no-op logger used before initPluginLogger is called. */
const noopLogger: Required<PluginLoggerApi> = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Active logger delegate — replaced by initPluginLogger.
 * Marked as `let` intentionally: initialized once at plugin startup.
 */
let activeLogger: Required<PluginLoggerApi> = noopLogger;

/**
 * Initialize the plugin logger with the api.logger instance.
 * Call this once in register(api) before any services are started.
 *
 * @param apiLogger - The logger from ClawdbotPluginApi
 */
export function initPluginLogger(apiLogger: PluginLoggerApi): void {
  activeLogger = {
    info: (msg: string) => apiLogger.info(msg),
    warn: (msg: string) => apiLogger.warn(msg),
    error: (msg: string) => apiLogger.error(msg),
    debug: (msg: string) => apiLogger.debug?.(msg),
  };
}

/**
 * Reset the plugin logger to the silent no-op.
 * Used in unit tests to isolate logging side effects.
 */
export function resetPluginLogger(): void {
  activeLogger = noopLogger;
}

/**
 * Structured plugin logger for runtime code (services, backends, lifecycle, tools).
 *
 * Use this instead of `console.*` everywhere outside the CLI allow-list.
 * Routed through `api.logger` which respects OpenClaw verbosity settings.
 */
export const pluginLogger = {
  info(msg: string): void {
    activeLogger.info(msg);
  },
  warn(msg: string): void {
    activeLogger.warn(msg);
  },
  error(msg: string): void {
    activeLogger.error(msg);
  },
  debug(msg: string): void {
    activeLogger.debug(msg);
  },
};
