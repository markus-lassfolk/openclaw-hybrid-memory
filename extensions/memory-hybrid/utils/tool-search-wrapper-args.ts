/**
 * Detect OpenClaw Tool Search wrapper argument loss (upstream #96115 / #53408).
 * When the wrapper drops nested args, memory_* tools receive {} or wrapper-only
 * flattened keys — indistinguishable from a generic "Provide a query" failure.
 */

export const TOOL_SEARCH_WRAPPER_UPSTREAM_ISSUE = "https://github.com/openclaw/openclaw/issues/96115";

const WRAPPER_SENTINEL_KEYS = new Set([
  "id",
  "command",
  "toolName",
  "name",
  "tool",
  "input",
  "arguments",
  "args",
]);

const STRONG_WRAPPER_SENTINEL_KEYS = new Set(["command", "toolName", "tool", "input", "arguments", "args"]);

function hasMeaningfulParamValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function hasMeaningfulToolArg(obj: Record<string, unknown>, key: string): boolean {
  if (!hasMeaningfulParamValue(obj[key])) return false;
  if (key !== "id" && key !== "name") return true;
  // Wrapper flattening often passes tool-call id/name alongside command metadata.
  return !(
    obj.command != null ||
    obj.toolName != null ||
    obj.tool != null ||
    obj.arguments != null ||
    obj.args != null ||
    obj.input != null
  );
}

/** True when params look like wrapper metadata with no usable tool arguments. */
export function isToolSearchWrapperDroppedArgs(params: unknown, expectedKeys: readonly string[]): boolean {
  if (params === null || params === undefined) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;

  const obj = params as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;

  if (expectedKeys.some((key) => hasMeaningfulToolArg(obj, key))) return false;

  return keys.some((key) => STRONG_WRAPPER_SENTINEL_KEYS.has(key) || WRAPPER_SENTINEL_KEYS.has(key));
}

export function toolSearchWrapperDroppedArgsMessage(toolName: string): string {
  return (
    `${toolName} received empty or wrapper-only arguments — likely upstream Tool Search wrapper bug (#96115). ` +
    "Workarounds: use top-level tools directly, restart the session, or call via openclaw CLI through cron wake. " +
    `Reference: ${TOOL_SEARCH_WRAPPER_UPSTREAM_ISSUE}`
  );
}

export type ToolSearchWrapperDroppedArgsDetails = {
  error: "wrapper_args_dropped";
  event: "wrapper_args_dropped";
  tool: string;
  reference: string;
  receivedArgs: unknown;
};

export function buildToolSearchWrapperDroppedArgsResponse(
  toolName: string,
  params: unknown,
): {
  content: Array<{ type: "text"; text: string }>;
  details: ToolSearchWrapperDroppedArgsDetails;
} {
  return {
    content: [{ type: "text", text: toolSearchWrapperDroppedArgsMessage(toolName) }],
    details: {
      error: "wrapper_args_dropped",
      event: "wrapper_args_dropped",
      tool: toolName,
      reference: TOOL_SEARCH_WRAPPER_UPSTREAM_ISSUE,
      receivedArgs: params,
    },
  };
}

/** Expected primary argument keys per memory_* tool (for wrapper-drop detection). */
export const MEMORY_TOOL_EXPECTED_ARG_KEYS: Record<string, readonly string[]> = {
  memory_recall: ["query", "id"],
  memory_keyword_recall: ["query"],
  memory_store: ["text"],
  memory_record_episode: ["event"],
  memory_forget: ["query", "memoryId", "id"],
  memory_search_episodes: ["query"],
  memory_retrieve: ["query"],
  memory_pin: ["idOrQuery"],
  memory_snooze: ["idOrQuery"],
  memory_promote: ["query", "memoryId", "id"],
  memory_directory: ["query"],
  memory_recall_procedures: ["taskDescription"],
  memory_procedure_feedback: ["procedureId"],
  memory_add_edict: ["text"],
  memory_update_edict: ["id", "text"],
  memory_remove_edict: ["id"],
  memory_get_edicts: ["query", "tags"],
};

function isMissingRequiredArgsToolResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const details = (result as { details?: Record<string, unknown> }).details;
  if (!details || typeof details !== "object") return false;

  if (details.error === "wrapper_args_dropped") return false;
  if (details.error === "missing_param" || details.error === "invalid_text") return true;
  if (details.action === "not_found") return false;

  if (details.count === 0) {
    const content = (result as { content?: Array<{ text?: string }> }).content;
    const text = content?.[0]?.text ?? "";
    return /Provide (a |query|the |search query)/i.test(text) || /is required/i.test(text);
  }

  return false;
}

/** Wrap a memory tool execute handler to upgrade silent missing-arg failures. */
export function wrapMemoryToolExecuteForWrapperArgs<T extends readonly unknown[]>(
  toolName: string,
  execute: (...args: T) => Promise<unknown> | unknown,
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void },
): (...args: T) => Promise<unknown> | unknown {
  const expectedKeys = MEMORY_TOOL_EXPECTED_ARG_KEYS[toolName];
  if (!expectedKeys) return execute;

  return async (...args: T) => {
    const params = args[1] as unknown;
    const result = await execute(...args);
    if (!isMissingRequiredArgsToolResult(result)) return result;
    if (!isToolSearchWrapperDroppedArgs(params, expectedKeys)) return result;
    const response = buildToolSearchWrapperDroppedArgsResponse(toolName, params);
    logger?.warn?.(`memory-hybrid: ${toolName} wrapper args dropped`, response.details);
    return response;
  };
}
