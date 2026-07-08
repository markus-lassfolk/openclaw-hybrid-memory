import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { syncActiveTaskEntryToFacts } from "../services/task-ledger-facts.js";
import type { VectorDB } from "../backends/vector-db.js";

/**
 * Regression coverage for the cross-tenant active-task auto-create leak (loop iteration 22):
 * `syncActiveTaskEntryToFacts` previously forwarded only `latestByEntityKey` to
 * `upsertProjectTaskKey`, so the helper wrote every persisted fact at global scope. Lifecycle
 * callers that resolved a non-global scopeFilter for the read side then wrote back at global
 * scope, causing a facts-ledger session's auto-created long-running task to surface in other
 * tenants' active-task ledgers. The fix threads an optional `scopeFilter` opt through to
 * `upsertProjectTaskKey` and the retire/find helpers so the auto-created task carries the
 * caller's agent/user/session scope.
 */
describe("syncActiveTaskEntryToFacts scope preservation", () => {
  let dir: string;
  let db: FactsDB;
  const vectorDb = {} as unknown as VectorDB;
  const embeddings = {
    modelName: "test-model",
    embed: async () => new Float32Array([0.1, 0.2, 0.3]),
  } as unknown as EmbeddingProvider;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "task-ledger-scope-sync-"));
    db = new FactsDB(join(dir, "facts.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes every fact at the caller-provided agent scope when scopeFilter is supplied", async () => {
    await syncActiveTaskEntryToFacts(
      db,
      vectorDb,
      embeddings,
      {
        label: "scope-threaded-task",
        description: "Threaded task",
        status: "in_progress",
        updated: "2026-07-08T12:00:00.000Z",
        started: "2026-07-08T12:00:00.000Z",
      },
      undefined,
      { scopeFilter: { agentId: "forge" } },
    );

    const rows = db
      .getRawDb()
      .prepare("SELECT entity, key, scope, scope_target FROM facts WHERE entity = ? AND category = 'project'")
      .all("scope-threaded-task") as Array<{
      entity: string;
      key: string;
      scope: string;
      scope_target: string | null;
    }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.scope).toBe("agent");
      expect(row.scope_target).toBe("forge");
    }
  });

  it("keeps the historical global-scope behavior when no scopeFilter is supplied", async () => {
    await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
      label: "global-task",
      description: "Global task",
      status: "in_progress",
      updated: "2026-07-08T12:00:00.000Z",
      started: "2026-07-08T12:00:00.000Z",
    });

    const rows = db
      .getRawDb()
      .prepare("SELECT entity, key, scope, scope_target FROM facts WHERE entity = ? AND category = 'project'")
      .all("global-task") as Array<{
      entity: string;
      key: string;
      scope: string;
      scope_target: string | null;
    }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.scope).toBe("global");
      expect(row.scope_target).toBeNull();
    }
  });

  it("does not leak the scope-threaded task into another agent's active-task ledger", async () => {
    await syncActiveTaskEntryToFacts(
      db,
      vectorDb,
      embeddings,
      {
        label: "tenant-isolation-task",
        description: "Should be isolated",
        status: "in_progress",
        updated: "2026-07-08T12:00:00.000Z",
        started: "2026-07-08T12:00:00.000Z",
      },
      undefined,
      { scopeFilter: { agentId: "forge" } },
    );

    // A different agent asks for all active tasks: must NOT see forge's task.
    const otherAgentFilter = { agentId: "triage" };
    const facts = db.getProjectFacts(1000, otherAgentFilter);
    const labels = facts.filter((f) => f.entity === "tenant-isolation-task").map((f) => f.entity);
    expect(labels).toEqual([]);

    // The owning agent still sees its own task.
    const ownerFacts = db.getProjectFacts(1000, { agentId: "forge" });
    expect(ownerFacts.some((f) => f.entity === "tenant-isolation-task")).toBe(true);
  });
});
