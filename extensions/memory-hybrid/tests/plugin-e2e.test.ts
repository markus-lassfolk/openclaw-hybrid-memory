/**
 * End-to-end tests for full plugin functionality verification.
 *
 * Ensures:
 * - Plugin registration succeeds and core tools are registered
 * - Store → recall by id → recall by query flow works with real FactsDB + VectorDB
 * - No surprises: expected response shapes and persistence across tool calls
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueStore } from "../backends/issue-store.js";
import { hybridConfigSchema } from "../config.js";
import memoryHybridPlugin from "../index.js";
import { _testing } from "../index.js";
import { closeOldDatabases, initializeDatabases } from "../setup/init-databases.js";
import { registerTools } from "../setup/register-tools.js";

const { FactsDB, VectorDB, findSimilarByEmbedding, VerificationStore } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 1536; // text-embedding-3-small

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>, _options?: unknown) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    registerService: vi.fn(),
    registerCli: vi.fn(),
    registerLifecycleHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "e2e-session", agentId: "e2e-agent" },
    config: {},
  };
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: EMBEDDING_DIM,
    modelName: "text-embedding-3-small",
    activeProvider: "openai",
  };
}

/** Minimal valid config (same as config.test.ts validBase). */
function getMinimalConfig(overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    ...overrides,
  });
}

/** Build full tools context for e2e (optional stores and config overrides). */
function buildE2EContext(opts: {
  tmpDir: string;
  factsDb: InstanceType<typeof FactsDB>;
  vectorDb: InstanceType<typeof VectorDB>;
  cfg: ReturnType<typeof getMinimalConfig>;
  api: ReturnType<typeof makeMockApi>;
  embeddings?: ReturnType<typeof makeMockEmbeddings>;
  issueStore?: InstanceType<typeof IssueStore> | null;
  verificationStore?: InstanceType<typeof VerificationStore> | null;
}) {
  const {
    tmpDir,
    factsDb,
    vectorDb,
    cfg,
    api,
    embeddings = makeMockEmbeddings(),
    issueStore = null,
    verificationStore = null,
  } = opts;
  return {
    factsDb,
    vectorDb,
    cfg,
    embeddings,
    embeddingRegistry: null,
    openai: { chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [] }) } } },
    wal: null,
    credentialsDb: null,
    proposalsDb: null,
    eventLog: null,
    provenanceService: null,
    aliasDb: null,
    issueStore: issueStore ?? null,
    workflowStore: null,
    crystallizationStore: null,
    toolProposalStore: null,
    verificationStore: verificationStore ?? null,
    variantQueue: null,
    lastProgressiveIndexIds: [] as string[],
    currentAgentIdRef: { value: "e2e-agent" },
    pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) },
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    timers: { proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null } },
    buildToolScopeFilter: () => undefined,
    walWrite: async () => "wal-id",
    walRemove: async () => undefined,
    findSimilarByEmbedding,
    runReflection: vi.fn().mockResolvedValue({ patterns: [], meta: {} }),
    runReflectionRules: vi.fn().mockResolvedValue({ patterns: [] }),
    runReflectionMeta: vi.fn().mockResolvedValue({}),
    pythonBridge: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Plugin registration e2e: register() succeeds and core tools are present
// ---------------------------------------------------------------------------

describe("Plugin registration e2e", () => {
  let tmpDir: string;
  let api: ReturnType<typeof makeMockApi>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-reg-"));
    api = makeMockApi();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("register() does not throw and core memory tools are registered", () => {
    const pluginConfig = getMinimalConfig({
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
    });
    const mockApi = {
      ...api,
      pluginConfig,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    };
    expect(() => memoryHybridPlugin.register(mockApi as never)).not.toThrow();

    expect(mockApi.getTool("memory_store")).toBeDefined();
    expect(mockApi.getTool("memory_recall")).toBeDefined();
    expect(mockApi.getTool("memory_recall_timeline")).toBeDefined();
    expect(mockApi.getTool("memory_forget")).toBeDefined();
    expect(mockApi.getTool("memory_promote")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Store → recall (by id) → recall (by query) with real DBs and mock embeddings
// ---------------------------------------------------------------------------

describe("Store and recall e2e (real FactsDB + VectorDB, mock embeddings)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  let api: ReturnType<typeof makeMockApi>;
  let cfg: ReturnType<typeof getMinimalConfig>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-store-recall-"));
    const sqlitePath = join(tmpDir, "facts.db");
    const lancePath = join(tmpDir, "lancedb");
    cfg = getMinimalConfig({
      sqlitePath,
      lanceDbPath: lancePath,
      store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    });
    factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false });
    vectorDb = new VectorDB(lancePath, EMBEDDING_DIM, false);
    api = makeMockApi();
  });

  afterEach(() => {
    vectorDb.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_store then memory_recall by id returns the stored fact", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);

    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    expect(storeTool).toBeDefined();
    expect(recallTool).toBeDefined();

    const text = "E2E test fact: server IP is 10.0.0.42";
    const storeResult = (await storeTool?.execute("call-1", {
      text,
      importance: 0.8,
      category: "fact",
    })) as { content?: { type: string; text: string }[]; details?: { id?: string; action?: string } };

    expect(storeResult.details?.id).toBeDefined();
    expect(storeResult.details?.action).toBe("created");
    const factId = storeResult.details?.id!;

    const recallByIdResult = (await recallTool?.execute("call-2", { id: factId })) as {
      content?: { type: string; text: string }[];
      details?: { count: number; memories?: { id: string; text: string }[] };
    };
    expect(recallByIdResult.details?.count).toBe(1);
    expect(recallByIdResult.details?.memories?.[0]?.text).toBe(text);
    expect(recallByIdResult.content?.[0]?.text).toContain(text);
  });

  it("memory_store accepts why and memory_recall returns lineage context", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);

    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    const text = "Switch deployment to blue/green rollout";
    const why = "Previous in-place deploy caused a 12-minute outage during rollback";

    const storeResult = (await storeTool?.execute("call-why-1", {
      text,
      why,
      category: "decision",
      importance: 0.9,
    })) as { details?: { id?: string; why?: string } };
    const factId = storeResult.details?.id;
    expect(storeResult.details?.why).toBe(why);
    expect(factId).toBeDefined();

    const recallByIdResult = (await recallTool?.execute("call-why-2", { id: factId })) as {
      content?: { type: string; text: string }[];
      details?: { count: number; memories?: { id: string; text: string; why?: string }[] };
    };
    expect(recallByIdResult.details?.count).toBe(1);
    expect(recallByIdResult.details?.memories?.[0]?.why).toBe(why);
    expect(recallByIdResult.content?.[0]?.text).toContain(`Why: ${why}`);

    const recallByQueryResult = (await recallTool?.execute("call-why-3", {
      query: "blue green rollout",
      limit: 5,
    })) as {
      content?: { type: string; text: string }[];
      details?: { memories?: { text: string; why?: string }[] };
    };
    const matched = (recallByQueryResult.details?.memories ?? []).find((m) => m.text.includes(text));
    expect(matched?.why).toBe(why);
    expect(recallByQueryResult.content?.[0]?.text).toContain(`Why: ${why}`);
  });

  it("memory_recall by query returns the stored fact (semantic path)", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);

    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    const uniqueText = "E2E unique phrase: banana server port 9999";
    await storeTool?.execute("call-1", { text: uniqueText, importance: 0.9, category: "technical" });

    const recallByQueryResult = (await recallTool?.execute("call-2", {
      query: "banana server port",
      limit: 5,
    })) as { content?: { type: string; text: string }[]; details?: { count: number; memories?: { text: string }[] } };

    expect(recallByQueryResult.details?.count).toBeGreaterThanOrEqual(1);
    const texts = (recallByQueryResult.details?.memories ?? []).map((m) => m.text);
    expect(texts.some((t) => t.includes("banana server port 9999"))).toBe(true);
  });

  it("memory_forget by memoryId removes the fact", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);

    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    const forgetTool = api.getTool("memory_forget");

    const storeResult = (await storeTool?.execute("call-1", {
      text: "To be forgotten",
      importance: 0.5,
    })) as { details?: { id: string } };
    const id = storeResult.details?.id;

    const beforeForget = (await recallTool?.execute("call-2", { id })) as { details?: { count: number } };
    expect(beforeForget.details?.count).toBe(1);

    await forgetTool?.execute("call-3", { memoryId: id });
    const afterForget = (await recallTool?.execute("call-4", { id })) as { details?: { count: number } };
    expect(afterForget.details?.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Full init-databases + register flow (no tool execution) — sanity check
// ---------------------------------------------------------------------------

describe("Init-databases e2e", () => {
  let tmpDir: string;
  let api: ReturnType<typeof makeMockApi>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-init-"));
    api = makeMockApi();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializeDatabases returns all required stores and closeOldDatabases does not throw", () => {
    const pluginConfig = getMinimalConfig({
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
    });
    const mockApi = {
      ...api,
      pluginConfig,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
      config: {},
    };
    const ctx = initializeDatabases(pluginConfig, mockApi as never);
    expect(ctx.factsDb).toBeDefined();
    expect(ctx.vectorDb).toBeDefined();
    expect(ctx.embeddings).toBeDefined();
    expect(ctx.resolvedSqlitePath).toBe(join(tmpDir, "facts.db"));
    expect(ctx.resolvedLancePath).toBe(join(tmpDir, "lancedb"));

    expect(() =>
      closeOldDatabases({
        factsDb: ctx.factsDb, edictStore: null as any,
        vectorDb: ctx.vectorDb,
        credentialsDb: ctx.credentialsDb,
        proposalsDb: ctx.proposalsDb,
        identityReflectionStore: ctx.identityReflectionStore,
        personaStateStore: ctx.personaStateStore,
        eventLog: ctx.eventLog,
        aliasDb: ctx.aliasDb,
        issueStore: ctx.issueStore,
        workflowStore: ctx.workflowStore,
        crystallizationStore: ctx.crystallizationStore,
        toolProposalStore: ctx.toolProposalStore,
        verificationStore: ctx.verificationStore,
        provenanceService: ctx.provenanceService,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Core and common flows e2e (5 tests)
// ---------------------------------------------------------------------------

describe("Core and common flows e2e", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  let api: ReturnType<typeof makeMockApi>;
  let cfg: ReturnType<typeof getMinimalConfig>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-core-"));
    const sqlitePath = join(tmpDir, "facts.db");
    const lancePath = join(tmpDir, "lancedb");
    cfg = getMinimalConfig({
      sqlitePath,
      lanceDbPath: lancePath,
      store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    });
    factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false });
    vectorDb = new VectorDB(lancePath, EMBEDDING_DIM, false);
    api = makeMockApi();
  });

  afterEach(() => {
    vectorDb.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_store with entity/key/value then memory_recall by id returns structured fact", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    const storeResult = (await storeTool?.execute("call-1", {
      text: "Database runs on port 5432",
      entity: "Postgres",
      key: "port",
      value: "5432",
      importance: 0.8,
      category: "technical",
    })) as { details?: { id: string } };
    expect(storeResult.details?.id).toBeDefined();
    const factId = storeResult.details?.id;
    const recallResult = (await recallTool?.execute("call-2", { id: factId })) as {
      details?: { count: number; memories?: { entity?: string; key?: string; text: string }[] };
    };
    expect(recallResult.details?.count).toBe(1);
    const mem = recallResult.details?.memories?.[0];
    expect(mem).toBeDefined();
    expect(mem?.entity).toBe("Postgres");
    expect(mem?.text).toContain("5432");
  });

  it("memory_promote: store session-scoped then promote to global then recall", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const promoteTool = api.getTool("memory_promote");
    const recallTool = api.getTool("memory_recall");
    const storeResult = (await storeTool?.execute("call-1", {
      text: "Session-only note to promote",
      importance: 0.6,
      scope: "session",
      scopeTarget: "e2e-session",
    })) as { details?: { id: string } };
    const id = storeResult.details?.id;
    const promoteResult = (await promoteTool?.execute("call-2", { memoryId: id, scope: "global" })) as {
      details?: { action: string };
    };
    expect(promoteResult.details?.action).toBe("promoted");
    const recallResult = (await recallTool?.execute("call-3", { id })) as { details?: { count: number } };
    expect(recallResult.details?.count).toBe(1);
  });

  it("memory_checkpoint save and restore returns saved intent and state", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);
    const checkpointTool = api.getTool("memory_checkpoint");
    const saveResult = (await checkpointTool?.execute("call-1", {
      action: "save",
      intent: "Refactor auth module",
      state: "About to change login flow",
      expectedOutcome: "Tests pass",
    })) as { content?: { text: string }[]; details?: { action: string; id: string } };
    expect(saveResult.details?.action).toBe("saved");
    expect(saveResult.details?.id).toBeDefined();
    const restoreResult = (await checkpointTool?.execute("call-2", { action: "restore" })) as {
      content?: { text: string }[];
      details?: { action: string; checkpoint?: { intent: string; state: string } };
    };
    expect(restoreResult.details?.action).toBe("restored");
    expect(restoreResult.details?.checkpoint?.intent).toBe("Refactor auth module");
    expect(restoreResult.details?.checkpoint?.state).toBe("About to change login flow");
  });

  it("memory_prune hard mode removes expired fact", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);
    const past = Math.floor(Date.now() / 1000) - 3600;
    const entry = factsDb.store({
      text: "Expired session fact for prune e2e",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "session",
      expiresAt: past,
    });
    const pruneTool = api.getTool("memory_prune");
    const pruneResult = (await pruneTool?.execute("call-1", { mode: "hard" })) as {
      details?: { hardPruned?: number; softPruned?: number };
    };
    expect(pruneResult.details?.hardPruned).toBeGreaterThanOrEqual(1);
    expect(factsDb.getById(entry.id)).toBeNull();
  });

  it("memory_store duplicate text returns similar-already-exists when fuzzyDedupe on", async () => {
    factsDb.close();
    const cfgDedup = getMinimalConfig({
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      store: { fuzzyDedupe: true, classifyBeforeWrite: false },
    });
    factsDb = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: true });
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg: cfgDedup, api }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const text = "Exactly the same fact for duplicate e2e";
    await storeTool?.execute("call-1", { text, importance: 0.7, category: "fact" });
    const secondResult = (await storeTool?.execute("call-2", { text, importance: 0.7, category: "fact" })) as {
      content?: { text: string }[];
      details?: { action?: string };
    };
    expect(secondResult.details?.action).toBe("duplicate");
    expect(secondResult.content?.[0]?.text?.toLowerCase()).toMatch(/similar|already exists|duplicate/);
  });
});

// ---------------------------------------------------------------------------
// 5. Advanced features e2e (5 tests)
// ---------------------------------------------------------------------------

describe("Advanced features e2e", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  let api: ReturnType<typeof makeMockApi>;
  let cfg: ReturnType<typeof getMinimalConfig>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-advanced-"));
    const sqlitePath = join(tmpDir, "facts.db");
    const lancePath = join(tmpDir, "lancedb");
    cfg = getMinimalConfig({
      sqlitePath,
      lanceDbPath: lancePath,
      store: { fuzzyDedupe: false, classifyBeforeWrite: false },
      graph: {
        enabled: true,
        autoLink: false,
        autoLinkLimit: 5,
        autoLinkMinScore: 0.5,
        useInRecall: false,
        maxTraversalDepth: 2,
        coOccurrenceWeight: 0.5,
        autoSupersede: false,
      },
      path: { enabled: true, maxPathDepth: 10 },
      verification: { enabled: true, backupPath: join(tmpDir, "verified-backup.json"), reverificationDays: 30 },
      clusters: { enabled: true, minClusterSize: 2, refreshIntervalDays: 0, labelModel: null },
      gaps: { enabled: true, similarityThreshold: 0.8 },
    });
    // 2026.3.140 migration forces verification off; override so advanced e2e tests can exercise the feature
    cfg.verification!.enabled = true;
    factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false });
    vectorDb = new VectorDB(lancePath, EMBEDDING_DIM, false);
    api = makeMockApi();
  });

  afterEach(() => {
    vectorDb.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_link and memory_graph: link two facts then explore graph", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const linkTool = api.getTool("memory_link");
    const graphTool = api.getTool("memory_graph");
    const a = (await storeTool?.execute("call-1", {
      text: "Fact A for graph link",
      importance: 0.8,
      category: "fact",
    })) as { details?: { id: string } };
    const b = (await storeTool?.execute("call-2", {
      text: "Fact B for graph link",
      importance: 0.8,
      category: "fact",
    })) as { details?: { id: string } };
    const linkResult = (await linkTool?.execute("call-3", {
      sourceFact: a.details?.id,
      targetFact: b.details?.id,
      linkType: "RELATED_TO",
      strength: 0.9,
    })) as { details?: { linkId: string; linkType: string } };
    expect(linkResult.details?.linkId).toBeDefined();
    expect(linkResult.details?.linkType).toBe("RELATED_TO");
    const graphResult = (await graphTool?.execute("call-4", { factId: a.details?.id, depth: 2 })) as {
      content?: { text: string }[];
      details?: { outbound: number; connectedCount: number };
    };
    expect(graphResult.details?.outbound).toBe(1);
    expect(graphResult.details?.connectedCount).toBeGreaterThanOrEqual(1);
    expect(graphResult.content?.[0]?.text).toMatch(/RELATED_TO|Fact B/);
  });

  it("memory_verify and memory_verified_list: verify fact then list verified", async () => {
    const verificationStore = new VerificationStore(factsDb.getRawDb(), {
      backupPath: join(tmpDir, "verified-backup.json"),
      reverificationDays: 30,
    });
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api, verificationStore }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const verifyTool = api.getTool("memory_verify");
    const listTool = api.getTool("memory_verified_list");
    const storeResult = (await storeTool?.execute("call-1", {
      text: "Critical fact to verify",
      importance: 0.9,
      category: "fact",
    })) as { details?: { id: string } };
    const factId = storeResult.details?.id;
    const verifyResult = (await verifyTool?.execute("call-2", { factId })) as { details?: { status: string } };
    expect(verifyResult.details?.status).toBe("verified");
    const listResult = (await listTool?.execute("call-3", {})) as {
      details?: { count: number };
      content?: { text: string }[];
    };
    expect(listResult.details?.count).toBe(1);
    expect(listResult.content?.[0]?.text).toContain(factId);
    verificationStore.close();
  });

  it("memory_issue_create and memory_issue_list: create issue then list", async () => {
    const issueStore = new IssueStore(join(tmpDir, "issues.db"));
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api, issueStore }) as never, api as never);
    const createTool = api.getTool("memory_issue_create");
    const listTool = api.getTool("memory_issue_list");
    const createResult = (await createTool?.execute("call-1", {
      title: "E2E test issue",
      symptoms: ["Symptom one", "Symptom two"],
      severity: "medium",
      tags: ["e2e"],
    })) as { details?: { id: string; title: string; status: string } };
    expect(createResult.details?.id).toBeDefined();
    expect(createResult.details?.title).toBe("E2E test issue");
    expect(createResult.details?.status).toBe("open");
    const listResult = (await listTool?.execute("call-2", { status: ["open"] })) as {
      details?: { id: string; title: string }[] | unknown;
    };
    const issues = Array.isArray(listResult.details) ? listResult.details : [];
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i: { title: string }) => i.title === "E2E test issue")).toBe(true);
    issueStore.close();
  });

  it("memory_clusters: returns cluster count or no-clusters message", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const linkTool = api.getTool("memory_link");
    const clustersTool = api.getTool("memory_clusters");
    const a = (await storeTool?.execute("call-1", { text: "Cluster fact one", importance: 0.7, category: "fact" })) as {
      details?: { id: string };
    };
    const b = (await storeTool?.execute("call-2", { text: "Cluster fact two", importance: 0.7, category: "fact" })) as {
      details?: { id: string };
    };
    await linkTool?.execute("call-3", { sourceFact: a.details?.id, targetFact: b.details?.id, linkType: "RELATED_TO" });
    const result = (await clustersTool?.execute("call-4", { minClusterSize: 2, save: true })) as {
      details?: { clusterCount?: number; error?: string };
      content?: { text: string }[];
    };
    expect(result.details?.error).toBeUndefined();
    expect(typeof result.details?.clusterCount).toBe("number");
    expect(result.content?.[0]?.text).toBeDefined();
  });

  it("memory_path: shortest path between two linked facts", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg, api }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const linkTool = api.getTool("memory_link");
    const pathTool = api.getTool("memory_path");
    const a = (await storeTool?.execute("call-1", { text: "Path start fact", importance: 0.8, category: "fact" })) as {
      details?: { id: string };
    };
    const b = (await storeTool?.execute("call-2", { text: "Path end fact", importance: 0.8, category: "fact" })) as {
      details?: { id: string };
    };
    await linkTool?.execute("call-3", { sourceFact: a.details?.id, targetFact: b.details?.id, linkType: "RELATED_TO" });
    const pathResult = (await pathTool?.execute("call-4", { from: a.details?.id, to: b.details?.id, maxDepth: 5 })) as {
      details?: { found: boolean; hops?: number };
      content?: { text: string }[];
    };
    expect(pathResult.details?.found).toBe(true);
    expect(pathResult.details?.hops).toBe(1);
    expect(pathResult.content?.[0]?.text).toMatch(/Path found|hop/);
  });
});
