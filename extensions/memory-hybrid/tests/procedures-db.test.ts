import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FactsDB } from "../backends/facts-db.js";

let tmpDir: string;
let db: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "procedures-db-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("FactsDB procedures table", () => {
  it("upsertProcedure inserts new procedure and returns entry", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Check Moltbook status",
      recipeJson: JSON.stringify([{ tool: "web_fetch", args: { url: "https://api.example.com" } }]),
      procedureType: "positive",
      successCount: 1,
      confidence: 0.6,
      ttlDays: 30,
    });
    expect(proc.id).toBeDefined();
    expect(proc.taskPattern).toBe("Check Moltbook status");
    expect(proc.procedureType).toBe("positive");
    expect(proc.successCount).toBe(1);
    expect(proc.promotedToSkill).toBe(0);
    expect(proc.skillPath).toBeNull();
  });

  it("getProcedureById returns null for unknown id", () => {
    expect(db.getProcedureById("nonexistent-id")).toBeNull();
  });

  it("getProcedureById returns stored procedure", () => {
    const created = db.upsertProcedure({
      taskPattern: "HA health check",
      recipeJson: "[]",
      procedureType: "positive",
    });
    const found = db.getProcedureById(created.id);
    expect(found).not.toBeNull();
    expect(found!.taskPattern).toBe("HA health check");
  });

  it("searchProcedures finds by task pattern words", () => {
    db.upsertProcedure({
      taskPattern: "Check Home Assistant health",
      recipeJson: "[]",
      procedureType: "positive",
    });
    const results = db.searchProcedures("Home Assistant health", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((p) => p.taskPattern.includes("Home Assistant"))).toBe(true);
  });

  it("getNegativeProceduresMatching returns only negative procedures", () => {
    db.upsertProcedure({
      taskPattern: "Moltbook dead endpoint",
      recipeJson: "[]",
      procedureType: "negative",
    });
    db.upsertProcedure({
      taskPattern: "Moltbook working flow",
      recipeJson: "[]",
      procedureType: "positive",
    });
    const negs = db.getNegativeProceduresMatching("Moltbook", 10);
    expect(negs.every((p) => p.procedureType === "negative")).toBe(true);
  });

  it("recordProcedureSuccess increments success_count and last_validated", () => {
    const created = db.upsertProcedure({
      taskPattern: "Test procedure",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 2,
    });
    const ok = db.recordProcedureSuccess(created.id);
    expect(ok).toBe(true);
    const after = db.getProcedureById(created.id);
    expect(after!.successCount).toBe(3);
    expect(after!.lastValidated).toBeGreaterThan(0);
  });

  it("recordProcedureFailure increments failure_count", () => {
    const created = db.upsertProcedure({
      taskPattern: "Failing procedure",
      recipeJson: "[]",
      procedureType: "negative",
      failureCount: 1,
    });
    db.recordProcedureFailure(created.id);
    const after = db.getProcedureById(created.id);
    expect(after!.failureCount).toBe(2);
  });

  it("getProceduresReadyForSkill returns only positive with success_count >= threshold", () => {
    db.upsertProcedure({
      taskPattern: "Low success",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 1,
    });
    const high = db.upsertProcedure({
      taskPattern: "High success",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 5,
    });
    const ready = db.getProceduresReadyForSkill(3, 10);
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready.some((p) => p.id === high.id)).toBe(true);
  });

  it("markProcedurePromoted sets promoted_to_skill and skill_path", () => {
    const created = db.upsertProcedure({
      taskPattern: "Promote me",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 5,
    });
    const ok = db.markProcedurePromoted(created.id, "skills/auto/check-moltbook");
    expect(ok).toBe(true);
    const after = db.getProcedureById(created.id);
    expect(after!.promotedToSkill).toBe(1);
    expect(after!.skillPath).toBe("skills/auto/check-moltbook");
  });

  it("getStaleProcedures returns procedures past TTL", () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 24 * 3600; // 60 days ago
    db.upsertProcedure({
      taskPattern: "Old procedure",
      recipeJson: "[]",
      procedureType: "positive",
      lastValidated: old,
    });
    const stale = db.getStaleProcedures(30, 10);
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });
});

describe("FactsDB procedure columns on facts", () => {
  it("store accepts procedureType and successCount", () => {
    const entry = db.store({
      text: "Procedure: check API worked 3 times",
      category: "procedure",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "distillation",
      procedureType: "positive",
      successCount: 3,
      lastValidated: Math.floor(Date.now() / 1000),
      sourceSessions: JSON.stringify(["s1", "s2"]),
    });
    expect(entry.id).toBeDefined();
    expect(entry.procedureType).toBe("positive");
    expect(entry.successCount).toBe(3);
    const retrieved = db.getById(entry.id);
    expect(retrieved!.procedureType).toBe("positive");
    expect(retrieved!.successCount).toBe(3);
  });
});
