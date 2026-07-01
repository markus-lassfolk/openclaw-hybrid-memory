import { describe, expect, it, vi } from "vitest";
import { hasBoundMemoryToolHelpers, resolveMemoryToolsContext } from "../tools/memory/helpers.js";
import type { MemoryToolsContext } from "../tools/memory/types.js";

describe("hasBoundMemoryToolHelpers (#1938)", () => {
  const boundHelpers = {
    buildToolScopeFilter: vi.fn(),
    walWrite: vi.fn(),
    walRemove: vi.fn(),
    findSimilarByEmbedding: vi.fn(),
  };

  it("accepts pre-bound helpers when wal is also present on the context", () => {
    const ctx = { wal: { kind: "wal" }, ...boundHelpers } as unknown as MemoryToolsContext;
    expect(hasBoundMemoryToolHelpers(ctx)).toBe(true);
    expect(() => resolveMemoryToolsContext(ctx)).not.toThrow();
  });

  it("rejects legacy context without bound helpers even when wal is present", () => {
    const legacyCtx = { wal: { kind: "wal" }, factsDb: {} } as unknown as MemoryToolsContext;
    expect(hasBoundMemoryToolHelpers(legacyCtx)).toBe(false);
    expect(() => resolveMemoryToolsContext(legacyCtx)).toThrow(
      "registerMemoryTools: Missing required legacy helper functions for memory tools initialization.",
    );
  });
});
