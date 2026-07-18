import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { LoomStore } from "../backends/loom-store.js";
import { runDriftScout, scanFactsForDeprecatedCommands } from "../services/drift-scout.js";

let tmpDir: string;
let factsDb: FactsDB;
let loomStore: LoomStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "drift-scout-test-"));
  factsDb = new FactsDB(join(tmpDir, "memory.db"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  factsDb.close();
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanFactsForDeprecatedCommands (deprecated command fixture)", () => {
  it("finds a deprecated command reference and suggests the replacement", () => {
    const facts = [{ id: "f1", text: "Run `openclaw hybrid-mem old-cmd` to check status.", category: "project" }];
    const findings = scanFactsForDeprecatedCommands(facts, { "old-cmd": "new-cmd" });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.driftType).toBe("deprecated_command");
    expect(findings[0]?.replacementText).toBe("new-cmd");
    expect(findings[0]?.affectedIds?.[0]?.id).toBe("f1");
  });

  it("finds nothing when no deprecated commands are configured", () => {
    const facts = [{ id: "f1", text: "some text", category: "project" }];
    expect(scanFactsForDeprecatedCommands(facts, {})).toHaveLength(0);
  });
});

describe("runDriftScout (superseded fact fixture)", () => {
  it("detects a deprecated command in facts and persists a drift finding", () => {
    factsDb.store({
      text: "Use `hybrid-mem old-report` for weekly reports.",
      category: "project",
      importance: 0.5,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const report = runDriftScout(
      { factsDb, loomStore },
      { deprecatedCommands: { "old-report": "new-report" }, include: ["facts"] },
    );
    expect(report.newCount).toBe(1);
    expect(report.findings[0]?.driftType).toBe("deprecated_command");
  });

  it("dedups on a second scan (existingCount, not newCount)", () => {
    factsDb.store({
      text: "Use old-cmd here",
      category: "project",
      importance: 0.5,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const opts = { deprecatedCommands: { "old-cmd": "new-cmd" }, include: ["facts" as const] };
    const first = runDriftScout({ factsDb, loomStore }, opts);
    expect(first.newCount).toBe(1);
    const second = runDriftScout({ factsDb, loomStore }, opts);
    expect(second.newCount).toBe(0);
    expect(second.existingCount).toBe(1);
  });

  it("apply_safe mechanically rewrites the affected fact text and resolves the finding", () => {
    const created = factsDb.store({
      text: "Run old-cmd nightly.",
      category: "project",
      importance: 0.5,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const report = runDriftScout(
      { factsDb, loomStore },
      { deprecatedCommands: { "old-cmd": "new-cmd" }, include: ["facts"], applySafe: true },
    );
    expect(report.appliedSafeCount).toBe(1);
    expect(report.findings[0]?.status).toBe("resolved");
    const updated = factsDb.getAll({ includeSuperseded: true }).find((f) => f.id === created.id);
    expect(updated?.text).toContain("new-cmd");
    expect(updated?.text).not.toContain("old-cmd");
  });

  it("surfaces an unresolved contradiction as a contradicted_fact drift finding", () => {
    const a = factsDb.store({
      text: "The server is at 10.0.0.1",
      category: "fact",
      importance: 0.5,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const b = factsDb.store({
      text: "The server is at 10.0.0.2",
      category: "fact",
      importance: 0.5,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const db = factsDb.getRawDb();
    db.prepare(
      "INSERT INTO contradictions (id, fact_id_new, fact_id_old, detected_at, resolved) VALUES (?, ?, ?, ?, 0)",
    ).run("contra-1", b.id, a.id, new Date().toISOString());

    const report = runDriftScout({ factsDb, loomStore }, { deprecatedCommands: {}, include: ["facts"] });
    const contradictionFindings = report.findings.filter((f) => f.driftType === "contradicted_fact");
    expect(contradictionFindings.length).toBeGreaterThanOrEqual(1);
  });
});
