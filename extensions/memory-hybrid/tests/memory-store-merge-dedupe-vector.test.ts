// @ts-nocheck — registerMemoryTools uses `ClawdbotPluginApi` from `openclaw`, not available in
// the test environment; consistent with the pattern in memory-store-vault-vector-isolation.test.ts.
/**
 * Regression test (loop iteration 33): when storeWithResult MERGEs a new memory_store call's text
 * onto an existing fact (newlyStored: false, embeddingStale: true — reachable in production via
 * either a hash/lexical match or a vector-only near-duplicate the cheap `hasDuplicate` pre-check
 * can't see, since that pre-check has no vector-candidate feed), the normal ADD path re-embedded
 * and stored the vector using the pre-merge `textToStore` and the vector already computed from it
 * BEFORE the merge — not `entry.text` (the actual persisted, merged content: existing.text + "\n"
 * + textToStore). This left the vector backend encoding only the newly-added text fragment while
 * the fact row's real text was the full merged content, silently desyncing the two backends for
 * that fact. The classify-before-write UPDATE-merge branch already handled this correctly by
 * re-embedding `newEntry.text`; the normal ADD path did not.
 *
 * The test stubs `hasDuplicate` to false so the cheap pre-check in register-store-tools.ts (which
 * would otherwise bounce the second call itself, since it runs the same hash-match logic) doesn't
 * short-circuit before reaching the real `storeWithResult` call — letting the merge actually
 * happen deterministically via a plain case-insensitive hash duplicate, without needing to wire up
 * a genuine embedding-similarity candidate feed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

const { FactsDB } = _testing;

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session" },
  };
}

function makeMockVectorDb() {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn(),
  };
}

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-store-merge-vector-"));
  // fuzzyDedupe must be explicitly enabled — default is false — for hash-based dedupe (matching
  // texts that differ only in case/whitespace) to be considered at all. storeConfig must also be
  // passed at construction time — storeWithResult resolves the dedupe profile from the FactsDB
  // instance's own ctx.storeConfig, not from any per-call argument, so the cfg.store passed to
  // registerMemoryTools below has no effect on dedupe decisions unless mirrored here too.
  factsDb = new FactsDB(join(tmpDir, "facts.db"), {
    fuzzyDedupe: true,
    storeConfig: { fuzzyDedupe: true, sourceProfiles: { conversation: { onDuplicate: "merge" } } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_store merge-dedupe re-embeds the actual merged text (loop iteration 33 regression)", () => {
  it("embeds entry.text (the merged content), not the pre-merge fragment, when storeWithResult merges", async () => {
    const embedCalls: string[] = [];
    const embeddings = {
      modelName: "mock-model",
      dimensions: 4,
      embed: vi.fn(async (text: string) => {
        embedCalls.push(text);
        return [0.1, 0.2, 0.3, 0.4];
      }),
      embedBatch: vi.fn().mockResolvedValue([]),
    };
    const vectorDb = makeMockVectorDb();
    const api = makeMockApi();
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      store: {
        classifyBeforeWrite: false,
        sourceProfiles: { conversation: { onDuplicate: "merge" } },
      },
      graph: { enabled: false },
    });

    registerMemoryTools(
      {
        factsDb,
        edictStore: null as never,
        vectorDb: vectorDb as never,
        cfg,
        embeddings: embeddings as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
      } as never,
      api as never,
      buildToolScopeFilter,
      async () => "wal-id",
      async () => {},
      async () => [],
    );

    const storeTool = api.getTool("memory_store");
    const firstText = "Deployed the payment service to production version one.";
    const secondText = "DEPLOYED THE PAYMENT SERVICE TO PRODUCTION VERSION ONE.";

    const firstResult = (await storeTool?.execute("tc-1", {
      text: firstText,
      importance: 0.6,
    })) as { details?: { id?: string } };
    const factId = firstResult.details?.id as string;
    expect(factId).toBeTruthy();
    embedCalls.length = 0;

    // Bypass the cheap pre-check (see file header) so the real storeWithResult merge path runs.
    vi.spyOn(factsDb, "hasDuplicate").mockReturnValue(false);

    const secondResult = (await storeTool?.execute("tc-2", { text: secondText, importance: 0.6 })) as {
      details?: { action?: string };
    };
    expect(secondResult.details?.action).not.toBe("duplicate");

    const stored = factsDb.getById(factId);
    expect(stored?.text).toContain(firstText);
    expect(stored?.text).toContain(secondText);
    expect(stored?.text).not.toBe(firstText);

    // embeddings.embed() is legitimately called once with the raw incoming text before the
    // merge outcome is known (its result feeds vector-candidate resolution for dedupe), so
    // asserting against the full embedCalls log can't distinguish "also re-embedded correctly"
    // from "only embedded the pre-merge fragment". What actually matters is which text the
    // vector backend persists: assert directly on the `text` argument passed to vectorDb.store,
    // which is what LanceDB actually encodes for this fact going forward.
    expect(embedCalls.some((t) => t === stored?.text)).toBe(true);
    const storedTexts = vectorDb.store.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(storedTexts).toContain(stored?.text);
    expect(storedTexts.every((t) => t !== secondText)).toBe(true);
  });
});
