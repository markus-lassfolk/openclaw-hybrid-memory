/**
 * Detect upstream Tool Search wrapper dropping tool arguments (#1973 / OpenClaw #96115).
 */

import {
  isSentinelOnlyWrapperDrop,
  isToolSearchWrapperDroppedArgs,
  MEMORY_TOOL_EXPECTED_ARG_KEYS,
} from "../utils/tool-search-wrapper-args.js";
import { capturePluginError } from "./error-reporter.js";

export const WRAPPER_ARGS_DROPPED_UPSTREAM_URL = "https://github.com/openclaw/openclaw/issues/96115";

const WRAPPER_ARG_TOOL_PREFIXES = ["memory_", "goal_", "active_task_"] as const;

export function toolArgsCompletelyEmpty(params: unknown): boolean {
  if (params == null) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;
  return Object.keys(params as object).length === 0;
}

export interface WrapperArgsDroppedToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    error: "wrapper_args_dropped";
    tool: string;
    reference: string;
    receivedArgs: unknown;
  };
}

export function wrapperArgsDroppedToolResult(
  toolName: string,
  params: unknown,
  logger?: { warn?: (msg: string) => void },
): WrapperArgsDroppedToolResult {
  const message =
    `${toolName} received empty or wrapper-only arguments — likely upstream Tool Search wrapper bug (#96115). ` +
    `Workarounds: call the tool at top level (not via tool_search), restart the session, or use openclaw CLI / cron wake. ` +
    `Reference: ${WRAPPER_ARGS_DROPPED_UPSTREAM_URL}`;
  logger?.warn?.(`memory-hybrid: wrapper_args_dropped tool=${toolName}`);
  capturePluginError(new Error(`wrapper_args_dropped:${toolName}`), {
    subsystem: "tools",
    operation: "wrapper_args_dropped",
    severity: "info",
    tags: { tool: toolName, event: "wrapper_args_dropped" },
  });
  return {
    content: [{ type: "text", text: message }],
    details: {
      error: "wrapper_args_dropped",
      tool: toolName,
      reference: WRAPPER_ARGS_DROPPED_UPSTREAM_URL,
      receivedArgs: params,
    },
  };
}

function hasWrapperArgToolPrefix(toolName: string): boolean {
  return WRAPPER_ARG_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

/** Guard at tool entry when args are wrapper-only metadata (not bare model omission). */
export function guardAgainstWrapperArgsDropped(
  toolName: string,
  params: unknown,
  logger?: { warn?: (msg: string) => void },
): WrapperArgsDroppedToolResult | null {
  const expectedKeys = MEMORY_TOOL_EXPECTED_ARG_KEYS[toolName];
  if (expectedKeys) {
    if (!isToolSearchWrapperDroppedArgs(params, expectedKeys)) return null;
    return wrapperArgsDroppedToolResult(toolName, params, logger);
  }
  if (hasWrapperArgToolPrefix(toolName)) {
    if (!isSentinelOnlyWrapperDrop(params)) return null;
    return wrapperArgsDroppedToolResult(toolName, params, logger);
  }
  return null;
}
