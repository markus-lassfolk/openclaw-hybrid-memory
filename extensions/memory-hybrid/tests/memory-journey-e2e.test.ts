/**
 * Memory journey E2E — store → categorize → link → recall → budgeted injection.
 *
 * Exercises the full plugin register() stack (real FactsDB, real lifecycle hooks)
 * for the core memory loop that unit tests usually split across facts-db, auto-linking,
 * lifecycle-stage-recall, and lifecycle-stage-injection.
 *
 * Requires Node >= 22.16 (node:sqlite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRegistrationStateForTests, runtimeRef } from "../setup/register-plugin.js";
import { _resetWalCircuitBreakerForTesting } from "../services/wal-helpers.js";
import { estimateTokens } from "../utils/text.js";
import {
  assertFullStackPaths,
  getFullStackConfig,
  invokeHooks,
  makeFullStackApi,
  mergePrependFromHookResults,
  registerFullPlugin,
  type FullStackApi,
} from "./helpers/comprehensive-e2e-harness.js";

const { classifyMemoryOperationMock } = vi.hoisted(() => ({
  classifyMemoryOperationMock: vi.fn(),
}));

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/classification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/classification.js")>();
  return {
    ...actual,
    classifyMemoryOperation: (...args: Parameters<typeof actual.classifyMemoryOperation>) =>
      classifyMemoryOperationMock(...args),
  };
});

const SESSION = "agent:main:telegram:memory-journey";
const OTHER_SESSION = "agent:main:telegram:memory-journey-other";
const HOOK_CTX = { sessionKey: SESSION, sessionId: SESSION, agentId: "main" };

const DEPLOY_MARKER = "mj-e2e-deploy-window-tuesday-0200";
const NOISE_MARKER = "mj-e2e-garden-tulips-unrelated-noise";
const QUERY_ANCHOR_PHRASE = "memory journey query phrase zephyr port 9911";
const LINKED_NEIGHBOR_PHRASE = "memory journey linked neighbor staging mirror phrase";
const COMPACTION_MARKER = "mj-e2e-retained-across-compaction-summary";

function factsAreLinked(
  factsDb: NonNullable<(typeof runtimeRef)["value"]>["factsDb"],
  idA: string,
  idB: string,
): boolean {
  return (
    factsDb.getLinksFrom(idA).some((l) => l.targetFactId === idB) ||
    factsDb.getLinksTo(idA).some((l) => l.sourceFactId === idB) ||
    factsDb.getLinksFrom(idB).some((l) => l.targetFactId === idA) ||
    factsDb.getLinksTo(idB).some((l) => l.sourceFactId === idA)
  );
}

function journeyConfig(tmpDir: string, overrides: Record<string, unknown> = {}) {
  return getFullStackConfig(tmpDir, {
    graph: {
      enabled: true,
      autoLink: true,
      autoLinkLimit: 5,
      autoLinkMinScore: 0.5,
      useInRecall: true,
      strengthenOnRecall: false,
      coOccurrenceWeight: 0.3,
      autoSupersede: false,
    },
    autoRecall: {
      enabled: true,
      authFailure: { enabled: false },
      limit: 5,
      maxTokens: 180,
      minScore: 0.05,
      injectionFormat: "full",
    },
    store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    ...overrides,
  });
}

describe("Memory journey e2e — full register() stack", () => {
  let tmpDir: string;
  let api: FullStackApi;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-journey-e2e-"));
    api = makeFullStackApi(tmpDir);
    process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = "reuse-databases";
    _resetWalCircuitBreakerForTesting();
    resetPluginRegistrationStateForTests();
    classifyMemoryOperationMock.mockReset();
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

  async function registerJourney(overrides: Record<string, unknown> = {}): Promise<void> {
    registerFullPlugin(api, journeyConfig(tmpDir, overrides));
    const bootstrap = runtimeRef.value?.bootstrapAsyncInit;
    if (bootstrap) {
      await bootstrap.catch(() => {
        /* non-fatal for these tests */
      });
    }
  }

  it("persists category and structured fields from memory_store", async () => {
    await registerJourney();
    const store = api.getTool("memory_store")!;
    const stored = (await store.execute("c1", {
      text: "User prefers bullet-point summaries for status updates",
      category: "preference",
      entity: "markus",
      key: "summary_format",
      value: "bullet_points",
      importance: 0.85,
    })) as { details?: { id?: string } };

    const id = stored.details?.id;
    expect(id).toBeDefined();

    const factsDb = runtimeRef.value?.factsDb;
    expect(factsDb).toBeDefined();
    const entry = factsDb!.getById(id!);
    expect(entry?.category).toBe("preference");
    expect(entry?.entity).toBe("markus");
    expect(entry?.key).toBe("summary_format");
    expect(entry?.value).toBe("bullet_points");
  });

  it("auto-links facts that mention a shared entity when graph.autoLink is enabled", async () => {
    await registerJourney();
    const store = api.getTool("memory_store")!;

    const anchor = (await store.execute("c1", {
      text: "AcmeCorp primary deployment runs on Tuesdays at 02:00 UTC",
      category: "project",
      entity: "AcmeCorp",
      key: "deploy_schedule",
      value: "Tuesday 02:00 UTC",
      importance: 0.9,
    })) as { details?: { id?: string } };

    const related = (await store.execute("c2", {
      text: "AcmeCorp staging environment mirrors production configuration",
      category: "technical",
      importance: 0.7,
    })) as { details?: { id?: string } };

    const anchorId = anchor.details?.id;
    const relatedId = related.details?.id;
    expect(anchorId).toBeDefined();
    expect(relatedId).toBeDefined();

    const factsDb = runtimeRef.value!.factsDb;
    const outbound = factsDb.getLinksFrom(relatedId!);
    const inbound = factsDb.getLinksTo(anchorId!);
    const linked =
      outbound.some((l) => l.targetFactId === anchorId) ||
      inbound.some((l) => l.sourceFactId === relatedId) ||
      factsDb.getLinksFrom(anchorId!).some((l) => l.targetFactId === relatedId) ||
      factsDb.getLinksTo(relatedId!).some((l) => l.sourceFactId === anchorId);

    expect(linked).toBe(true);
  });

  it("before_agent_start injects query-relevant memories and omits unrelated noise", async () => {
    await registerJourney();
    const store = api.getTool("memory_store")!;

    await store.execute("c1", {
      text: `AcmeCorp ${DEPLOY_MARKER} is Tuesday 02:00 UTC`,
      category: "project",
      entity: "AcmeCorp",
      importance: 0.95,
    });
    await store.execute("c2", {
      text: `Random ${NOISE_MARKER} about spring gardening tips`,
      category: "other",
      importance: 0.2,
    });

    const results = await invokeHooks(
      api,
      "before_agent_start",
      { prompt: `When is the AcmeCorp ${DEPLOY_MARKER.split("-").slice(2, 4).join(" ")}?` },
      HOOK_CTX,
    );
    const prepend = mergePrependFromHookResults(results);

    expect(prepend.length).toBeGreaterThan(0);
    expect(prepend).toContain("<recalled-context>");
    expect(prepend).toContain(DEPLOY_MARKER);
    expect(prepend).not.toContain(NOISE_MARKER);
  }, 60_000);

  it("respects autoRecall.maxTokens when assembling the injected prepend block", async () => {
    await registerJourney({
      autoRecall: {
        enabled: true,
        authFailure: { enabled: false },
        limit: 8,
        maxTokens: 90,
        minScore: 0.05,
        injectionFormat: "full",
      },
    });
    const store = api.getTool("memory_store")!;

    for (let i = 0; i < 6; i++) {
      await store.execute(`bulk-${i}`, {
        text: `Bulk memory journey filler fact number ${i} with extra padding text to consume tokens `.repeat(3),
        category: "fact",
        importance: 0.5,
      });
    }
    await store.execute("target", {
      text: `Target fact ${DEPLOY_MARKER} for budget test`,
      category: "fact",
      importance: 0.99,
    });

    const results = await invokeHooks(
      api,
      "before_agent_start",
      { prompt: `Remind me about ${DEPLOY_MARKER} and project timing details please` },
      HOOK_CTX,
    );
    const prepend = mergePrependFromHookResults(results);

    expect(prepend.length).toBeGreaterThan(0);
    const recalledSection = prepend.includes("<recalled-context>")
      ? prepend.slice(prepend.indexOf("<recalled-context>"))
      : prepend;
    expect(estimateTokens(recalledSection)).toBeLessThanOrEqual(120);
  }, 60_000);

  it("memory_recall by id and lifecycle injection both surface the same anchor fact", async () => {
    await registerJourney();
    const store = api.getTool("memory_store")!;
    const recall = api.getTool("memory_recall")!;

    const stored = (await store.execute("c1", {
      text: `AcmeCorp ${DEPLOY_MARKER} confirmed for Tuesday`,
      category: "project",
      entity: "AcmeCorp",
      importance: 0.9,
    })) as { details?: { id?: string } };

    const factId = stored.details?.id;
    expect(factId).toBeDefined();

    const toolRecall = (await recall.execute("c2", { id: factId })) as {
      details?: { memories?: Array<{ id: string; text: string }> };
    };
    expect(toolRecall.details?.memories?.[0]?.id).toBe(factId);

    const hookResults = await invokeHooks(
      api,
      "before_agent_start",
      { prompt: `What do we know about ${DEPLOY_MARKER}?` },
      HOOK_CTX,
    );
    const prepend = mergePrependFromHookResults(hookResults);
    expect(prepend).toContain(DEPLOY_MARKER);
  }, 60_000);

  it("bootstraps databases on full register()", async () => {
    await registerJourney();
    assertFullStackPaths(tmpDir);
    expect(runtimeRef.value?.factsDb).toBeDefined();
    expect(api.getTool("memory_store")).toBeDefined();
    expect(api.getTool("memory_recall")).toBeDefined();
  });

  it("memory_recall query path finds stored facts via FTS (deterministic strategies)", async () => {
    await registerJourney({ retrieval: { strategies: ["fts5"] } });
    const store = api.getTool("memory_store")!;
    const recall = api.getTool("memory_recall")!;

    await store.execute("c1", {
      text: `AcmeCorp ${QUERY_ANCHOR_PHRASE} ${DEPLOY_MARKER}`,
      category: "project",
      entity: "AcmeCorp",
      importance: 0.9,
    });

    const toolRecall = (await recall.execute("c2", {
      query: "zephyr port",
      limit: 5,
    })) as { details?: { count?: number; memories?: Array<{ text: string }> } };

    expect(toolRecall.details?.count).toBeGreaterThan(0);
    expect(toolRecall.details?.memories?.some((m) => m.text.includes(QUERY_ANCHOR_PHRASE))).toBe(true);
  }, 60_000);

  it("memory_recall expands graph-linked neighbors when graph.useInRecall is enabled", async () => {
    await registerJourney({ retrieval: { strategies: ["fts5"] } });
    const store = api.getTool("memory_store")!;
    const recall = api.getTool("memory_recall")!;

    const anchor = (await store.execute("c1", {
      text: `AcmeCorp ${QUERY_ANCHOR_PHRASE} ${DEPLOY_MARKER}`,
      category: "project",
      entity: "AcmeCorp",
      importance: 0.95,
    })) as { details?: { id?: string } };

    const neighbor = (await store.execute("c2", {
      text: `AcmeCorp ${LINKED_NEIGHBOR_PHRASE} staging mirrors production configuration`,
      category: "technical",
      entity: "AcmeCorp",
      importance: 0.75,
    })) as { details?: { id?: string } };

    const anchorId = anchor.details?.id;
    const neighborId = neighbor.details?.id;
    expect(anchorId).toBeDefined();
    expect(neighborId).toBeDefined();

    const factsDb = runtimeRef.value!.factsDb;
    expect(factsAreLinked(factsDb, anchorId!, neighborId!)).toBe(true);

    const recalled = (await recall.execute("c3", {
      query: "zephyr port",
      limit: 8,
    })) as { details?: { memories?: Array<{ text: string }> } };

    const joined = (recalled.details?.memories ?? []).map((m) => m.text).join("\n");
    expect(joined).toContain(QUERY_ANCHOR_PHRASE);
    expect(joined).toContain(LINKED_NEIGHBOR_PHRASE);
  }, 60_000);

  it("classifyBeforeWrite UPDATE supersedes a similar existing fact instead of duplicating", async () => {
    await registerJourney({ store: { fuzzyDedupe: false, classifyBeforeWrite: true } });
    const store = api.getTool("memory_store")!;

    const first = (await store.execute("c1", {
      text: "AcmeCorp deployment schedule runs Tuesday at 02:00 UTC",
      category: "project",
      entity: "AcmeCorp",
      key: "deploy_schedule",
      importance: 0.85,
    })) as { details?: { id?: string } };

    const targetId = first.details?.id;
    expect(targetId).toBeDefined();

    classifyMemoryOperationMock.mockResolvedValueOnce({
      action: "UPDATE",
      targetId,
      reason: "schedule moved to Wednesday",
    });

    const second = (await store.execute("c2", {
      text: "AcmeCorp deployment schedule moved to Wednesday at 03:00 UTC",
      category: "project",
      entity: "AcmeCorp",
      key: "deploy_schedule",
      importance: 0.9,
    })) as { details?: { action?: string; id?: string; superseded?: string } };

    expect(second.details?.action).toBe("updated");
    expect(second.details?.superseded).toBe(targetId);
    expect(classifyMemoryOperationMock).toHaveBeenCalledOnce();

    const factsDb = runtimeRef.value!.factsDb;
    expect(factsDb.getById(targetId!)?.supersededBy).toBe(second.details!.id);
    expect(factsDb.getById(second.details!.id!)?.text).toContain("Wednesday");
  }, 60_000);

  it("memory_store fuzzyDedupe rejects near-duplicate text on full register stack", async () => {
    await registerJourney({ store: { fuzzyDedupe: true, classifyBeforeWrite: false } });
    const store = api.getTool("memory_store")!;
    const text = "Exactly the same memory journey dedupe fact for fuzzy match";

    await store.execute("c1", { text, category: "fact", importance: 0.7 });
    const second = (await store.execute("c2", { text: `  ${text.toUpperCase()}  `, category: "fact", importance: 0.8 })) as {
      details?: { action?: string };
    };

    expect(second.details?.action).toBe("duplicate");
    expect(runtimeRef.value!.factsDb.count()).toBe(1);
  }, 60_000);

  it("before_agent_start scope filter excludes session-scoped facts from other sessions", async () => {
    const SESSION_VISIBLE_PHRASE = "memory journey visible session private note alpha";
    const SESSION_HIDDEN_PHRASE = "memory journey hidden session private note beta";

    await registerJourney({
      autoRecall: {
        enabled: true,
        authFailure: { enabled: false },
        limit: 5,
        maxTokens: 180,
        minScore: 0.05,
        injectionFormat: "full",
        scopeFilter: { sessionId: SESSION, userId: null, agentId: null },
      },
    });
    const store = api.getTool("memory_store")!;

    await store.execute("hidden", {
      text: SESSION_HIDDEN_PHRASE,
      category: "fact",
      scope: "session",
      scopeTarget: OTHER_SESSION,
      importance: 0.8,
    });
    await store.execute("visible", {
      text: SESSION_VISIBLE_PHRASE,
      category: "fact",
      scope: "session",
      scopeTarget: SESSION,
      importance: 0.85,
    });

    const visibleResults = await invokeHooks(
      api,
      "before_agent_start",
      { prompt: "What do we know about the visible session private note alpha?" },
      HOOK_CTX,
    );
    const visiblePrepend = mergePrependFromHookResults(visibleResults);
    expect(visiblePrepend).toContain("visible session private note alpha");
    expect(visiblePrepend).not.toContain("hidden session private note beta");

    const hiddenResults = await invokeHooks(
      api,
      "before_agent_start",
      { prompt: "What do we know about the hidden session private note beta?" },
      HOOK_CTX,
    );
    const hiddenPrepend = mergePrependFromHookResults(hiddenResults);
    expect(hiddenPrepend).not.toContain("hidden session private note beta");
  }, 60_000);

  it("after_compaction injects a summary that still surfaces stored facts", async () => {
    await registerJourney({ verbosity: "normal" });
    const store = api.getTool("memory_store")!;

    await store.execute("c1", {
      text: `Fact ${COMPACTION_MARKER} retained after context compaction`,
      category: "fact",
      importance: 0.85,
    });

    const handler = api.hookHandlers("after_compaction")[0]!;
    const out = (await handler({ messageCount: 12, compactedCount: 4, tokenCount: 8000 }, HOOK_CTX)) as
      | { prependContext?: string }
      | undefined;

    expect(out?.prependContext).toContain("post-compaction memory summary");
    expect(out?.prependContext).toContain(COMPACTION_MARKER);
  }, 60_000);
});
