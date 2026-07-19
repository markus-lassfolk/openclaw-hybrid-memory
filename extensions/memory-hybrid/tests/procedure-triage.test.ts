import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertProcedure } from "../backends/facts-db/procedures/crud.js";
import { FactsDB } from "../backends/facts-db.js";
import { LoomStore } from "../backends/loom-store.js";
import { rankProcedureCandidates } from "../services/procedure-triage.js";

let tmpDir: string;
let factsDb: FactsDB;
let loomStore: LoomStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "procedure-triage-test-"));
  factsDb = new FactsDB(join(tmpDir, "memory.db"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  factsDb.close();
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("rankProcedureCandidates", () => {
  it("returns a bounded batch instead of the raw backlog list", () => {
    const db = factsDb.getRawDb();
    for (let i = 0; i < 30; i++) {
      upsertProcedure(db, {
        taskPattern: `restart service ${i} via ssh`,
        recipeJson: JSON.stringify({ steps: ["ssh", "systemctl restart"] }),
        procedureType: "positive",
        successCount: 3,
      });
    }
    const report = rankProcedureCandidates({ db, loomStore }, { batchSize: 5 });
    expect(report.backlog).toBe(30);
    expect(report.recommendedBatch.length).toBeLessThanOrEqual(5);
  });

  it("clusters near-duplicate procedures and reports a combined count", () => {
    const db = factsDb.getRawDb();
    upsertProcedure(db, {
      taskPattern: "restart hass via ssh bundled heredoc",
      recipeJson: "{}",
      procedureType: "positive",
      successCount: 4,
    });
    upsertProcedure(db, {
      taskPattern: "restart hass via ssh bundled heredoc script",
      recipeJson: "{}",
      procedureType: "positive",
      successCount: 2,
    });
    upsertProcedure(db, {
      taskPattern: "restart hass via ssh bundled heredoc call",
      recipeJson: "{}",
      procedureType: "positive",
      successCount: 1,
    });
    const report = rankProcedureCandidates({ db, loomStore }, { cluster: true });
    const clustered = report.recommendedBatch.find((c) => c.count >= 2);
    expect(clustered).toBeDefined();
  });

  it("flags a high-risk procedure with recorded failures", () => {
    const db = factsDb.getRawDb();
    upsertProcedure(db, {
      taskPattern: "drop table sessions on prod",
      recipeJson: JSON.stringify({ steps: ["DROP TABLE sessions"] }),
      procedureType: "positive",
      successCount: 1,
      failureCount: 2,
    });
    const report = rankProcedureCandidates({ db, loomStore });
    expect(report.recommendedBatch[0]?.risk).toBe("high");
  });

  it("detects an existing wrapper and does not re-recommend promotion", () => {
    const db = factsDb.getRawDb();
    const proc = upsertProcedure(db, {
      taskPattern: "unique wrapped procedure",
      recipeJson: "{}",
      procedureType: "positive",
      successCount: 5,
    });
    db.prepare("UPDATE procedures SET skill_path = ? WHERE id = ?").run("skills/wrapped-procedure/SKILL.md", proc.id);
    const report = rankProcedureCandidates({ db, loomStore });
    const item = report.recommendedBatch.find((c) => c.representativeProcedureId === proc.id);
    expect(item?.existingWrapper).toBe("skills/wrapped-procedure/SKILL.md");
    expect(item?.recommendedAction).toBe("no_action");
  });

  it("suppresses a cluster after a recorded no_action triage decision", () => {
    const db = factsDb.getRawDb();
    upsertProcedure(db, {
      taskPattern: "niche one-off task",
      recipeJson: "{}",
      procedureType: "positive",
      successCount: 1,
    });
    const first = rankProcedureCandidates({ db, loomStore });
    const clusterId = first.recommendedBatch[0]?.clusterId;
    expect(clusterId).toBeTruthy();
    if (!clusterId) throw new Error("expected a clusterId");
    loomStore.recordProcedureTriageDecision({ clusterId, decision: "no_action", rationale: "too niche" });
    const second = rankProcedureCandidates({ db, loomStore });
    expect(second.recommendedBatch.find((c) => c.clusterId === clusterId)).toBeUndefined();
  });
});
