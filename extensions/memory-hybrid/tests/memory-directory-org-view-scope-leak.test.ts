// @ts-nocheck
/**
 * Regression test (#2067-followup) for tools/memory/register-directory-tools.ts's
 * memory_directory org_view operation:
 *
 * When a fact linked to an organization failed the caller's scope check, org_view kept the raw
 * fact id in its response (`{ id, text: "(missing)", category: "?" }`) instead of omitting the
 * entry entirely. An id in the response still discloses that id's existence and its org-linkage
 * to a caller who cannot otherwise see it -- the same leak the sibling memory_graph tool's
 * `if (!t) continue` guard is built to prevent. Now filtered out entirely, matching that
 * convention.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { buildEmbeddingRegistry } from "../services/embedding-registry.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
  };
}

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-directory-org-view-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("memory_directory org_view scope leak (#2067-followup)", () => {
  it("omits an out-of-scope linked fact instead of leaking its raw id", async () => {
    const org = factsDb.upsertOrganization("Acme Corp");
    expect(org).not.toBeNull();
    const orgId = org?.id as string;

    const ownFact = factsDb.store({
      text: "Tenant A's own fact about Acme",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantA",
    });
    const foreignFact = factsDb.store({
      text: "Tenant B's private fact about Acme",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantB",
    });
    factsDb.linkFactToOrganization(orgId, ownFact.id, "test-fixture");
    factsDb.linkFactToOrganization(orgId, foreignFact.id, "test-fixture");

    const api = makeMockApi();
    const cfg = hybridConfigSchema.parse({ embedding: { provider: "onnx", model: "bge-m3", dimensions: 1024 } });
    const embeddingRegistry = buildEmbeddingRegistry(
      { modelName: "bge-m3", dimensions: 4, embed: vi.fn(), embedBatch: vi.fn() } as never,
      "bge-m3",
      [],
    );

    registerMemoryTools(
      {
        factsDb,
        vectorDb: {} as never,
        cfg,
        embeddings: {} as never,
        embeddingRegistry,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "tenantA" },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api as never,
      ((_params: unknown, currentAgent: string | null) =>
        currentAgent ? { agentId: currentAgent } : undefined) as never,
      async () => "wal-id",
      async () => {},
      async () => [],
    );

    const tool = api.getTool("memory_directory");
    expect(tool).toBeTruthy();

    const result = (await tool?.execute("call-1", { operation: "org_view", org_name: "Acme Corp" })) as {
      content: Array<{ text: string }>;
      details: { facts: Array<{ id: string }> };
    };

    const returnedIds = result.details.facts.map((f) => f.id);
    expect(returnedIds).toContain(ownFact.id);
    expect(returnedIds).not.toContain(foreignFact.id);
    expect(result.content[0].text).not.toContain(foreignFact.id);
    expect(result.content[0].text).not.toContain("(missing)");
  });
});
