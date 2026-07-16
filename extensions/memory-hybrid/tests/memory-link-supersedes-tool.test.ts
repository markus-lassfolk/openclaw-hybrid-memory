/**
 * Integration regression for #2139: memory_link must accept two valid fact UUIDs and
 * type=SUPERSEDES without a SQLite binding error, and must return a structured, parameter-named
 * error (never bind `undefined` to SQLite) when the caller uses the wrong argument names.
 */
import { describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { registerGraphTools } from "../tools/graph-tools.js";

type FakeFact = { id: string; text: string; scope: string; scopeTarget: string | null };

function setup(facts: FakeFact[]) {
  const factMap = new Map(facts.map((f) => [f.id, f]));
  const createLink = vi.fn(() => "new-link-id");
  const getById = vi.fn((id: string) => {
    // Mirror node:sqlite: binding a non-string/undefined id throws a bind error. This is exactly
    // the failure the tool must prevent by validating input before it reaches the DB.
    if (typeof id !== "string") {
      throw new TypeError("Provided value cannot be bound to SQLite parameter 1.");
    }
    return factMap.get(id) ?? null;
  });
  const factsDb = { getById, createLink, recordContradiction: vi.fn(() => "c-id") };

  const cfg = hybridConfigSchema.parse({ embedding: { provider: "onnx", model: "bge-m3", dimensions: 1024 } });
  cfg.graph.enabled = true;

  const tools = new Map<string, { execute: (...a: unknown[]) => unknown }>();
  const api = {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...a: unknown[]) => unknown });
    },
  };
  registerGraphTools(
    { factsDb: factsDb as never, cfg, currentAgentIdRef: { value: null }, buildToolScopeFilter: () => undefined },
    api as never,
  );
  return { link: tools.get("memory_link"), factsDb, createLink };
}

const SRC: FakeFact = {
  id: "b9cc40ed-1675-47af-93eb-97e9e33b847d",
  text: "current correction",
  scope: "global",
  scopeTarget: null,
};
const TGT: FakeFact = {
  id: "047efc02-b019-4236-8843-5cf4724e3db0",
  text: "stale gateway fact",
  scope: "global",
  scopeTarget: null,
};

describe("memory_link SUPERSEDES input handling (#2139)", () => {
  it("creates a SUPERSEDES link between two valid fact UUIDs", async () => {
    const { link, createLink } = setup([SRC, TGT]);
    const result = (await link?.execute("call-1", {
      sourceFact: SRC.id,
      targetFact: TGT.id,
      linkType: "SUPERSEDES",
    })) as { details: Record<string, unknown> };
    expect(createLink).toHaveBeenCalledWith(SRC.id, TGT.id, "SUPERSEDES", 1.0);
    expect(result.details.linkType).toBe("SUPERSEDES");
  });

  it("accepts the from/to/type aliases and still links successfully", async () => {
    const { link, createLink } = setup([SRC, TGT]);
    const result = (await link?.execute("call-1", {
      from: SRC.id,
      to: TGT.id,
      type: "SUPERSEDES",
      why: "supersedes stale fact",
    })) as { details: Record<string, unknown> };
    expect(createLink).toHaveBeenCalledWith(SRC.id, TGT.id, "SUPERSEDES", 1.0);
    expect(result.details.linkType).toBe("SUPERSEDES");
  });

  it("returns a structured validation error (no SQLite bind exception) when ids are missing", async () => {
    const { link, factsDb, createLink } = setup([SRC, TGT]);
    let result: { details: Record<string, unknown>; content: Array<{ text: string }> } | undefined;
    await expect(
      (async () => {
        result = (await link?.execute("call-1", { sourceFact: SRC.id, linkType: "SUPERSEDES" })) as typeof result;
      })(),
    ).resolves.toBeUndefined();
    expect(result?.details.error).toBe("invalid_input");
    expect(result?.content[0]?.text).toContain("targetFact");
    // Critically: the DB was never touched with an undefined id.
    expect(factsDb.getById).not.toHaveBeenCalled();
    expect(createLink).not.toHaveBeenCalled();
  });
});
