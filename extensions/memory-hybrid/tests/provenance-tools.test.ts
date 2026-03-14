/**
 * Tests for provenance tools and automatic edge creation (Issue #163).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerProvenanceTools } from "../tools/provenance-tools.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { runConsolidate } from "../services/consolidation.js";
import { hybridConfigSchema } from "../config.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import { _testing } from "../index.js";

const { FactsDB, ProvenanceService, EventLog } = _testing;

function makeMockApi(sessionId = "sess-1") {
  const tools = new Map<string, { opts: Record<string, unknown>; execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>, _options?: Record<string, unknown>) {
      tools.set(opts.name as string, {
        opts,
        execute: opts.execute as (...args: unknown[]) => unknown,
      });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    callTool(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute("test-call-id", params);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    context: { sessionId },
  };
}

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let provenanceService: InstanceType<typeof ProvenanceService>;
let eventLog: InstanceType<typeof EventLog>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "prov-tools-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  provenanceService = new ProvenanceService(join(tmpDir, "provenance.db"));
  eventLog = new EventLog(join(tmpDir, "events.db"));
});

afterEach(() => {
  provenanceService.close();
  eventLog.close();
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_provenance tool", () => {
  it("returns derivedFrom + consolidationChain for a fact", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
      provenance: { enabled: true },
    });
    cfg.provenance!.enabled = true; // 2026.3.140 migration forces off; override to test feature
    const api = makeMockApi("sess-123");

    registerProvenanceTools({ factsDb, eventLog, provenanceService, cfg }, api as any);

    const sourceFact = factsDb.store({
      text: "User likes tea",
      category: "fact",
      importance: 0.6,
      entity: "User",
      key: "preference",
      value: "tea",
      source: "conversation",
    });

    const consolidatedFact = factsDb.store({
      text: "User prefers tea",
      category: "fact",
      importance: 0.8,
      entity: "User",
      key: "preference",
      value: "tea",
      source: "conversation",
      provenanceSession: "sess-123",
      extractionMethod: "active",
      extractionConfidence: 0.8,
    });

    const eventId = eventLog.append({
      sessionId: "sess-123",
      timestamp: "2025-01-01T00:00:00.000Z",
      eventType: "fact_learned",
      content: { text: "User likes tea" },
    });

    provenanceService.addEdge(consolidatedFact.id, {
      edgeType: "DERIVED_FROM",
      sourceType: "event_log",
      sourceId: eventId,
      sourceText: "User likes tea",
    });
    provenanceService.addEdge(consolidatedFact.id, {
      edgeType: "CONSOLIDATED_FROM",
      sourceType: "consolidation",
      sourceId: sourceFact.id,
      sourceText: sourceFact.text,
    });

    const result = (await api.callTool("memory_provenance", { factId: consolidatedFact.id })) as any;
    const chain = result.details.provenance;

    expect(chain.fact.id).toBe(consolidatedFact.id);
    expect(chain.source.session_id).toBe("sess-123");
    expect(chain.derivedFrom).toHaveLength(1);
    expect(chain.derivedFrom[0].event_id).toBe(eventId);
    expect(chain.derivedFrom[0].event_text).toBe("User likes tea");
    expect(chain.derivedFrom[0].timestamp).toBe("2025-01-01T00:00:00.000Z");
    expect(chain.consolidationChain).toHaveLength(1);
    expect(chain.consolidationChain[0].fact.id).toBe(sourceFact.id);
  });

  it("recursively follows derived_from and consolidation chains", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
      provenance: { enabled: true },
    });
    cfg.provenance!.enabled = true; // 2026.3.140 migration forces off; override to test feature
    const api = makeMockApi("sess-abc");

    registerProvenanceTools({ factsDb, eventLog, provenanceService, cfg }, api as any);

    const factC = factsDb.store({
      text: "C: User likes coffee",
      category: "fact",
      importance: 0.5,
      entity: "User",
      key: "preference",
      value: "coffee",
      source: "conversation",
    });
    const factD = factsDb.store({
      text: "D: User likes espresso",
      category: "fact",
      importance: 0.5,
      entity: "User",
      key: "preference",
      value: "espresso",
      source: "conversation",
    });
    const factB = factsDb.store({
      text: "B: User prefers coffee drinks",
      category: "fact",
      importance: 0.7,
      entity: "User",
      key: "preference",
      value: "coffee drinks",
      source: "conversation",
    });
    const factA = factsDb.store({
      text: "A: User is a coffee fan",
      category: "fact",
      importance: 0.8,
      entity: "User",
      key: "preference",
      value: "coffee fan",
      source: "conversation",
    });

    provenanceService.addEdge(factA.id, {
      edgeType: "DERIVED_FROM",
      sourceType: "consolidation",
      sourceId: factB.id,
      sourceText: factB.text,
    });
    provenanceService.addEdge(factB.id, {
      edgeType: "CONSOLIDATED_FROM",
      sourceType: "consolidation",
      sourceId: factC.id,
      sourceText: factC.text,
    });
    provenanceService.addEdge(factB.id, {
      edgeType: "CONSOLIDATED_FROM",
      sourceType: "consolidation",
      sourceId: factD.id,
      sourceText: factD.text,
    });

    const result = (await api.callTool("memory_provenance", { factId: factA.id })) as any;
    const chain = result.details.provenance;

    expect(chain.derivedFrom).toHaveLength(1);
    const derived = chain.derivedFrom[0];
    expect(derived.event_id).toBe(factB.id);
    expect(derived.fact_chain?.fact.id).toBe(factB.id);
    expect(derived.fact_chain?.consolidationChain).toHaveLength(2);
    const consolidationIds = (derived.fact_chain?.consolidationChain ?? []).map((entry: any) => entry.fact.id).sort();
    expect(consolidationIds).toEqual([factC.id, factD.id].sort());
  });
});

describe("memory_store provenance", () => {
  it("creates DERIVED_FROM edges for active stores", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
      provenance: { enabled: true },
      graph: { enabled: false },
      aliases: { enabled: false },
      store: { classifyBeforeWrite: false },
    });
    cfg.provenance!.enabled = true; // 2026.3.140 migration forces off; override to test feature

    const api = makeMockApi("sess-999");
    const vectorDb = {
      hasDuplicate: vi.fn(async () => false),
      store: vi.fn(async () => undefined),
    };
    const embeddings = {
      embed: vi.fn(async () => [0.1, 0.2, 0.3]),
      modelName: "test-embed",
    };

    registerMemoryTools(
      {
        factsDb,
        vectorDb: vectorDb as never,
        cfg,
        embeddings: embeddings as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        provenanceService,
        aliasDb: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "agent-1" },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api as any,
      buildToolScopeFilter,
      () => "wal-1",
      () => undefined,
      async () => [],
    );

    const result = (await api.callTool("memory_store", {
      text: "Remember this test fact",
      importance: 0.7,
    })) as any;

    const factId = result.details.id as string;
    const edges = provenanceService.getEdges(factId);
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeType).toBe("DERIVED_FROM");
    expect(edges[0].sourceType).toBe("active_store");
    expect(edges[0].sourceId).toBe("sess-999");
  });
});

describe("consolidation provenance chain", () => {
  it("records CONSOLIDATED_FROM edges for merged facts", async () => {
    const source1 = factsDb.store({
      text: "The sky appears blue during daylight hours",
      category: "fact",
      importance: 0.6,
      entity: "sky",
      key: null,
      value: null,
      source: "conversation",
    });
    const source2 = factsDb.store({
      text: "Sky looks blue when sun is up",
      category: "fact",
      importance: 0.6,
      entity: "sky",
      key: null,
      value: null,
      source: "conversation",
    });

    const embeddings = {
      embed: vi.fn(async () => [1, 0, 0]),
      modelName: "test-embed",
    };
    const vectorDb = { store: vi.fn(async () => undefined) };
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "The sky is blue during daylight." } }],
          })),
        },
      },
    } as never;

    await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.99, includeStructured: false, dryRun: false, limit: 100, model: "gpt-4o" },
      { info: () => undefined, warn: () => undefined },
      null,
      provenanceService,
    );

    const remainingFacts = factsDb.getByCategory("fact");
    const mergedFact = remainingFacts.find((f) => f.id !== source1.id && f.id !== source2.id);
    expect(mergedFact).toBeDefined();

    const edges = provenanceService.getEdges(mergedFact!.id);
    const consolidatedFrom = edges.filter((e) => e.edgeType === "CONSOLIDATED_FROM");
    const sourceIds = consolidatedFrom.map((e) => e.sourceId).sort();

    expect(sourceIds).toEqual([source1.id, source2.id].sort());
  });
});
