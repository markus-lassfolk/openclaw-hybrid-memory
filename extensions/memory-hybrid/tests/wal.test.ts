import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { _testing } from "../index.js";

const { WriteAheadLog } = _testing;

describe("WriteAheadLog", () => {
  let testDir: string;
  let walPath: string;
  let wal: InstanceType<typeof WriteAheadLog>;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(tmpdir(), `wal-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    walPath = join(testDir, "test.wal");
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("constructor", () => {
    it("creates WAL directory if it doesn't exist", () => {
      const nestedPath = join(testDir, "nested", "dir", "test.wal");
      const nestedWal = new WriteAheadLog(nestedPath, 5 * 60 * 1000);
      expect(existsSync(join(testDir, "nested", "dir"))).toBe(true);
      nestedWal.clear(); // cleanup
    });
  });

  describe("write and read operations", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 5 * 60 * 1000);
    });

    it("writes and reads a single entry", () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: {
          text: "Test memory",
          category: "general",
          importance: 0.8,
          source: "test",
        },
      };

      wal.write(entry);
      const entries = wal.readAll();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(entry);
    });

    it("writes multiple entries in sequence", () => {
      const entry1 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Memory 1", category: "general", importance: 0.7, source: "test" },
      };

      const entry2 = {
        id: randomUUID(),
        timestamp: Date.now() + 100,
        operation: "store" as const,
        data: { text: "Memory 2", category: "technical", importance: 0.9, source: "test" },
      };

      wal.write(entry1);
      wal.write(entry2);

      const entries = wal.readAll();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(entry1);
      expect(entries[1]).toEqual(entry2);
    });

    it("handles entries with missing vector (undefined)", () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: {
          text: "Memory without vector",
          category: "general",
          importance: 0.7,
          source: "test",
          vector: undefined,
        },
      };

      wal.write(entry);
      const entries = wal.readAll();

      expect(entries).toHaveLength(1);
      expect(entries[0].data.vector).toBeUndefined();
    });

    it("returns empty array for non-existent WAL file", () => {
      const emptyWal = new WriteAheadLog(join(testDir, "nonexistent.wal"), 5 * 60 * 1000);
      const entries = emptyWal.readAll();
      expect(entries).toEqual([]);
    });

    it("handles corrupted JSON gracefully", () => {
      // Write invalid JSON directly to the file
      writeFileSync(walPath, "{ invalid json }", "utf-8");

      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });

    it("handles empty file", () => {
      writeFileSync(walPath, "", "utf-8");
      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });

    it("handles whitespace-only file", () => {
      writeFileSync(walPath, "   \n  \t  ", "utf-8");
      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });
  });

  describe("atomic write operations", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 5 * 60 * 1000);
    });

    it("uses atomic write (temp file + rename)", () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };

      wal.write(entry);

      // Verify the temp file doesn't exist after write
      const tempPath = `${walPath}.tmp`;
      expect(existsSync(tempPath)).toBe(false);

      // Verify the actual WAL file exists
      expect(existsSync(walPath)).toBe(true);
    });

    it("preserves existing entries when writing new ones", () => {
      const entry1 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Memory 1", category: "general", importance: 0.7, source: "test" },
      };

      const entry2 = {
        id: randomUUID(),
        timestamp: Date.now() + 100,
        operation: "store" as const,
        data: { text: "Memory 2", category: "general", importance: 0.8, source: "test" },
      };

      wal.write(entry1);
      wal.write(entry2);

      const entries = wal.readAll();
      expect(entries).toHaveLength(2);
    });
  });

  describe("remove operation", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 5 * 60 * 1000);
    });

    it("removes a specific entry by id", () => {
      const entry1 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Memory 1", category: "general", importance: 0.7, source: "test" },
      };

      const entry2 = {
        id: randomUUID(),
        timestamp: Date.now() + 100,
        operation: "store" as const,
        data: { text: "Memory 2", category: "general", importance: 0.8, source: "test" },
      };

      wal.write(entry1);
      wal.write(entry2);
      wal.remove(entry1.id);

      const entries = wal.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry2.id);
    });

    it("clears WAL file when removing last entry", () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Only entry", category: "general", importance: 0.7, source: "test" },
      };

      wal.write(entry);
      wal.remove(entry.id);

      expect(existsSync(walPath)).toBe(false);
    });

    it("handles removing non-existent entry gracefully", () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };

      wal.write(entry);
      wal.remove("non-existent-id");

      const entries = wal.readAll();
      expect(entries).toHaveLength(1);
    });

    it("uses atomic write during remove", () => {
      const entry1 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Memory 1", category: "general", importance: 0.7, source: "test" },
      };

      const entry2 = {
        id: randomUUID(),
        timestamp: Date.now() + 100,
        operation: "store" as const,
        data: { text: "Memory 2", category: "general", importance: 0.8, source: "test" },
      };

      wal.write(entry1);
      wal.write(entry2);
      wal.remove(entry1.id);

      // Verify temp file is cleaned up
      const tempPath = `${walPath}.tmp`;
      expect(existsSync(tempPath)).toBe(false);
    });
  });

  describe("clear operation", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 5 * 60 * 1000);
    });

    it("removes the WAL file", () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };

      wal.write(entry);
      expect(existsSync(walPath)).toBe(true);

      wal.clear();
      expect(existsSync(walPath)).toBe(false);
    });

    it("handles clearing non-existent WAL gracefully", () => {
      expect(() => wal.clear()).not.toThrow();
    });
  });

  describe("pruning operations", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 1000); // 1 second max age for testing
    });

    it("prunes stale entries older than maxAge", async () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 2000, // 2 seconds old
        operation: "store" as const,
        data: { text: "Old memory", category: "general", importance: 0.7, source: "test" },
      };

      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent memory", category: "general", importance: 0.8, source: "test" },
      };

      wal.write(oldEntry);
      wal.write(recentEntry);

      const pruned = wal.pruneStale();
      expect(pruned).toBe(1);

      const entries = wal.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(recentEntry.id);
    });

    it("returns 0 when no entries need pruning", () => {
      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent memory", category: "general", importance: 0.8, source: "test" },
      };

      wal.write(recentEntry);

      const pruned = wal.pruneStale();
      expect(pruned).toBe(0);
    });

    it("clears WAL when all entries are stale", async () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 5000, // 5 seconds old
        operation: "store" as const,
        data: { text: "Old memory", category: "general", importance: 0.7, source: "test" },
      };

      wal.write(oldEntry);
      const pruned = wal.pruneStale();

      expect(pruned).toBe(1);
      expect(existsSync(walPath)).toBe(false);
    });
  });

  describe("getValidEntries", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 1000); // 1 second max age
    });

    it("returns only non-stale entries", () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 2000, // 2 seconds old
        operation: "store" as const,
        data: { text: "Old", category: "general", importance: 0.7, source: "test" },
      };

      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent", category: "general", importance: 0.8, source: "test" },
      };

      wal.write(oldEntry);
      wal.write(recentEntry);

      const validEntries = wal.getValidEntries();
      expect(validEntries).toHaveLength(1);
      expect(validEntries[0].id).toBe(recentEntry.id);
    });

    it("returns empty array when no valid entries", () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 5000,
        operation: "store" as const,
        data: { text: "Old", category: "general", importance: 0.7, source: "test" },
      };

      wal.write(oldEntry);

      const validEntries = wal.getValidEntries();
      expect(validEntries).toEqual([]);
    });

    it("returns empty array for non-existent WAL", () => {
      const emptyWal = new WriteAheadLog(join(testDir, "new.wal"), 1000);
      const validEntries = emptyWal.getValidEntries();
      expect(validEntries).toEqual([]);
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 5 * 60 * 1000);
    });

    it("throws error when write fails", () => {
      // Create a directory where the WAL file should be (to cause write failure)
      const badPath = join(testDir, "badwal");
      mkdirSync(badPath, { recursive: true });

      const badWal = new WriteAheadLog(badPath, 5 * 60 * 1000);
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };

      expect(() => badWal.write(entry)).toThrow(/WAL write failed/);
    });

    it("throws error when remove fails", () => {
      const badPath = join(testDir, "badwal-remove");
      mkdirSync(badPath, { recursive: true });

      const badWal = new WriteAheadLog(badPath, 5 * 60 * 1000);

      expect(() => badWal.remove("some-id")).toThrow(/WAL remove failed/);
    });
  });

  describe("idempotency and crash recovery simulation", () => {
    beforeEach(() => {
      wal = new WriteAheadLog(walPath, 5 * 60 * 1000);
    });

    it("simulates recovery after crash during write", () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Memory before crash", category: "general", importance: 0.7, source: "test" },
      };

      wal.write(entry);

      // Simulate crash by creating a new WAL instance
      const recoveredWal = new WriteAheadLog(walPath, 5 * 60 * 1000);
      const entries = recoveredWal.getValidEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(entry);
    });

    it("handles partial file corruption by returning empty array", () => {
      // Write valid data first
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Valid", category: "general", importance: 0.7, source: "test" },
      };
      wal.write(entry);

      // Corrupt the file by truncating it
      const content = readFileSync(walPath, "utf-8");
      writeFileSync(walPath, content.slice(0, content.length / 2), "utf-8");

      // Create new instance and try to read
      const recoveredWal = new WriteAheadLog(walPath, 5 * 60 * 1000);
      const entries = recoveredWal.readAll();

      // Should return empty array for corrupted data
      expect(entries).toEqual([]);
    });
  });
});
