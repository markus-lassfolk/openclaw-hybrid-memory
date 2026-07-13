import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { registerDoctorCommand } from "../cli/cmd-doctor.js";

class FakeCommand {
  children: FakeCommand[] = [];
  handler: ((...args: unknown[]) => unknown) | null = null;

  constructor(public name = "root") {}

  command(name: string): FakeCommand {
    const child = new FakeCommand(name.split(/\s+/)[0]);
    this.children.push(child);
    return child;
  }

  description(): FakeCommand {
    return this;
  }

  option(): FakeCommand {
    return this;
  }

  action(fn: (...args: unknown[]) => unknown): FakeCommand {
    this.handler = fn;
    return this;
  }
}

describe("doctor FTS consistency checks", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setupDoctorHarness() {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-fts-"));
    tmpRoots.push(root);

    const sqlitePath = join(root, "facts.db");
    const factsDb = new FactsDB(sqlitePath);
    const command = new FakeCommand();

    registerDoctorCommand(
      command as never,
      { sqlitePath, embedding: { provider: "openai", apiKey: "sk-test-doctor-fts" } } as never,
      factsDb,
      { getAllIds: async () => [] } as never,
    );

    const doctor = command.children.find((child) => child.name === "doctor");
    if (!doctor?.handler) throw new Error("doctor command handler missing");

    return { root, sqlitePath, factsDb, runDoctor: doctor.handler };
  }

  it("detects FTS population drift when a facts row is missing from facts_fts", async () => {
    const { factsDb, sqlitePath, runDoctor } = setupDoctorHarness();

    const fact = factsDb.store({
      text: "doctor drift fact",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });

    const raw = new DatabaseSync(sqlitePath);
    raw.prepare("DELETE FROM facts_fts WHERE rowid = (SELECT rowid FROM facts WHERE id = ?)").run(fact.id);
    raw.close();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDoctor();

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("FTS drift detected");
    expect(out).toContain("doctor --fix");

    factsDb.close();
  });

  it("doctor --fix rebuilds facts_fts and verifies consistency", async () => {
    const { factsDb, sqlitePath, runDoctor } = setupDoctorHarness();

    const fact = factsDb.store({
      text: "doctor rebuild fact",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });

    const raw = new DatabaseSync(sqlitePath);
    raw.prepare("DELETE FROM facts_fts WHERE rowid = (SELECT rowid FROM facts WHERE id = ?)").run(fact.id);
    raw.close();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDoctor({ fix: true });

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("Rebuilt FTS index");

    const snapshot = factsDb.getFtsConsistencySnapshot();
    expect(snapshot.missingFactsInFts).toBe(0);
    expect(snapshot.extraFtsRows).toBe(0);

    factsDb.close();
  });

  it("doctor --fix recreates a dropped facts_fts table/triggers via live migration and reindexes", async () => {
    const { factsDb, sqlitePath, runDoctor } = setupDoctorHarness();

    factsDb.store({
      text: "structural drift fact",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });

    const raw = new DatabaseSync(sqlitePath);
    raw.exec("DROP TRIGGER IF EXISTS facts_ai");
    raw.exec("DROP TRIGGER IF EXISTS facts_ad");
    raw.exec("DROP TRIGGER IF EXISTS facts_au");
    raw.exec("DROP TABLE IF EXISTS facts_fts");
    raw.close();

    const snapshotBefore = factsDb.getFtsConsistencySnapshot();
    expect(snapshotBefore.ftsTableExists).toBe(false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDoctor({ fix: true });
    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("Rebuilt facts_fts table/triggers via migration");

    const snapshotAfter = factsDb.getFtsConsistencySnapshot();
    expect(snapshotAfter.ftsTableExists).toBe(true);
    expect(snapshotAfter.missingTriggers).toHaveLength(0);
    expect(snapshotAfter.missingFactsInFts).toBe(0);
    expect(snapshotAfter.extraFtsRows).toBe(0);

    factsDb.close();
  });

  it("reports fail (not warn) when the reindex throws after a successful structural migration (QA follow-up)", async () => {
    const { factsDb, sqlitePath, runDoctor } = setupDoctorHarness();

    factsDb.store({
      text: "structural drift fact",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });

    const raw = new DatabaseSync(sqlitePath);
    raw.exec("DROP TRIGGER IF EXISTS facts_ai");
    raw.exec("DROP TRIGGER IF EXISTS facts_ad");
    raw.exec("DROP TRIGGER IF EXISTS facts_au");
    raw.exec("DROP TABLE IF EXISTS facts_fts");
    raw.close();

    // Migration itself succeeds (recreates the table/triggers), but the immediately-chained
    // reindex hard-fails — must report the same "fail" severity as the pre-existing
    // population-drift-only branch's own rebuildFtsIndex() failure, not a downgraded "warn".
    vi.spyOn(factsDb, "rebuildFtsIndex").mockImplementation(() => {
      throw new Error("disk full");
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDoctor({ fix: true });
    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("🔴 FTS Index/Triggers");
    expect(out).toContain("reindex failed");
    expect(process.exitCode).toBe(1);

    factsDb.close();
  });

  it("doctor --deep runs FTS trigger probe", async () => {
    const { factsDb, runDoctor } = setupDoctorHarness();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDoctor({ deep: true });

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("FTS Trigger Probe (Deep)");
    expect(out).toContain("Insert/update/delete trigger round-trip verified");

    factsDb.close();
  });
});
