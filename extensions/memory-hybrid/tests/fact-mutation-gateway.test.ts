import { describe, expect, it, vi, beforeEach } from "vitest";
import { registerFactMutationGatewayMethods } from "../tools/fact-mutation-gateway.js";
import type { MemoryEntry } from "../types/memory.js";

function makeFact(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "aabb0011-0000-0000-0000-000000000001",
    text: "React uses a virtual DOM",
    category: "technical",
    importance: 0.8,
    entity: "React",
    key: "architecture",
    value: "virtual DOM",
    source: "conversation",
    createdAt: 1717200000,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1717200000,
    confidence: 0.9,
    ...overrides,
  };
}

type HandlerFn = (opts: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: { message: string }) => void;
}) => void | Promise<void>;

function captureHandlers(cfg?: { mutationsEnabled?: boolean }) {
  const handlers = new Map<string, HandlerFn>();
  const api = {
    registerGatewayMethod: vi.fn((method: string, handler: HandlerFn) => {
      handlers.set(method, handler);
    }),
    context: { userId: "test-user", agentId: "test-agent" },
  };
  const factsDb = {
    search: vi.fn(),
    lookup: vi.fn(),
    getAll: vi.fn(() => []),
    getById: vi.fn(),
    store: vi.fn(),
    supersede: vi.fn(),
    setConfidenceTo: vi.fn(),
  } as any;

  registerFactMutationGatewayMethods({
    cfg: {
      wikiIntegration: {
        mutations: { enabled: cfg?.mutationsEnabled ?? true },
      },
      multiAgent: { orchestratorId: "test-agent", trustToolScopeParams: false },
      autoRecall: {},
    } as any,
    factsDb,
    api: api as any,
  });

  return { handlers, api, factsDb };
}

describe("fact-mutation-gateway", () => {
  describe("registration", () => {
    it("skips registration when mutations disabled", () => {
      const { handlers } = captureHandlers({ mutationsEnabled: false });
      expect(handlers.size).toBe(0);
    });

    it("registers all five RPC methods", () => {
      const { handlers } = captureHandlers();
      expect(handlers.has("hybrid-mem.facts.list")).toBe(true);
      expect(handlers.has("hybrid-mem.facts.get")).toBe(true);
      expect(handlers.has("hybrid-mem.facts.update")).toBe(true);
      expect(handlers.has("hybrid-mem.facts.supersede")).toBe(true);
      expect(handlers.has("hybrid-mem.facts.create")).toBe(true);
    });
  });

  describe("hybrid-mem.facts.list", () => {
    it("returns all facts when no query or entity specified", async () => {
      const fact = makeFact();
      const { handlers, factsDb } = captureHandlers();
      factsDb.getAll.mockReturnValue([fact]);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.list")!({ params: {}, respond });

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          count: 1,
          facts: expect.arrayContaining([expect.objectContaining({ id: fact.id })]),
        }),
      );
    });

    it("searches by query when provided", async () => {
      const fact = makeFact();
      const { handlers, factsDb } = captureHandlers();
      factsDb.search.mockReturnValue([{ entry: fact, score: 0.9 }]);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.list")!({ params: { query: "React" }, respond });

      expect(factsDb.search).toHaveBeenCalledWith("React", 20, expect.any(Object));
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ count: 1 }));
    });

    it("looks up by entity when provided", async () => {
      const fact = makeFact();
      const { handlers, factsDb } = captureHandlers();
      factsDb.lookup.mockReturnValue([{ entry: fact, score: 1 }]);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.list")!({ params: { entity: "React" }, respond });

      expect(factsDb.lookup).toHaveBeenCalledWith("React", undefined, undefined, expect.any(Object));
    });

    it("clamps a negative limit to the [1,100] range instead of removing the pagination cap (loop iteration 117 regression)", async () => {
      const { handlers, factsDb } = captureHandlers();
      factsDb.search.mockReturnValue([]);

      // Before the fix, a negative limit reached lookupFacts()/search() as-is: lookupFacts()
      // treats a non-positive limit as `null` (dropping its SQL LIMIT clause entirely, returning
      // every matching row) and the no-query/no-entity branch's `getAll().slice(0, -1)` returns
      // nearly the whole in-scope corpus -- defeating the intended 20-default/100-max cap.
      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.list")!({ params: { query: "React", limit: -1 }, respond });

      expect(factsDb.search).toHaveBeenCalledWith("React", expect.any(Number), expect.any(Object));
      const usedLimit = factsDb.search.mock.calls[0]?.[1];
      expect(usedLimit).toBeGreaterThanOrEqual(1);
      expect(usedLimit).toBeLessThanOrEqual(100);
    });

    it("clamps an overflow limit to 100 as before", async () => {
      const { handlers, factsDb } = captureHandlers();
      factsDb.search.mockReturnValue([]);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.list")!({ params: { query: "React", limit: 99999 }, respond });

      expect(factsDb.search).toHaveBeenCalledWith("React", 100, expect.any(Object));
    });
  });

  describe("hybrid-mem.facts.get", () => {
    it("returns a fact by ID", async () => {
      const fact = makeFact();
      const { handlers, factsDb } = captureHandlers();
      factsDb.getById.mockReturnValue(fact);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.get")!({ params: { id: fact.id }, respond });

      expect(respond).toHaveBeenCalledWith(true, {
        fact: expect.objectContaining({ id: fact.id, text: fact.text }),
      });
    });

    it("responds with error for missing ID", async () => {
      const { handlers } = captureHandlers();
      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.get")!({ params: {}, respond });

      expect(respond).toHaveBeenCalledWith(false, undefined, { message: "missing id" });
    });

    it("responds with error when fact not found", async () => {
      const { handlers, factsDb } = captureHandlers();
      factsDb.getById.mockReturnValue(null);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.get")!({ params: { id: "nonexistent" }, respond });

      expect(respond).toHaveBeenCalledWith(false, undefined, { message: "not found" });
    });
  });

  describe("hybrid-mem.facts.update", () => {
    it("supersedes existing fact with structural changes", async () => {
      const existing = makeFact();
      const updated = makeFact({ id: "aabb0011-0000-0000-0000-000000000002", text: "React uses fiber" });
      const { handlers, factsDb } = captureHandlers();
      factsDb.getById.mockReturnValueOnce(existing).mockReturnValueOnce(updated);
      factsDb.store.mockReturnValue(updated);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.update")!({
        params: { id: existing.id, text: "React uses fiber" },
        respond,
      });

      expect(factsDb.store).toHaveBeenCalledWith(expect.objectContaining({ text: "React uses fiber" }));
      expect(factsDb.supersede).toHaveBeenCalledWith(existing.id, updated.id);
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ superseded: existing.id }));
    });

    it("updates confidence without structural change", async () => {
      const existing = makeFact();
      const afterUpdate = makeFact({ confidence: 0.5 });
      const { handlers, factsDb } = captureHandlers();
      factsDb.getById.mockReturnValueOnce(existing).mockReturnValueOnce(afterUpdate);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.update")!({
        params: { id: existing.id, confidence: 0.5 },
        respond,
      });

      expect(factsDb.setConfidenceTo).toHaveBeenCalledWith(existing.id, 0.5);
      expect(factsDb.store).not.toHaveBeenCalled();
    });

    it("returns noop when no changes provided", async () => {
      const existing = makeFact();
      const { handlers, factsDb } = captureHandlers();
      factsDb.getById.mockReturnValue(existing);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.update")!({ params: { id: existing.id }, respond });

      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ noop: true }));
    });
  });

  describe("hybrid-mem.facts.supersede", () => {
    it("supersedes with replacement text", async () => {
      const existing = makeFact();
      const replacement = makeFact({ id: "aabb0011-0000-0000-0000-000000000003", text: "New text" });
      const { handlers, factsDb } = captureHandlers();
      factsDb.getById.mockReturnValue(existing);
      factsDb.store.mockReturnValue(replacement);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.supersede")!({
        params: { id: existing.id, replacementText: "New text" },
        respond,
      });

      expect(factsDb.store).toHaveBeenCalledWith(expect.objectContaining({ text: "New text" }));
      expect(factsDb.supersede).toHaveBeenCalledWith(existing.id, replacement.id);
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ superseded: existing.id }));
    });

    it("removes fact without replacement", async () => {
      const existing = makeFact();
      const { handlers, factsDb } = captureHandlers();
      factsDb.getById.mockReturnValue(existing);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.supersede")!({
        params: { id: existing.id },
        respond,
      });

      expect(factsDb.supersede).toHaveBeenCalledWith(existing.id, null);
      expect(respond).toHaveBeenCalledWith(true, { superseded: existing.id });
    });
  });

  describe("hybrid-mem.facts.create", () => {
    it("creates a new fact with all parameters", async () => {
      const stored = makeFact({ id: "aabb0011-0000-0000-0000-000000000004", source: "wiki-create" });
      const { handlers, factsDb } = captureHandlers();
      factsDb.store.mockReturnValue(stored);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.create")!({
        params: {
          text: "New discovery",
          category: "fact",
          importance: 0.7,
          entity: "Testing",
          key: "insight",
          confidence: 0.85,
          tags: ["manual"],
        },
        respond,
      });

      expect(factsDb.store).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "New discovery",
          category: "fact",
          importance: 0.7,
          entity: "Testing",
          key: "insight",
          confidence: 0.85,
          tags: ["manual"],
          source: "wiki-create",
        }),
      );
      expect(respond).toHaveBeenCalledWith(true, { fact: expect.objectContaining({ id: stored.id }) });
    });

    it("rejects empty text", async () => {
      const { handlers } = captureHandlers();
      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.create")!({ params: { text: "" }, respond });

      expect(respond).toHaveBeenCalledWith(false, undefined, { message: "missing text" });
    });

    it("rejects an unknown category instead of storing it verbatim", async () => {
      const { handlers, factsDb } = captureHandlers();
      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.create")!({
        params: { text: "Bogus category fact", category: "not_a_real_category" },
        respond,
      });

      expect(respond).toHaveBeenCalledWith(false, undefined, { message: 'invalid category "not_a_real_category"' });
      expect(factsDb.store).not.toHaveBeenCalled();
    });

    it("clamps out-of-range importance to [0,1] like confidence (loop iteration 80 regression)", async () => {
      const stored = makeFact({ id: "aabb0011-0000-0000-0000-000000000006" });
      const { handlers, factsDb } = captureHandlers();
      factsDb.store.mockReturnValue(stored);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.create")!({
        params: { text: "Overconfident fact", importance: 1.5, confidence: -3 },
        respond,
      });

      expect(factsDb.store).toHaveBeenCalledWith(
        expect.objectContaining({
          importance: 1,
          confidence: 0,
        }),
      );
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ fact: expect.anything() }));
    });

    it("uses defaults for optional parameters", async () => {
      const stored = makeFact({ id: "aabb0011-0000-0000-0000-000000000005" });
      const { handlers, factsDb } = captureHandlers();
      factsDb.store.mockReturnValue(stored);

      const respond = vi.fn();
      await handlers.get("hybrid-mem.facts.create")!({
        params: { text: "Minimal fact" },
        respond,
      });

      expect(factsDb.store).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Minimal fact",
          category: "other",
          importance: 0.5,
          confidence: 0.8,
        }),
      );
    });
  });
});
