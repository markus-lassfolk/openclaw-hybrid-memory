/**
 * Verbose tracing for wiki / Workboard UI integration flows.
 * Enabled when hybrid-memory `verbosity` is `"verbose"` (Issue #282).
 */

import type { VerbosityLevel } from "../config/types/index.js";
import { pluginLogger } from "./logger.js";

export function integrationVerbose(verbosity?: VerbosityLevel): boolean {
  return verbosity === "verbose";
}

/** Per-item trace lines — only emitted when integration verbose mode is on. */
export function traceIntegration(verbose: boolean, msg: string): void {
  if (verbose) pluginLogger.debug(`memory-hybrid: ${msg}`);
}
