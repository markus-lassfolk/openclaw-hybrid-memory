/**
 * Detect OpenClaw Tool Search wrapper argument loss (upstream #96115 / #53408).
 * When the wrapper drops nested args, tools receive wrapper-only flattened keys —
 * indistinguishable from a generic "Provide a query" failure.
 * Bare {} is treated as model omission, not wrapper loss.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

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

function hasWrapperSentinelKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((key) => STRONG_WRAPPER_SENTINEL_KEYS.has(key) || WRAPPER_SENTINEL_KEYS.has(key));
}

/** True when params are null/undefined or contain wrapper metadata without tool args. */
export function isSentinelOnlyWrapperDrop(params: unknown): boolean {
  if (params === null || params === undefined) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;

  const obj = params as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return false;

  return hasWrapperSentinelKeys(obj);
}

/** True when params look like wrapper metadata with no usable tool arguments. */
export function isToolSearchWrapperDroppedArgs(params: unknown, expectedKeys: readonly string[]): boolean {
  if (params === null || params === undefined) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;

  const obj = params as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;

  if (expectedKeys.some((key) => hasMeaningfulToolArg(obj, key))) return false;

  return hasWrapperSentinelKeys(obj);
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

/** Expected primary argument keys per tool (for wrapper-drop detection). */
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
  memory_list_edicts: ["query", "tags"],
  memory_episode_causal_chain: ["episodeId"],
  memory_ingest_document: ["path", "filePath", "url"],
  memory_ingest_folder: ["path", "folderPath"],
  memory_link: ["fromId", "toId", "sourceId", "targetId"],
  memory_graph: ["entity", "query"],
  memory_path: ["fromId", "toId", "sourceId", "targetId"],
  memory_crystallize: ["query", "text"],
  memory_crystallize_approve: ["id", "proposalId"],
  memory_crystallize_reject: ["id", "proposalId"],
  memory_crystallize_restore: ["id", "proposalId"],
  memory_issue_create: ["title", "summary"],
  memory_issue_update: ["id", "issueId"],
  memory_issue_search: ["query"],
  memory_issue_link_fact: ["issueId", "factId"],
  memory_propose_tool: ["name", "description"],
  memory_tool_approve: ["id", "proposalId"],
  memory_tool_reject: ["id", "proposalId"],
  memory_verify: ["factId"],
  memory_provenance: ["factId"],
  memory_workshop: ["id", "ordinal"],
  active_task_checkpoint: ["entity"],
  goal_get: ["goal_id"],
  goal_register: ["description"],
  goal_assess: ["goal_id"],
  goal_update: ["goal_id"],
  goal_complete: ["goal_id"],
  goal_abandon: ["goal_id"],
  active_task_get: ["task_label"],
  active_task_propose_goal: ["task_label"],
};

const WRAPPER_ARG_TOOL_PREFIXES = ["memory_", "goal_", "active_task_"] as const;

function hasWrapperArgToolPrefix(toolName: string): boolean {
  return WRAPPER_ARG_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function resolveWrapperDropMode(
  toolName: string,
): { kind: "mapped"; expectedKeys: readonly string[] } | { kind: "sentinel_only" } | null {
  const expectedKeys = MEMORY_TOOL_EXPECTED_ARG_KEYS[toolName];
  if (expectedKeys) return { kind: "mapped", expectedKeys };
  if (hasWrapperArgToolPrefix(toolName)) return { kind: "sentinel_only" };
  return null;
}

function isWrapperArgsDropped(params: unknown, mode: NonNullable<ReturnType<typeof resolveWrapperDropMode>>): boolean {
  if (mode.kind === "mapped") return isToolSearchWrapperDroppedArgs(params, mode.expectedKeys);
  return isSentinelOnlyWrapperDrop(params);
}

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

/** Wrap a tool execute handler to detect wrapper argument loss. */
export function wrapMemoryToolExecuteForWrapperArgs<T extends readonly unknown[], R>(
  toolName: string,
  execute: (...args: T) => Promise<R> | R,
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void },
): (
  ...args: T
) => Promise<
  R | { content: Array<{ type: "text"; text: string }>; details: ToolSearchWrapperDroppedArgsDetails }
> {
  const mode = resolveWrapperDropMode(toolName);
  if (!mode) return async (...args: T) => execute(...args);

  return async (...args: T) => {
    const params = args[1] as unknown;
    if (isWrapperArgsDropped(params, mode)) {
      const response = buildToolSearchWrapperDroppedArgsResponse(toolName, params);
      logger?.warn?.(`memory-hybrid: ${toolName} wrapper args dropped`, response.details);
      return response;
    }

    const result = await execute(...args);
    if (!isMissingRequiredArgsToolResult(result)) return result;
    if (!isWrapperArgsDropped(params, mode)) return result;
    const response = buildToolSearchWrapperDroppedArgsResponse(toolName, params);
    logger?.warn?.(`memory-hybrid: ${toolName} wrapper args dropped`, response.details);
    return response;
  };
}

function shouldWrapToolForWrapperArgs(toolName: string): boolean {
  return resolveWrapperDropMode(toolName) != null;
}

/** Patch registerTool so memory/goal/active-task tools get wrapper-arg detection. */
export function patchMemoryToolRegistrationApi(api: ClawdbotPluginApi): ClawdbotPluginApi {
  const registerTool = api.registerTool.bind(api);
  return {
    ...api,
    registerTool(
      toolDef: Parameters<typeof registerTool>[0],
      options: Parameters<typeof registerTool>[1],
    ) {
      if (typeof toolDef.name === "string" && typeof toolDef.execute === "function") {
        const toolName = toolDef.name;
        if (shouldWrapToolForWrapperArgs(toolName)) {
          return registerTool(
            {
              ...toolDef,
              execute: wrapMemoryToolExecuteForWrapperArgs(toolName, toolDef.execute.bind(toolDef), api.logger),
            },
            options,
          );
        }
      }
      return registerTool(toolDef, options);
    },
  } as ClawdbotPluginApi;
}
