/**
 * Comprehensive end-to-end tests: full memoryHybridPlugin.register() stack.
 *
 * Unlike plugin-e2e.test.ts (which often calls registerTools in isolation and mocks
 * registerLifecycleHook), these exercises:
 *   initializeDatabases → registerTools → registerLifecycleHooks → registerService
 * with real api.on handlers, real FactsDB + VectorDB, and simulated agent turns.
 *
 * Requires Node >= 22.16 (node:sqlite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { _testing } from "../index.js";
import { resetPluginRegistrationStateForTests, runtimeRef } from "../setup/register-plugin.js";
import { _resetWalCircuitBreakerForTesting } from "../services/wal-helpers.js";
import { awaitReloadTeardownBeforeOpen, TEARDOWN_WAIT_MS } from "../setup/hybrid-memory-reload-coordinator.js";
import { benignFinalizationMessages, pendingCiTurnMessages } from "./fixtures/maeve-ledger.js";
import {
  E2E_EMBEDDING_DIM,
  assertFullStackPaths,
  getFullStackConfig,
  invokeHooks,
  makeFullStackApi,
  registerFullPlugin,
  type FullStackApi,
} from "./helpers/comprehensive-e2e-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

const { VectorDB } = _testing;

const SESSION = "agent:main:telegram:e2e-comprehensive";
const HOOK_CTX = { sessionKey: SESSION, sessionId: SESSION, agentId: "main" };
const RELOAD_TEARDOWN_ERROR_FRAGMENT = "reload teardown did not drain";
const HOT_RELOAD_TEST_TIMEOUT_MS = TEARDOWN_WAIT_MS * 6;
const HOT_RELOAD_RETRY_WAIT_MS = TEARDOWN_WAIT_MS * 2;

describe("Comprehensive e2e — full plugin register()", () => {
  let tmpDir: string;
  let api: FullStackApi;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comprehensive-e2e-"));
    api = makeFullStackApi(tmpDir);
    process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = "reuse-databases";
    _resetWalCircuitBreakerForTesting();
    resetPluginRegistrationStateForTests();
  });

  afterEach(async () => {
    try {
      await api.stopService();
    } catch {
      /* non-fatal */
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    resetPluginRegistrationStateForTests();
    delete process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY;
  });

  function register(overrides: Record<string, unknown> = {}): void {
    registerFullPlugin(api, getFullStackConfig(tmpDir, overrides));
  }

  describe("registration stack", () => {
    it("bootstraps databases, tools, CLI, service, and lifecycle hooks", async () => {
      register();
      assertFullStackPaths(tmpDir);
      expect(api.getTool("memory_store")).toBeDefined();
      expect(api.getTool("memory_recall")).toBeDefined();
      expect(api.getTool("memory_forget")).toBeDefined();
      expect(api.registerCli).toHaveBeenCalled();
      expect(api.registerService).toHaveBeenCalled();
      expect(api.registeredEvents()).toContain("agent_end");
      expect(api.registeredEvents()).toContain("before_compaction");
      expect(api.registeredEvents()).toContain("after_compaction");
      expect(api.registeredEvents().filter((e) => e === "before_agent_start").length).toBeGreaterThan(0);
      expect(api.registerLifecycleHook).not.toHaveBeenCalled();
    });

    it(
      "survives hot reload (second register closes prior runtime)",
      async () => {
        const stableConfig = getFullStackConfig(tmpDir);
        registerFullPlugin(api, stableConfig);
        const bootstrap = runtimeRef.value?.bootstrapAsyncInit;
        if (bootstrap) {
          await bootstrap.catch(() => {
            // Non-fatal in this e2e: hot-reload persistence path still validates via store/recall round-trip below.
          });
        }
        const store = api.getTool("memory_store")!;
        const stored = (await store.execute("c1", {
          text: "Survives plugin hot reload",
          category: "fact",
          importance: 0.8,
        })) as { details?: { id: string } };
        const factId = stored.details?.id;
        expect(factId).toBeDefined();

        try {
          registerFullPlugin(api, stableConfig);
        } catch (err) {
          if (!(err instanceof Error) || !err.message.includes(RELOAD_TEARDOWN_ERROR_FRAGMENT)) {
            throw err;
          }
          // Vitest runs register() synchronously; if a full-teardown fallback races, retry once.
          // Give the retry more headroom than the production register() block: this e2e
          // may also be waiting for mocked/test harness teardown work to settle (#1775).
          expect(await awaitReloadTeardownBeforeOpen(HOT_RELOAD_RETRY_WAIT_MS)).toBe(true);
          registerFullPlugin(api, stableConfig);
        }
        const recall = api.getTool("memory_recall")!;
        const recalled = (await recall.execute("c2", { id: factId })) as {
          details?: { count: number; memories?: { text: string }[] };
        };
        expect(recalled.details?.count).toBe(1);
        expect(recalled.details?.memories?.[0]?.text).toContain("hot reload");
      },
      HOT_RELOAD_TEST_TIMEOUT_MS,
    );

    it("service start() and stop() complete without throwing", async () => {
      register();
      await expect(api.startService()).resolves.toBeUndefined();
      await expect(api.stopService()).resolves.toBeUndefined();
    });
  });

  describe("tool round-trip (registered tools + real backends)", () => {
    beforeEach(() => {
      register();
    });

    it("memory_store → memory_recall by id → memory_forget", async () => {
      const text = "Comprehensive e2e round-trip fact 10.0.0.99";
      const store = api.getTool("memory_store")!;
      const recall = api.getTool("memory_recall")!;
      const forget = api.getTool("memory_forget")!;

      const stored = (await store.execute("c1", { text, category: "technical", importance: 0.9 })) as {
        details?: { id: string; action: string };
      };
      expect(stored.details?.action).toBe("created");
      const id = stored.details?.id;

      const byId = (await recall.execute("c2", { id })) as {
        details?: { count: number; memories?: { text: string }[] };
      };
      expect(byId.details?.count).toBe(1);
      expect(byId.details?.memories?.[0]?.text).toBe(text);

      const forgot = (await forget.execute("c3", { memoryId: id })) as { details?: { action: string } };
      expect(forgot.details?.action).not.toBe("not_found");

      const after = (await recall.execute("c4", { id })) as { details?: { count: number } };
      expect(after.details?.count).toBe(0);
    });

    it("memory_store then memory_recall by query finds the fact", async () => {
      const unique = "Comprehensive e2e semantic phrase zephyr-port-4242";
      await api.getTool("memory_store")?.execute("c1", { text: unique, category: "fact", importance: 0.9 });

      const recalled = (await api.getTool("memory_recall")?.execute("c2", {
        query: "zephyr port",
        limit: 5,
      })) as { details?: { count: number; memories?: { text: string }[] } };

      expect(recalled.details?.count).toBeGreaterThanOrEqual(1);
      expect((recalled.details?.memories ?? []).some((m) => m.text.includes(unique))).toBe(true);
    });
  });

  describe("simulated agent turn (lifecycle hooks from register)", () => {
    it("agent_end allows benign finalization messages", async () => {
      register();
      const handlers = api.hookHandlers("agent_end");
      expect(handlers.length).toBeGreaterThan(0);

      await expect(
        invokeHooks(api, "agent_end", { messages: benignFinalizationMessages(), success: true }, HOOK_CTX),
      ).resolves.not.toThrow();
    });

    it("agent_end allows when CI is pending and project ledger is empty (#1479)", async () => {
      register();
      const handler = api.hookHandlers("agent_end")[0]!;
      await expect(handler({ messages: pendingCiTurnMessages(), success: true }, HOOK_CTX)).resolves.toBeUndefined();
      expect(api.logger.warn).not.toHaveBeenCalled();
    });

    it("after_compaction injects post-compaction memory summary for stored facts", async () => {
      await register({ verbosity: "normal", autoRecall: { enabled: true, authFailure: { enabled: false } } });
      await api.getTool("memory_store")?.execute("c1", {
        text: "Fact retained across compaction for comprehensive e2e",
        category: "fact",
        importance: 0.8,
      });

      const handler = api.hookHandlers("after_compaction")[0]!;
      const out = (await handler({ messageCount: 12, compactedCount: 4, tokenCount: 8000 }, HOOK_CTX)) as
        | { prependContext?: string }
        | undefined;

      expect(out?.prependContext).toContain("post-compaction memory summary");
      expect(out?.prependContext).toContain("retained across compaction");
    }, 60_000);
  });

  describe("persistence and verify boundaries", () => {
    it("facts persist on disk and can be read from a new FactsDB connection", async () => {
      register();
      const text = "Persisted on disk for secondary connection read";
      const id = (
        (await api.getTool("memory_store")?.execute("c1", {
          text,
          category: "fact",
          importance: 0.7,
        })) as { details?: { id: string } }
      ).details?.id;

      const sqlitePath = join(tmpDir, "facts.db");
      const reader = new FactsDB(sqlitePath, { fuzzyDedupe: false });
      try {
        expect(reader.getById(id!)?.text).toBe(text);
        expect(reader.count()).toBeGreaterThanOrEqual(1);
      } finally {
        reader.close();
      }
    });

    it("runVerifyForCli reconcile reports in-sync after store + vector write", async () => {
      register();
      const sqlitePath = join(tmpDir, "facts.db");
      const lancePath = join(tmpDir, "lancedb");
      const stored = (
        (await api.getTool("memory_store")?.execute("c1", {
          text: "Verify reconcile in-sync fact",
          category: "fact",
          importance: 0.8,
        })) as { details?: { id: string } }
      ).details!;

      const vectorDb = new VectorDB(lancePath, E2E_EMBEDDING_DIM, false);
      try {
        await vectorDb.store({
          id: stored.id,
          text: "Verify reconcile in-sync fact",
          vector: new Array(E2E_EMBEDDING_DIM).fill(0.1),
          importance: 0.8,
          category: "fact",
        });

        const homeDir = mkdtempSync(join(tmpdir(), "comprehensive-e2e-home-"));
        try {
          const openclawDir = join(homeDir, ".openclaw");
          const { mkdirSync, writeFileSync } = await import("node:fs");
          mkdirSync(join(openclawDir, "cron"), { recursive: true });
          writeFileSync(
            join(openclawDir, "openclaw.json"),
            JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-4.1-mini" } } } }),
          );
          writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }));
          vi.stubEnv("HOME", homeDir);

          const reader = new FactsDB(sqlitePath, { fuzzyDedupe: false });
          const cfg = getFullStackConfig(tmpDir);
          const { runVerifyForCli } = await import("../cli/handlers.js");
          const lines: string[] = [];
          await runVerifyForCli(
            {
              cfg,
              factsDb: reader,
              vectorDb,
              embeddings: {
                dimensions: E2E_EMBEDDING_DIM,
                embed: vi.fn().mockResolvedValue(new Array(E2E_EMBEDDING_DIM).fill(0.1)),
                modelName: "text-embedding-3-small",
              },
              credentialsDb: null,
              resolvedSqlitePath: sqlitePath,
              resolvedLancePath: lancePath,
              openai: null,
            } as never,
            { fix: false, reconcile: true },
            { log: (m) => lines.push(m) },
          );
          reader.close();
          expect(lines.join("\n")).toMatch(/in sync|Reconciliation/i);
        } finally {
          rmSync(homeDir, { recursive: true, force: true });
          vi.unstubAllEnvs();
        }
      } finally {
        await vectorDb.close();
      }
    });
  });
});
