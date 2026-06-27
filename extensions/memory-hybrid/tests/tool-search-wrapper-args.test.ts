import { describe, expect, it, vi } from "vitest";
import {
  buildToolSearchWrapperDroppedArgsResponse,
  isToolSearchWrapperDroppedArgs,
  wrapMemoryToolExecuteForWrapperArgs,
} from "../utils/tool-search-wrapper-args.js";

describe("tool-search-wrapper-args (#1973)", () => {
  it("detects completely empty params as wrapper-dropped", () => {
    expect(isToolSearchWrapperDroppedArgs({}, ["query", "id"])).toBe(true);
    expect(isToolSearchWrapperDroppedArgs(null, ["query"])).toBe(true);
    expect(isToolSearchWrapperDroppedArgs(undefined, ["text"])).toBe(true);
  });

  it("detects wrapper-only flattened params without tool args", () => {
    expect(
      isToolSearchWrapperDroppedArgs({ id: "toolu_123", command: "memory_recall" }, ["query", "id"]),
    ).toBe(true);
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
    const response = buildToolSearchWrapperDroppedArgsResponse("memory_recall", {});
    expect(response.details.error).toBe("wrapper_args_dropped");
    expect(response.details.event).toBe("wrapper_args_dropped");
    expect(response.content[0].text).toContain("#96115");
    expect(response.content[0].text).toContain("openclaw/openclaw/issues/96115");
  });

  it("wrapMemoryToolExecuteForWrapperArgs upgrades silent missing-arg failures", async () => {
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "Provide a query." }],
      details: { count: 0 },
    }));
    const wrapped = wrapMemoryToolExecuteForWrapperArgs("memory_keyword_recall", execute, logger);
    const result = await wrapped("tc", {});
    expect(result.details.error).toBe("wrapper_args_dropped");
    expect(logger.warn).toHaveBeenCalledWith(
      "memory-hybrid: memory_keyword_recall wrapper args dropped",
      expect.objectContaining({ event: "wrapper_args_dropped" }),
    );
  });

  it("wrapMemoryToolExecuteForWrapperArgs preserves intentional empty query message", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "Provide a query." }],
      details: { count: 0 },
    }));
    const wrapped = wrapMemoryToolExecuteForWrapperArgs("memory_keyword_recall", execute);
    const result = await wrapped("tc", { query: "" });
    expect(result.details.count).toBe(0);
    expect(result.content[0].text).toBe("Provide a query.");
  });
});
