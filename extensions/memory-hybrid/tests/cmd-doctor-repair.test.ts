import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDoctorCommand } from "../cli/cmd-doctor.js";
import { _testing } from "../index.js";
import type { AliasDB } from "../services/retrieval-aliases.js";

const { FactsDB, VectorDB } = _testing;
const DIM = 3;

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

function makeEmbeddings(dim = DIM) {
  const vector = new Array(dim).fill(0.1);
  vector[0] = 0.9;
  return {
    modelName: "test-embedding-model",
    dimensions: dim,
    embed: vi.fn(async (_text: string) => [...vector]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [...vector])),
  };
}

describe("doctor repair (--fix / --reconcile)", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setupHarness(
    options: {
      aliasDb?: InstanceType<typeof AliasDB> | null;
      embeddings?: ReturnType<typeof makeEmbeddings> | null;
      runBackup?: (...args: unknown[]) => Promise<unknown>;
      cfgOverrides?: Record<string, unknown>;
    } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-repair-"));
    tmpRoots.push(root);

    const sqlitePath = join(root, "facts.db");
    const factsDb = new FactsDB(sqlitePath);
    const vectorDb = new VectorDB(join(root, "lance"), DIM);
    const command = new FakeCommand();

    registerDoctorCommand(
      command as never,
      {
        sqlitePath,
        embedding: { provider: "openai", apiKey: "sk-test-doctor-repair" },
        ...options.cfgOverrides,
      } as never,
      factsDb,
      vectorDb,
      null,
      sqlitePath,
      options.aliasDb ?? null,
      (options.embeddings ?? null) as never,
      options.runBackup as never,
    );

    const doctor = command.children.find((child) => child.name === "doctor");
    if (!doctor?.handler) throw new Error("doctor command handler missing");

    return {
      root,
      sqlitePath,
      factsDb,
      vectorDb,
      runDoctor: doctor.handler as (opts?: Record<string, unknown>) => Promise<void>,
    };
  }

  async function runAndCapture(
    runDoctor: (opts?: Record<string, unknown>) => Promise<void>,
    opts?: Record<string, unknown>,
  ) {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDoctor(opts);
    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();
    return out;
  }

  it("resolves structural drift (duplicate Lance rows) automatically under plain --fix", async () => {
    const { factsDb, vectorDb, runDoctor } = setupHarness({ embeddings: makeEmbeddings() });
    const fact = factsDb.store({
      text: "structural drift fact",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });
    await vectorDb.store({ id: fact.id, text: fact.text, vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });
    await vectorDb.store({ id: fact.id, text: fact.text, vector: [0.4, 0.5, 0.6], importance: 0.5, category: "fact" });
    expect((await vectorDb.getAllIds()).filter((id) => id === fact.id)).toHaveLength(2);

    const out = await runAndCapture(runDoctor, { fix: true });
    expect(out).toContain("Structural drift repaired");
    expect((await vectorDb.getAllIds()).filter((id) => id === fact.id)).toHaveLength(1);

    factsDb.close();
    await vectorDb.close();
  });

  it("reports ID-set orphan drift under plain --fix without deleting it, then reconciles under --fix --reconcile", async () => {
    const runBackup = vi.fn(async () => ({
      ok: true as const,
      backupDir: "/tmp/fake-backup",
      sqliteSize: 0,
      lancedbSize: 0,
      durationMs: 0,
      integrityOk: true,
      snapshotSkewMs: 0,
    }));
    const { factsDb, vectorDb, runDoctor } = setupHarness({ embeddings: makeEmbeddings(), runBackup });

    const orphanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await vectorDb.store({ id: orphanId, text: "orphan", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });

    const outNoReconcile = await runAndCapture(runDoctor, { fix: true });
    expect(outNoReconcile).toContain("ID-set drift");
    expect(await vectorDb.getAllIds()).toContain(orphanId);
    expect(runBackup).not.toHaveBeenCalled();

    const outReconcile = await runAndCapture(runDoctor, { fix: true, reconcile: true });
    expect(outReconcile).toContain("Orphan drift reconciled");
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(await vectorDb.getAllIds()).not.toContain(orphanId);

    factsDb.close();
    await vectorDb.close();
  });

  it("--reconcile alone (no --fix) stays report-only", async () => {
    const { factsDb, vectorDb, runDoctor } = setupHarness({ embeddings: makeEmbeddings() });
    const orphanId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await vectorDb.store({ id: orphanId, text: "orphan", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });

    await runAndCapture(runDoctor, { reconcile: true });
    expect(await vectorDb.getAllIds()).toContain(orphanId);

    factsDb.close();
    await vectorDb.close();
  });

  it("aborts orphan reconcile when the auto-backup fails first", async () => {
    const runBackup = vi.fn(async () => ({ ok: false as const, error: "disk full" }));
    const { factsDb, vectorDb, runDoctor } = setupHarness({ embeddings: makeEmbeddings(), runBackup });

    const orphanId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await vectorDb.store({ id: orphanId, text: "orphan", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });

    const out = await runAndCapture(runDoctor, { fix: true, reconcile: true });
    expect(out).toContain("auto-backup before reconcile failed");
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(await vectorDb.getAllIds()).toContain(orphanId);

    factsDb.close();
    await vectorDb.close();
  });

  it("aborts orphan reconcile when the backup succeeds but fails its own integrity check (QA follow-up)", async () => {
    // runBackup() returns ok:true even when PRAGMA integrity_check failed on the source (VACUUM
    // INTO doesn't fail just because the source was already corrupt) — a backup like that is a
    // snapshot of the corruption, not a real restore point, and must not green-light the delete.
    const runBackup = vi.fn(async () => ({
      ok: true as const,
      integrityOk: false,
      backupDir: "/tmp/fake-backup",
      sqliteSize: 0,
      lancedbSize: 0,
      durationMs: 0,
      snapshotSkewMs: 0,
    }));
    const { factsDb, vectorDb, runDoctor } = setupHarness({ embeddings: makeEmbeddings(), runBackup });

    const orphanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await vectorDb.store({ id: orphanId, text: "orphan", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });

    const out = await runAndCapture(runDoctor, { fix: true, reconcile: true });
    expect(out).toContain("auto-backup before reconcile failed");
    expect(out).toContain("integrity_check");
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(await vectorDb.getAllIds()).toContain(orphanId);

    factsDb.close();
    await vectorDb.close();
  });

  it("repairs alias Lance mismatch under --fix when aliasDb + embeddings are wired in", async () => {
    // Doctor's own repair orchestration is under test here (call rebuildLanceFromSqlite when a
    // mismatch is seen, then re-check) — not AliasDB's internals, which have their own test suite.
    // A fake aliasDb keeps this deterministic instead of fighting real LanceDB dimension-reopen
    // edge cases, matching the existing fake-vectorDb pattern used in cmd-doctor-fts.test.ts.
    let repaired = false;
    const rebuildLanceFromSqlite = vi.fn(async (_embeddings: unknown, opts: { reEmbed: boolean }) => {
      repaired = true;
      return { stored: 1, skipped: 0, reEmbedded: opts.reEmbed ? 1 : 0, errors: [] };
    });
    const getLanceDiagnostics = vi.fn(async () =>
      repaired
        ? { schemaValid: true, configuredDim: 3, lanceDim: 3, sqliteAliasRows: 1 }
        : { schemaValid: false, configuredDim: 3, lanceDim: null, sqliteAliasRows: 1 },
    );
    const aliasDb = { getLanceDiagnostics, rebuildLanceFromSqlite };

    const { factsDb, vectorDb, runDoctor } = setupHarness({
      aliasDb: aliasDb as unknown as InstanceType<typeof AliasDB>,
      embeddings: makeEmbeddings(3),
      cfgOverrides: { aliases: { enabled: true, maxAliases: 10 } },
    });

    const out = await runAndCapture(runDoctor, { fix: true });
    expect(out).toContain("Alias Lance rebuilt");
    expect(rebuildLanceFromSqlite).toHaveBeenCalledTimes(1);
    expect(getLanceDiagnostics).toHaveBeenCalledTimes(2);

    factsDb.close();
    await vectorDb.close();
  });

  it("restores quarantined goal files under --fix when they parse as valid Goal JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-goals-"));
    tmpRoots.push(root);
    const goalsDir = join(root, "goals");
    mkdirSync(goalsDir, { recursive: true });
    const goalId = "goal-repair-test";
    writeFileSync(
      join(goalsDir, `${goalId}.json.corrupt`),
      JSON.stringify({
        id: goalId,
        label: "test-goal",
        status: "active",
        priority: "medium",
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    const { factsDb, vectorDb, runDoctor } = setupHarness({
      cfgOverrides: { goalStewardship: { enabled: true, goalsDir } },
    });

    const out = await runAndCapture(runDoctor, { fix: true });
    expect(out).toContain("Restored 1 quarantined goal file(s)");
    expect(existsSync(join(goalsDir, `${goalId}.json`))).toBe(true);
    expect(existsSync(join(goalsDir, `${goalId}.json.corrupt`))).toBe(false);

    factsDb.close();
    await vectorDb.close();
  });
});
