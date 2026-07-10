/**
 * Regression test (#2067-followup) for cli/cmd-store.ts's `runStoreForCli`:
 *
 * `hybrid-mem store --supersedes <id>` called factsDb.supersede(supersedesId, entry.id) and
 * aliasDb?.deleteByFactId(supersedesId) directly on the caller-supplied fact id with no check
 * that the target belongs to the same scope/scopeTarget as the write. factsDb.supersede() itself
 * applies no scope filter, so any CLI caller who knew (or guessed) another tenant's fact id could
 * pass it as --supersedes and silently soft-delete (hide from recall) a fact outside their own
 * scope -- the same class of bug already fixed for the equivalent MCP tool path,
 * tools/memory/register-store-tools.ts's memory_store `supersedes` param (see
 * tests/memory-tools-cross-scope-mutation.test.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { HandlerContext } from "../cli/handlers.js";
import { runStoreForCli } from "../cli/handlers.js";
import type { StoreCliOpts } from "../cli/types.js";

let tmpDir: string;
let factsDb: FactsDB;
let mockCtx: HandlerContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cmd-store-supersedes-scope-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));

  mockCtx = {
    factsDb,
    cfg: {
      credentials: { enabled: false, store: "sqlite" as const },
      store: { classifyBeforeWrite: false },
    },
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    },
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      modelName: "test-embedding-model",
    },
  } as any;
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runStoreForCli --supersedes cross-scope isolation (#2067-followup)", () => {
  it("does not supersede a fact owned by a different agent scope", async () => {
    const otherAgentFact = factsDb.store({
      text: "worker-2's fact that should survive",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "worker-2",
    });

    const opts: StoreCliOpts = {
      text: "worker-1 attempting cross-scope supersede",
      category: "fact",
      scope: "agent",
      scopeTarget: "worker-1",
      supersedes: otherAgentFact.id,
    };
    const warn = vi.fn();
    const result = await runStoreForCli(mockCtx, opts, { warn });

    expect(result.outcome).toBe("stored");
    const reloaded = factsDb.getById(otherAgentFact.id);
    expect(reloaded?.supersededAt ?? null).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("blocked cross-scope"));
  });

  it("still supersedes a fact within the caller's own scope", async () => {
    const ownFact = factsDb.store({
      text: "worker-1's own outdated fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "worker-1",
    });

    const opts: StoreCliOpts = {
      text: "worker-1's replacement fact",
      category: "fact",
      scope: "agent",
      scopeTarget: "worker-1",
      supersedes: ownFact.id,
    };
    const result = await runStoreForCli(mockCtx, opts, { warn: vi.fn() });

    expect(result.outcome).toBe("stored");
    const reloaded = factsDb.getById(ownFact.id);
    expect(reloaded?.supersededAt ?? null).not.toBeNull();
  });
});
