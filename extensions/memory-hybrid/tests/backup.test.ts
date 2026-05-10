import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBackup, runBackupVerify, type BackupCliResult } from "../cli/backup.js";

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
        superseded_by TEXT
      );
    `);
    db.exec("INSERT INTO facts (content, superseded_by) VALUES ('test fact 1', NULL), ('test fact 2', NULL);");
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
        expect(result.backupDir).toMatch(/backups\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
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
      // Try to create backup in a non-existent parent with no permissions
      const invalidBackupDir = "/root/impossible/backups";
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
      db.exec("INSERT INTO facts (content, superseded_by) VALUES ('superseded fact', 'fact-123');");
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
          superseded_by TEXT
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
});
