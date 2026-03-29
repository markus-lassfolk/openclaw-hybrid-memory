import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Intercept node:fs/promises so we can inject fsync errors in individual tests
// while letting everything else (appendFile, readFile, writeFile, rm) use the
// real implementation on a temporary directory.
const fsyncError = vi.hoisted(() => ({ value: null as Error | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const actualOpen = actual.open;
  return {
    ...actual,
    open: vi.fn(async (...args: any[]) => {
      const fh = await actualOpen(...(args as Parameters<typeof actualOpen>));
      // Only intercept append opens used by fsyncAfterWrite (datasync on WAL file).
      if (args[1] === "a" || args[1] === "a+") {
        const origDatasync = fh.datasync.bind(fh);
        (fh as any).datasync = async () => {
          if (fsyncError.value) {
            const err = fsyncError.value;
            fsyncError.value = null;
            throw err;
          }
          return origDatasync();
        };
      }
      return fh;
    }),
  };
});

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _testing } from "../index.js";

const { WriteAheadLog } = _testing;

// Test constants
const TEST_MAX_AGE_MS = 1000; // 1 second for fast tests
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes (production default)

describe("WriteAheadLog", () => {
  let testDir: string;
  let walPath: string;
  let wal: InstanceType<typeof WriteAheadLog>;

  beforeEach(() => {
    fsyncError.value = null;
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
    it("creates WAL directory if it doesn't exist", async () => {
      const nestedPath = join(testDir, "nested", "dir", "test.wal");
      const nestedWal = new WriteAheadLog(nestedPath, DEFAULT_MAX_AGE_MS);
      await nestedWal.init();
      expect(existsSync(join(testDir, "nested", "dir"))).toBe(true);
      await nestedWal.clear(); // cleanup
    });
  });

  describe("write and read operations", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await wal.init();
    });

    it("writes and reads a single entry", async () => {
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

      await wal.write(entry);
      const entries = await wal.readAll();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(entry);
    });

    it("writes multiple entries in sequence", async () => {
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

      await wal.write(entry1);
      await wal.write(entry2);

      const entries = await wal.readAll();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(entry1);
      expect(entries[1]).toEqual(entry2);
    });

    it("handles entries with missing vector (undefined)", async () => {
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

      await wal.write(entry);
      const entries = await wal.readAll();

      expect(entries).toHaveLength(1);
      expect(entries[0].data.vector).toBeUndefined();
    });

    it("returns empty array for non-existent WAL file", async () => {
      const emptyWal = new WriteAheadLog(join(testDir, "nonexistent.wal"), DEFAULT_MAX_AGE_MS);
      await emptyWal.init();
      const entries = await emptyWal.readAll();
      expect(entries).toEqual([]);
    });

    it("handles corrupted JSON gracefully", async () => {
      // Write invalid JSON directly to the file
      writeFileSync(walPath, "{ invalid json }", "utf-8");

      const entries = await wal.readAll();
      expect(entries).toEqual([]);
    });

    it("handles empty file", async () => {
      writeFileSync(walPath, "", "utf-8");
      const entries = await wal.readAll();
      expect(entries).toEqual([]);
    });

    it("handles whitespace-only file", async () => {
      writeFileSync(walPath, "   \n  \t  ", "utf-8");
      const entries = await wal.readAll();
      expect(entries).toEqual([]);
    });
  });

  describe("atomic write operations", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await wal.init();
    });

    it("uses atomic write (temp file + rename)", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };

      await wal.write(entry);

      // Verify the temp file doesn't exist after write
      const tempPath = `${walPath}.tmp`;
      expect(existsSync(tempPath)).toBe(false);

      // Verify the actual WAL file exists
      expect(existsSync(walPath)).toBe(true);
    });

    it("preserves existing entries when writing new ones", async () => {
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

      await wal.write(entry1);
      await wal.write(entry2);

      const entries = await wal.readAll();
      expect(entries).toHaveLength(2);
    });
  });

  describe("remove operation", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await wal.init();
    });

    it("removes a specific entry by id", async () => {
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

      await wal.write(entry1);
      await wal.write(entry2);
      await wal.remove(entry1.id);

      const entries = await wal.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry2.id);
    });

    it("clears WAL file when removing last entry", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Only entry", category: "general", importance: 0.7, source: "test" },
      };

      await wal.write(entry);
      await wal.remove(entry.id);

      expect(existsSync(walPath)).toBe(false);
    });

    it("handles removing non-existent entry gracefully", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };

      await wal.write(entry);
      await wal.remove("non-existent-id");

      const entries = await wal.readAll();
      expect(entries).toHaveLength(1);
    });

    it("uses atomic write during remove", async () => {
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

      await wal.write(entry1);
      await wal.write(entry2);
      await wal.remove(entry1.id);

      // Verify temp file is cleaned up
      const tempPath = `${walPath}.tmp`;
      expect(existsSync(tempPath)).toBe(false);
    });
    it("does not call readAll() during remove — O(1) compaction check", async () => {
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

      await wal.write(entry1);
      await wal.write(entry2);

      const readAllSpy = vi.spyOn(wal, "readAll");
      await wal.remove(entry1.id);

      expect(readAllSpy).not.toHaveBeenCalled();
      readAllSpy.mockRestore();
    });

    it("batch removals do not trigger any readAll() call", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const entry = {
          id: randomUUID(),
          timestamp: Date.now() + i,
          operation: "store" as const,
          data: { text: `Memory ${i}`, category: "general", importance: 0.7, source: "test" },
        };
        ids.push(entry.id);
        await wal.write(entry);
      }

      const readAllSpy = vi.spyOn(wal, "readAll");
      for (const id of ids) {
        await wal.remove(id);
      }

      expect(readAllSpy).not.toHaveBeenCalled();
      readAllSpy.mockRestore();
    });

    it("auto-clears WAL after all entries removed via batch removes", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const entry = {
          id: randomUUID(),
          timestamp: Date.now() + i,
          operation: "store" as const,
          data: { text: `Memory ${i}`, category: "general", importance: 0.7, source: "test" },
        };
        ids.push(entry.id);
        await wal.write(entry);
      }

      for (const id of ids) {
        await wal.remove(id);
      }

      expect(existsSync(walPath)).toBe(false);
      expect(await wal.readAll()).toEqual([]);
    });

    it("removes non-existent ID without clearing when other entries exist", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Survivor", category: "general", importance: 0.9, source: "test" },
      };
      await wal.write(entry);
      await wal.remove("ghost-id-that-never-existed");

      expect(existsSync(walPath)).toBe(true);
      const entries = await wal.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
    });
  });

  describe("clear operation", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await wal.init();
    });

    it("removes the WAL file", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };

      await wal.write(entry);
      expect(existsSync(walPath)).toBe(true);

      await wal.clear();
      expect(existsSync(walPath)).toBe(false);
    });

    it("handles clearing non-existent WAL gracefully", async () => {
      await expect(wal.clear()).resolves.not.toThrow();
    });
  });

  describe("pruning operations", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, TEST_MAX_AGE_MS);
      await wal.init();
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

      await wal.write(oldEntry);
      await wal.write(recentEntry);

      const pruned = await wal.pruneStale();
      expect(pruned).toBe(1);

      const entries = await wal.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(recentEntry.id);
    });

    it("returns 0 when no entries need pruning", async () => {
      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent memory", category: "general", importance: 0.8, source: "test" },
      };

      await wal.write(recentEntry);

      const pruned = await wal.pruneStale();
      expect(pruned).toBe(0);
    });

    it("clears WAL when all entries are stale", async () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 5000, // 5 seconds old
        operation: "store" as const,
        data: { text: "Old memory", category: "general", importance: 0.7, source: "test" },
      };

      await wal.write(oldEntry);
      const pruned = await wal.pruneStale();

      expect(pruned).toBe(1);
      expect(existsSync(walPath)).toBe(false);
    });
  });

  describe("getValidEntries", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, TEST_MAX_AGE_MS);
      await wal.init();
    });

    it("returns only non-stale entries", async () => {
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

      await wal.write(oldEntry);
      await wal.write(recentEntry);

      const validEntries = await wal.getValidEntries();
      expect(validEntries).toHaveLength(1);
      expect(validEntries[0].id).toBe(recentEntry.id);
    });

    it("returns empty array when no valid entries", async () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 5000,
        operation: "store" as const,
        data: { text: "Old", category: "general", importance: 0.7, source: "test" },
      };

      await wal.write(oldEntry);

      const validEntries = await wal.getValidEntries();
      expect(validEntries).toEqual([]);
    });

    it("returns empty array for non-existent WAL", async () => {
      const emptyWal = new WriteAheadLog(join(testDir, "new.wal"), TEST_MAX_AGE_MS);
      await emptyWal.init();
      const validEntries = await emptyWal.getValidEntries();
      expect(validEntries).toEqual([]);
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await wal.init();
    });

    it("throws error when write fails", async () => {
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

      await expect(badWal.write(entry)).rejects.toThrow(/WAL write failed/);
    });

    it("throws error when remove fails", async () => {
      const badPath = join(testDir, "badwal-remove");
      mkdirSync(badPath, { recursive: true });

      const badWal = new WriteAheadLog(badPath, 5 * 60 * 1000);

      await expect(badWal.remove("some-id")).rejects.toThrow(/WAL remove failed/);
    });

    it("does not throw when fsync fails with EPERM (e.g. WSL2/NTFS)", async () => {
      const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      fsyncError.value = epermError;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test", category: "general", importance: 0.7, source: "test" },
      };
      await expect(wal.write(entry)).resolves.not.toThrow();
      const entries = await wal.readAll();
      expect(entries).toHaveLength(1);
    });

    it("does not throw when fsync fails with EINVAL", async () => {
      const einvalError = Object.assign(new Error("invalid argument"), { code: "EINVAL" });
      fsyncError.value = einvalError;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test EINVAL", category: "general", importance: 0.5, source: "test" },
      };
      await expect(wal.write(entry)).resolves.not.toThrow();
    });

    it("re-throws unexpected fsync errors", async () => {
      const unexpectedError = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      fsyncError.value = unexpectedError;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test ENOSPC", category: "general", importance: 0.5, source: "test" },
      };
      await expect(wal.write(entry)).rejects.toThrow(/WAL write failed/);
    });
  });

  describe("idempotency and crash recovery simulation", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await wal.init();
    });

    it("simulates recovery after crash during write", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Memory before crash", category: "general", importance: 0.7, source: "test" },
      };

      await wal.write(entry);

      // Simulate crash by creating a new WAL instance
      const recoveredWal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await recoveredWal.init();
      const entries = await recoveredWal.getValidEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(entry);
    });

    it("handles partial file corruption by returning empty array", async () => {
      // Write valid data first
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Valid", category: "general", importance: 0.7, source: "test" },
      };
      await wal.write(entry);

      // Corrupt the file by truncating it
      const content = readFileSync(walPath, "utf-8");
      writeFileSync(walPath, content.slice(0, content.length / 2), "utf-8");

      // Create new instance and try to read
      const recoveredWal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await recoveredWal.init();
      const entries = await recoveredWal.readAll();

      // Should return empty array for corrupted data
      expect(entries).toEqual([]);
    });

    it("preserves WAL file during crash recovery with multiple entries", async () => {
      // Write multiple entries
      const entry1 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Entry 1", category: "general", importance: 0.7, source: "test" },
      };
      const entry2 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Entry 2", category: "general", importance: 0.8, source: "test" },
      };
      const entry3 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Entry 3", category: "general", importance: 0.9, source: "test" },
      };

      await wal.write(entry1);
      await wal.write(entry2);
      await wal.write(entry3);

      // Simulate crash recovery: create new WAL instance and remove first entry
      const recoveredWal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await recoveredWal.init();

      // Remove first entry - this should NOT delete the entire WAL file
      await recoveredWal.remove(entry1.id);

      // WAL file should still exist
      expect(existsSync(walPath)).toBe(true);

      // Remaining entries should still be readable
      const remainingEntries = await recoveredWal.readAll();
      expect(remainingEntries).toHaveLength(2);
      expect(remainingEntries.map((e) => e.id)).toContain(entry2.id);
      expect(remainingEntries.map((e) => e.id)).toContain(entry3.id);
    });
  });
});
