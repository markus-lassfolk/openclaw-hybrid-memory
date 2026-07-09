/**
 * Regression test (loop iteration 110): runStoreForCli's duplicate pre-check called
 * factsDb.hasDuplicate(text, "cli", {category, entity, key, value}) with no scope/scopeTarget
 * args, computed *before* scope was resolved a few lines below. hasDuplicate's dedupe probe
 * therefore always ran as if scope="global", so a scoped store (--scope agent --scope-target X)
 * with the same text as an unrelated global fact was silently rejected as "duplicate" — the
 * identical bug already fixed in the sibling tools/memory/register-store-tools.ts MCP path
 * (commit a471c545).
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
  tmpDir = mkdtempSync(join(tmpdir(), "cmd-store-scope-dup-"));
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

describe("runStoreForCli scope-aware duplicate check (loop iteration 110 regression)", () => {
  it("does not reject a scoped store as a duplicate of an unrelated global fact with the same text", async () => {
    const globalOpts: StoreCliOpts = {
      text: "The deploy runbook lives in docs/runbook.md",
      category: "technical",
    };
    const globalResult = await runStoreForCli(mockCtx, globalOpts, { warn: vi.fn() });
    expect(globalResult.outcome).toBe("stored");

    const scopedOpts: StoreCliOpts = {
      text: "The deploy runbook lives in docs/runbook.md",
      category: "technical",
      scope: "agent",
      scopeTarget: "tenant-a",
    };
    const scopedResult = await runStoreForCli(mockCtx, scopedOpts, { warn: vi.fn() });
    expect(scopedResult.outcome).toBe("stored");

    if (globalResult.outcome === "stored" && scopedResult.outcome === "stored") {
      expect(scopedResult.id).not.toBe(globalResult.id);
      const scopedEntry = factsDb.getById(scopedResult.id);
      expect(scopedEntry?.scope).toBe("agent");
      expect(scopedEntry?.scopeTarget).toBe("tenant-a");
    }
  });

  it("still rejects a true duplicate within the same scope", async () => {
    const opts: StoreCliOpts = {
      text: "The staging environment uses a read replica",
      category: "technical",
      scope: "agent",
      scopeTarget: "tenant-a",
    };
    const first = await runStoreForCli(mockCtx, opts, { warn: vi.fn() });
    expect(first.outcome).toBe("stored");

    const second = await runStoreForCli(mockCtx, opts, { warn: vi.fn() });
    expect(second.outcome).toBe("duplicate");
  });
});
