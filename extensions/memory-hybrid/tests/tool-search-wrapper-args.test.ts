import { describe, expect, it, vi } from "vitest";
import {
  buildToolSearchWrapperDroppedArgsResponse,
  isSentinelOnlyWrapperDrop,
  isToolSearchWrapperDroppedArgs,
  MEMORY_TOOL_EXPECTED_ARG_KEYS,
  wrapMemoryToolExecuteForWrapperArgs,
} from "../utils/tool-search-wrapper-args.js";

describe("tool-search-wrapper-args (#1973)", () => {
  it("detects null/undefined params as wrapper-dropped", () => {
    expect(isToolSearchWrapperDroppedArgs(null, ["query"])).toBe(true);
    expect(isToolSearchWrapperDroppedArgs(undefined, ["text"])).toBe(true);
  });

  it("does not treat bare {} as wrapper-dropped (model omission)", () => {
    expect(isToolSearchWrapperDroppedArgs({}, ["query", "id"])).toBe(false);
    expect(isSentinelOnlyWrapperDrop({})).toBe(false);
  });

  it("detects wrapper-only flattened params without tool args", () => {
    expect(
      isToolSearchWrapperDroppedArgs({ id: "toolu_123", command: "memory_recall" }, ["query", "id"]),
    ).toBe(true);
    expect(isSentinelOnlyWrapperDrop({ id: "toolu_123", command: "memory_recall" })).toBe(true);
  });

  it("does not flag intentional empty query string as wrapper-dropped", () => {
    expect(isToolSearchWrapperDroppedArgs({ query: "" }, ["query", "id"])).toBe(false);
    expect(isToolSearchWrapperDroppedArgs({ query: "   " }, ["query", "id"])).toBe(false);
  });

  it("does not flag valid tool params", () => {
    expect(isToolSearchWrapperDroppedArgs({ query: "deploy api" }, ["query", "id"])).toBe(false);
    expect(isToolSearchWrapperDroppedArgs({ id: "fact-uuid" }, ["query", "id"])).toBe(false);
  });

  it("buildToolSearchWrapperDroppedArgsResponse includes upstream reference", () => {
    const response = buildToolSearchWrapperDroppedArgsResponse("memory_recall", {
      command: "memory_recall",
    });
    expect(response.details.error).toBe("wrapper_args_dropped");
    expect(response.details.event).toBe("wrapper_args_dropped");
    expect(response.content[0].text).toContain("#96115");
    expect(response.content[0].text).toContain("openclaw/openclaw/issues/96115");
  });

  it("wrapMemoryToolExecuteForWrapperArgs short-circuits before execute when wrapper sentinels present", async () => {
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text", text: "Provide a query." }],
      details: { count: 0 },
    }));
    const wrapped = wrapMemoryToolExecuteForWrapperArgs("memory_keyword_recall", execute, logger);
    const result = (await wrapped("tc", { command: "memory_keyword_recall", id: "toolu_123" })) as {
      details: { error: string };
    };
    expect(result.details.error).toBe("wrapper_args_dropped");
    expect(execute).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "memory-hybrid: memory_keyword_recall wrapper args dropped",
      expect.objectContaining({ event: "wrapper_args_dropped" }),
    );
  });

  it("wrapMemoryToolExecuteForWrapperArgs preserves missing-arg message for bare {}", async () => {
    const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text", text: "Provide a query." }],
      details: { count: 0 },
    }));
    const wrapped = wrapMemoryToolExecuteForWrapperArgs("memory_keyword_recall", execute);
    const result = (await wrapped("tc", {})) as { details: { count: number }; content: Array<{ text: string }> };
    expect(execute).toHaveBeenCalled();
    expect(result.details.count).toBe(0);
    expect(result.content[0].text).toBe("Provide a query.");
  });

  it("wrapMemoryToolExecuteForWrapperArgs preserves intentional empty query message", async () => {
    const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text", text: "Provide a query." }],
      details: { count: 0 },
    }));
    const wrapped = wrapMemoryToolExecuteForWrapperArgs("memory_keyword_recall", execute);
    const result = (await wrapped("tc", { query: "" })) as {
      details: { count: number };
      content: Array<{ text: string }>;
    };
    expect(result.details.count).toBe(0);
    expect(result.content[0].text).toBe("Provide a query.");
  });

  it("MEMORY_TOOL_EXPECTED_ARG_KEYS matches each tool's real parameter schema key (#59)", () => {
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.memory_verify).toEqual(["factId"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.memory_provenance).toEqual(["factId"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.goal_get).toEqual(["goal_id"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.goal_assess).toEqual(["goal_id"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.goal_update).toEqual(["goal_id"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.goal_complete).toEqual(["goal_id"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.goal_abandon).toEqual(["goal_id"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.active_task_get).toEqual(["task_label"]);
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.active_task_propose_goal).toEqual(["task_label"]);
  });

  it("does not misflag a genuine call using each tool's real argument key as wrapper-dropped (#59)", async () => {
    const genuineArgs: Record<string, Record<string, unknown>> = {
      memory_verify: { factId: "fact-uuid" },
      memory_provenance: { factId: "fact-uuid" },
      goal_get: { goal_id: "goal-uuid" },
      goal_assess: { goal_id: "goal-uuid" },
      goal_update: { goal_id: "goal-uuid" },
      goal_complete: { goal_id: "goal-uuid" },
      goal_abandon: { goal_id: "goal-uuid" },
      active_task_get: { task_label: "my-task" },
      active_task_propose_goal: { task_label: "my-task" },
    };

    for (const [toolName, args] of Object.entries(genuineArgs)) {
      const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }));
      const wrapped = wrapMemoryToolExecuteForWrapperArgs(toolName, execute);
      await wrapped("tc", args);
      expect(execute, `${toolName} should not be treated as wrapper-dropped`).toHaveBeenCalled();
    }
  });

  it("does not misflag a genuine memory_workshop approve/reject/quarantine/revise/undo/inspect call as wrapper-dropped (loop iteration 38 regression)", async () => {
    expect(MEMORY_TOOL_EXPECTED_ARG_KEYS.memory_workshop).toEqual(["id", "ordinal"]);

    const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text", text: "ok" }],
      details: { ok: true },
    }));
    const wrapped = wrapMemoryToolExecuteForWrapperArgs("memory_workshop", execute);
    // Before memory_workshop was added to MEMORY_TOOL_EXPECTED_ARG_KEYS, it fell back to
    // "sentinel_only" mode, which flags ANY call containing an "id" key regardless of value —
    // silently intercepting every approve/reject/quarantine/revise/undo/inspect call before
    // execute() ever ran.
    const result = (await wrapped("tc", { action: "approve", id: "crystallize:abc123" })) as {
      details: { ok: boolean };
    };
    expect(execute).toHaveBeenCalled();
    expect(result.details.ok).toBe(true);
  });

  it("wrapMemoryToolExecuteForWrapperArgs applies sentinel-only mode to unmapped memory_* tools", async () => {
    const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text", text: "ok" }],
      details: {},
    }));
    const wrapped = wrapMemoryToolExecuteForWrapperArgs("memory_health", execute);
    const result = (await wrapped("tc", { toolName: "memory_health", arguments: "{}" })) as {
      details: { error: string };
    };
    expect(result.details.error).toBe("wrapper_args_dropped");
    expect(execute).not.toHaveBeenCalled();
  });
});
