import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBackupStatus, pruneBackups, runBackup, runBackupVerify } from "../cli/backup.js";

describe("backup", () => {
  let testDir: string;
  let sqlitePath: string;
  let lancePath: string;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(tmpdir(), `backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    sqlitePath = join(testDir, "test-memory.db");
    lancePath = join(testDir, "test-lancedb");

    // Create a test SQLite database with a facts table
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        superseded_by TEXT,
        superseded_at INTEGER
      );
    `);
    db.exec(
      "INSERT INTO facts (content, superseded_by, superseded_at) VALUES ('test fact 1', NULL, NULL), ('test fact 2', NULL, NULL);",
    );
    db.close();

    // Create a test LanceDB directory with some dummy files
    mkdirSync(lancePath, { recursive: true });
    writeFileSync(join(lancePath, "data.lance"), "test lance data");
    writeFileSync(join(lancePath, "manifest.json"), JSON.stringify({ version: 1 }));
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("runBackup", () => {
    it("should create a timestamped backup directory", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.backupDir).toMatch(/[\\/]backups[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
        expect(existsSync(result.backupDir)).toBe(true);
      }
    });

    it("should backup SQLite database using VACUUM INTO", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const backedUpDb = join(result.backupDir, "test-memory.db");
        expect(existsSync(backedUpDb)).toBe(true);

        // Verify the backed up database has the correct data
        const db = new DatabaseSync(backedUpDb, { readOnly: true });
        const rows = db.prepare("SELECT COUNT(*) as count FROM facts WHERE superseded_by IS NULL").all() as Array<{
          count: number;
        }>;
        expect(rows[0].count).toBe(2);
        db.close();
      }
    });

    it("should report SQLite backup size", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sqliteSize).toBeGreaterThan(0);
      }
    });

    it("should backup LanceDB directory recursively", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const backedUpLance = join(result.backupDir, "test-lancedb");
        expect(existsSync(backedUpLance)).toBe(true);
        expect(existsSync(join(backedUpLance, "data.lance"))).toBe(true);
        expect(existsSync(join(backedUpLance, "manifest.json"))).toBe(true);

        // Verify content
        const content = readFileSync(join(backedUpLance, "data.lance"), "utf-8");
        expect(content).toBe("test lance data");
      }
    });

    it("should report LanceDB backup size", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lancedbSize).toBeGreaterThan(0);
      }
    });

    it("should report integrity check status", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.integrityOk).toBe(true);
      }
    });

    it("should report backup duration", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("writes a backup-manifest.json recording snapshot timestamps for drift detection (#81)", async () => {
      const backupDir = join(testDir, "backups");
      const before = Date.now();
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.sqliteSnapshotAt).toBeDefined();
      expect(result.lancedbSnapshotAt).toBeDefined();
      // SQLite is snapshotted first, then LanceDB — the two timestamps must be ordered and
      // both fall within the call's wall-clock window.
      expect(result.sqliteSnapshotAt).toBeGreaterThanOrEqual(before);
      expect(result.lancedbSnapshotAt).toBeGreaterThanOrEqual(result.sqliteSnapshotAt as number);
      expect(result.lancedbSnapshotAt).toBeLessThanOrEqual(after);
      expect(result.snapshotSkewMs).toBeGreaterThanOrEqual(0);

      const manifestPath = join(result.backupDir, "backup-manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest).toMatchObject({
        version: 1,
        sqliteSnapshotAt: result.sqliteSnapshotAt,
        lancedbSnapshotAt: result.lancedbSnapshotAt,
        snapshotSkewMs: result.snapshotSkewMs,
        sqliteSize: result.sqliteSize,
        lancedbSize: result.lancedbSize,
        integrityOk: result.integrityOk,
      });
    });

    it("manifest records null snapshot timestamps for a half that doesn't exist", async () => {
      const backupDir = join(testDir, "backups");
      const missingLancePath = join(testDir, "does-not-exist-lancedb");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: missingLancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.sqliteSnapshotAt).toBeDefined();
      expect(result.lancedbSnapshotAt).toBeUndefined();
      expect(result.snapshotSkewMs).toBe(0);

      const manifest = JSON.parse(readFileSync(join(result.backupDir, "backup-manifest.json"), "utf-8"));
      expect(manifest.lancedbSnapshotAt).toBeNull();
    });

    it("should handle missing SQLite file gracefully", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: join(testDir, "nonexistent.db"),
        resolvedLancePath: lancePath,
        backupDir,
      });

      // Should succeed but with zero SQLite size
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sqliteSize).toBe(0);
        expect(result.lancedbSize).toBeGreaterThan(0);
        // No integrity check ever ran (no SQLite file present), so integrityOk must not claim
        // "checked and passed" — it previously defaulted to true here, falsely implying a
        // check happened when a misconfigured/typo'd path (or a fresh vault with no DB yet)
        // means nothing was actually verified.
        expect(result.integrityOk).toBe(false);
      }
    });

    it("creates distinct backup directories for two runs within the same second", async () => {
      const backupDir = join(testDir, "backups");
      const [first, second] = await Promise.all([
        runBackup({ resolvedSqlitePath: sqlitePath, resolvedLancePath: lancePath, backupDir }),
        runBackup({ resolvedSqlitePath: sqlitePath, resolvedLancePath: lancePath, backupDir }),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.backupDir).not.toBe(second.backupDir);
      }
    });

    it("removes the half-written backup directory when LanceDB copy fails partway", async () => {
      const backupDir = join(testDir, "backups");
      // Force copyDirSync to fail: its source is a *file*, not a directory, so
      // mkdirSync(dest, {recursive:true}) creates `dest` as a directory, then cpSync(file, dir)
      // throws (can't copy a file onto an existing directory path). Avoids relying on chmod-based
      // permission simulation, which doesn't work when tests run as root.
      const brokenLancePath = join(testDir, "broken-lance-source");
      writeFileSync(brokenLancePath, "not a directory");

      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: brokenLancePath,
        backupDir,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The half-complete backup dir (valid memory.db already written, lancedb copy failed)
        // must be cleaned up, not left behind looking like a legitimate backup.
        const dirs = existsSync(backupDir) ? readdirSync(backupDir) : [];
        expect(dirs.length).toBe(0);
      }
    });

    it("should handle missing LanceDB directory gracefully", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: join(testDir, "nonexistent-lance"),
        backupDir,
      });

      // Should succeed but with zero LanceDB size
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sqliteSize).toBeGreaterThan(0);
        expect(result.lancedbSize).toBe(0);
      }
    });

    it("should return error when backup directory cannot be created", async () => {
      const invalidBackupDir = join(testDir, "backup-root-is-a-file");
      writeFileSync(invalidBackupDir, "not-a-directory");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir: invalidBackupDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Failed to create backup directory");
      }
    });

    it("should handle nested LanceDB directory structure", async () => {
      // Create nested structure
      const nestedDir = join(lancePath, "subdirectory");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, "nested-data.txt"), "nested content");

      const backupDir = join(testDir, "backups");
      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const backedUpNested = join(result.backupDir, "test-lancedb", "subdirectory", "nested-data.txt");
        expect(existsSync(backedUpNested)).toBe(true);
        const content = readFileSync(backedUpNested, "utf-8");
        expect(content).toBe("nested content");
      }
    });
  });

  describe("runBackupVerify", () => {
    it("should verify database integrity successfully", () => {
      const result = runBackupVerify({ resolvedSqlitePath: sqlitePath });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.integrityOk).toBe(true);
        expect(result.sqlitePath).toBe(sqlitePath);
        expect(result.factCount).toBe(2);
        expect(result.message).toContain("SQLite integrity OK");
        expect(result.message).toContain("2 active facts");
      }
    });

    it("should count only non-superseded facts", () => {
      // Add a superseded fact
      const db = new DatabaseSync(sqlitePath);
      db.exec(
        "INSERT INTO facts (content, superseded_by, superseded_at) VALUES ('superseded fact', 'fact-123', 1700000000);",
      );
      db.close();

      const result = runBackupVerify({ resolvedSqlitePath: sqlitePath });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.factCount).toBe(2); // Still 2, not 3
      }
    });

    it("counts an evicted fact (superseded_at set, superseded_by NULL) as inactive (#82)", () => {
      // The daily-quota eviction path and expiry/decay pruning only set superseded_at — there's
      // no replacement fact, so superseded_by stays NULL. Filtering on superseded_by IS NULL
      // (the pre-fix behavior) would have miscounted this as still active.
      const db = new DatabaseSync(sqlitePath);
      db.exec("INSERT INTO facts (content, superseded_by, superseded_at) VALUES ('evicted fact', NULL, 1700000000);");
      db.close();

      const result = runBackupVerify({ resolvedSqlitePath: sqlitePath });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.factCount).toBe(2); // Still 2, not 3
      }
    });

    it("should return error when database file does not exist", () => {
      const result = runBackupVerify({ resolvedSqlitePath: join(testDir, "nonexistent.db") });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SQLite database not found");
      }
    });

    it("should detect corrupted database", () => {
      // Corrupt the database by writing random data
      writeFileSync(sqlitePath, "corrupted data that is not a valid SQLite file");

      const result = runBackupVerify({ resolvedSqlitePath: sqlitePath });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Verification failed");
      }
    });

    it("should handle database with no facts table", () => {
      // Create a database without facts table
      const emptyDbPath = join(testDir, "empty.db");
      const db = new DatabaseSync(emptyDbPath);
      db.exec("CREATE TABLE other_table (id INTEGER PRIMARY KEY);");
      db.close();

      const result = runBackupVerify({ resolvedSqlitePath: emptyDbPath });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Verification failed");
      }
    });

    it("should handle empty facts table", () => {
      // Create database with empty facts table
      const emptyFactsPath = join(testDir, "empty-facts.db");
      const db = new DatabaseSync(emptyFactsPath);
      db.exec(`
        CREATE TABLE facts (
          id INTEGER PRIMARY KEY,
          content TEXT NOT NULL,
          superseded_by TEXT,
          superseded_at INTEGER
        );
      `);
      db.close();

      const result = runBackupVerify({ resolvedSqlitePath: emptyFactsPath });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.integrityOk).toBe(true);
        expect(result.factCount).toBe(0);
        expect(result.message).toContain("0 active facts");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Atomicity (#2229): a crash/kill mid-backup must never look like a completed snapshot.
  // ---------------------------------------------------------------------------
  describe("atomic promotion (#2229)", () => {
    it("leaves no .backup-tmp-* working directory behind after a successful run", async () => {
      const backupDir = join(testDir, "backups");
      const result = await runBackup({ resolvedSqlitePath: sqlitePath, resolvedLancePath: lancePath, backupDir });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const entries = readdirSync(backupDir);
      expect(entries).toEqual([basename(result.backupDir)]);
      expect(entries.some((name) => name.startsWith(".backup-tmp-"))).toBe(false);
    });

    it("never leaves a directory behind (partial or completed-looking) after a failed run", async () => {
      const backupDir = join(testDir, "backups");
      const brokenLancePath = join(testDir, "broken-lance-source-atomic");
      writeFileSync(brokenLancePath, "not a directory");

      const result = await runBackup({ resolvedSqlitePath: sqlitePath, resolvedLancePath: brokenLancePath, backupDir });
      expect(result.ok).toBe(false);

      const entries = existsSync(backupDir) ? readdirSync(backupDir) : [];
      expect(entries.length).toBe(0);
    });

    it("does not accumulate stale working directories across repeated failed runs", async () => {
      const backupDir = join(testDir, "backups");
      const brokenLancePath = join(testDir, "broken-lance-source-repeat");
      writeFileSync(brokenLancePath, "not a directory");

      for (let i = 0; i < 3; i++) {
        const result = await runBackup({
          resolvedSqlitePath: sqlitePath,
          resolvedLancePath: brokenLancePath,
          backupDir,
        });
        expect(result.ok).toBe(false);
      }
      const entries = existsSync(backupDir) ? readdirSync(backupDir) : [];
      expect(entries.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Retention / pruning (#2229)
  // ---------------------------------------------------------------------------
  describe("pruneBackups / getBackupStatus (#2229)", () => {
    let backupRoot: string;

    beforeEach(() => {
      backupRoot = join(testDir, "backups-retention");
      mkdirSync(backupRoot, { recursive: true });
    });

    /** Create a fake completed backup snapshot directory with a controllable mtime. */
    function makeCompletedBackup(name: string, ageDays: number): string {
      const dir = join(backupRoot, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "backup-manifest.json"), "{}");
      const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      utimesSync(dir, past, past);
      return dir;
    }

    /** Create a fake abandoned working directory (or loose orphaned file) with a controllable mtime. */
    function makeStaleArtifact(name: string, ageHours: number, opts: { asFile?: boolean } = {}): string {
      const path = join(backupRoot, name);
      if (opts.asFile) {
        writeFileSync(path, "stray");
      } else {
        mkdirSync(path, { recursive: true });
      }
      const past = new Date(Date.now() - ageHours * 60 * 60 * 1000);
      utimesSync(path, past, past);
      return path;
    }

    it("retention count keeps only the newest N completed snapshots", () => {
      const names = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`);
      for (const [i, name] of names.entries()) makeCompletedBackup(name, 10 - i); // higher index = newer (smaller ageDays)

      const report = pruneBackups(backupRoot, { retentionCount: 3, retentionAgeDays: 0 });
      expect(report.retainedCompleted.length).toBe(3);
      expect(report.prunedCompleted.length).toBe(7);
      // The 3 newest (last 3 in `names`) must be the ones retained.
      expect(new Set(report.retainedCompleted)).toEqual(new Set(names.slice(-3)));
    });

    it("never deletes the newest completed snapshot even when it's the only one and older than retentionAgeDays", () => {
      makeCompletedBackup("2020-01-01T00-00-00-000Z", 400);

      const report = pruneBackups(backupRoot, { retentionCount: 7, retentionAgeDays: 30 });
      expect(report.prunedCompleted.length).toBe(0);
      expect(report.retainedCompleted.length).toBe(1);
      expect(existsSync(join(backupRoot, "2020-01-01T00-00-00-000Z"))).toBe(true);
    });

    it("prunes completed snapshots older than retentionAgeDays while keeping recent ones and the newest", () => {
      makeCompletedBackup("2020-01-01T00-00-00-000Z", 400); // very old — pruned
      makeCompletedBackup("2026-01-01T00-00-00-000Z", 5); // recent — retained
      makeCompletedBackup("2026-01-02T00-00-00-000Z", 1); // newest — always retained

      const report = pruneBackups(backupRoot, { retentionCount: 0, retentionAgeDays: 30 });
      expect(report.prunedCompleted).toEqual(["2020-01-01T00-00-00-000Z"]);
      expect(new Set(report.retainedCompleted)).toEqual(
        new Set(["2026-01-01T00-00-00-000Z", "2026-01-02T00-00-00-000Z"]),
      );
    });

    it("removes abandoned .backup-tmp-* working directories older than the grace period but leaves fresh ones alone", () => {
      makeStaleArtifact(".backup-tmp-12345-oldrun", 5); // 5h old — abandoned
      makeStaleArtifact(".backup-tmp-99999-freshrun", 0.01); // ~36s old — may still be an active run

      const report = pruneBackups(backupRoot, { partialGraceMs: 60 * 60 * 1000 });
      expect(report.prunedPartial).toEqual([".backup-tmp-12345-oldrun"]);
      expect(existsSync(join(backupRoot, ".backup-tmp-99999-freshrun"))).toBe(true);
    });

    it("surfaces and removes stale orphaned artifacts sitting directly under the backup root", () => {
      makeStaleArtifact("legacy-pre-sync-snapshot.db", 5, { asFile: true });

      const statusBefore = getBackupStatus(backupRoot);
      expect(statusBefore.orphanedCount).toBe(1);
      expect(statusBefore.stalePartialCount).toBe(1);

      const report = pruneBackups(backupRoot, { partialGraceMs: 60 * 60 * 1000 });
      expect(report.prunedOrphaned).toEqual(["legacy-pre-sync-snapshot.db"]);
      expect(existsSync(join(backupRoot, "legacy-pre-sync-snapshot.db"))).toBe(false);
    });

    it("getBackupStatus never mutates the filesystem", () => {
      makeCompletedBackup("2020-01-01T00-00-00-000Z", 400);
      makeStaleArtifact(".backup-tmp-abc-def", 5);
      makeStaleArtifact("stray.db", 5, { asFile: true });

      const status = getBackupStatus(backupRoot, { retentionCount: 0, retentionAgeDays: 1 });
      expect(status.completedCount).toBe(1);
      expect(status.retainedCount).toBe(1); // newest-guard keeps it even though it's over-age
      expect(status.partialCount).toBe(1);
      expect(status.orphanedCount).toBe(1);
      expect(existsSync(join(backupRoot, "2020-01-01T00-00-00-000Z"))).toBe(true);
      expect(existsSync(join(backupRoot, ".backup-tmp-abc-def"))).toBe(true);
      expect(existsSync(join(backupRoot, "stray.db"))).toBe(true);
    });
  });

  describe("runBackup with ctx.retention (#2229)", () => {
    it("prunes older completed snapshots automatically after a successful run when retention is configured", async () => {
      const backupDir = join(testDir, "backups-auto-prune");
      mkdirSync(backupDir, { recursive: true });
      const oldDir = join(backupDir, "2020-01-01T00-00-00-000Z");
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, "backup-manifest.json"), "{}");
      const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      utimesSync(oldDir, past, past);

      const result = await runBackup({
        resolvedSqlitePath: sqlitePath,
        resolvedLancePath: lancePath,
        backupDir,
        retention: { retentionCount: 1, retentionAgeDays: 0 },
      });
      expect(result.ok).toBe(true);
      expect(existsSync(oldDir)).toBe(false);
      if (result.ok) expect(existsSync(result.backupDir)).toBe(true);
    });

    it("does not prune when ctx.retention is omitted (existing default behaviour preserved)", async () => {
      const backupDir = join(testDir, "backups-no-prune");
      mkdirSync(backupDir, { recursive: true });
      const oldDir = join(backupDir, "2020-01-01T00-00-00-000Z");
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, "backup-manifest.json"), "{}");
      const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      utimesSync(oldDir, past, past);

      const result = await runBackup({ resolvedSqlitePath: sqlitePath, resolvedLancePath: lancePath, backupDir });
      expect(result.ok).toBe(true);
      expect(existsSync(oldDir)).toBe(true);
    });
  });
});
