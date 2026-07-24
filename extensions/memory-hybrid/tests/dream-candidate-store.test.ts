/**
 * Dream candidate store CRUD + lifecycle (#2170).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";

describe("DreamCandidateStore (#2170)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-cand-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a pending dream run and appends candidates without mutating live facts", () => {
    const before = factsDb.count();
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds: ["s1"],
      shadow: true,
    });
    expect(run.status).toBe("pending");
    expect(run.shadow).toBe(true);

    store.appendCandidateEntries(run.id, [
      {
        op: "add",
        payload: {
          text: "candidate insight",
          category: "preference",
          importance: 0.6,
          source: "dream",
          entity: null,
          key: null,
          value: null,
          scope: "session",
          scopeTarget: "s1",
        },
        evidence: {
          sessionIds: ["s1"],
          prevalence: { sessions: 1, agents: 1 },
          rationale: "test",
        },
        reverse: { op: "delete_fact", payload: {} },
      },
    ]);

    expect(store.listCandidateEntries(run.id)).toHaveLength(1);
    expect(factsDb.count()).toBe(before);
  });

  it("enforces status transitions", () => {
    const run = store.createDreamRun({ inputStoreRevision: "abc" });
    store.updateDreamRunStatus(run.id, "running");
    store.updateDreamRunStatus(run.id, "gated");
    expect(() => store.updateDreamRunStatus(run.id, "pending")).toThrow(/illegal status/);
  });

  it("migration creates dream candidate tables", () => {
    const names = (
      factsDb
        .getRawDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dream_runs','memory_candidate_entries')",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names.sort()).toEqual(["dream_runs", "memory_candidate_entries"]);
  });
});
