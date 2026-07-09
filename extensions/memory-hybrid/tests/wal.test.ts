import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Intercept node:fs/promises so we can inject fsync errors in individual tests
// while letting everything else (appendFile, readFile, writeFile, rm) use the
// real implementation on a temporary directory.
const fsyncError = vi.hoisted(() => ({ value: null as Error | null }));
const failNextOpen = vi.hoisted(() => ({ value: null as Error | null }));
const syncError = vi.hoisted(() => ({ value: null as Error | null }));
// Tracks how many times fh.close() has been called via the intercepted open().
const closedHandleCount = vi.hoisted(() => ({ value: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const actualOpen = actual.open;
  return {
    ...actual,
    open: vi.fn(async (...args: any[]) => {
      if (failNextOpen.value) {
        const err = failNextOpen.value;
        failNextOpen.value = null;
        throw err;
      }
      const fh = await actualOpen(...(args as Parameters<typeof actualOpen>));
      // Intercept append-mode opens used by fsyncAfterWrite.
      if (args[1] === "r" || args[1] === "a" || args[1] === "a+") {
        const origDatasync = fh.datasync.bind(fh);
        vi.spyOn(fh, "datasync").mockImplementation(async () => {
          if (fsyncError.value) {
            const err = fsyncError.value;
            fsyncError.value = null;
            throw err;
          }
          return origDatasync();
        });
        const origSync = fh.sync.bind(fh);
        vi.spyOn(fh, "sync").mockImplementation(async () => {
          if (syncError.value) {
            const err = syncError.value;
            syncError.value = null;
            throw err;
          }
          return origSync();
        });
        const origClose = fh.close.bind(fh);
        vi.spyOn(fh, "close").mockImplementation(async () => {
          closedHandleCount.value++;
          return origClose();
        });
      }
      return fh;
    }),
  };
});

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalReadCorruptionError, WriteAheadLog } from "../backends/wal.js";
import { pluginLogger } from "../utils/logger.js";

const TEST_MAX_AGE_MS = 1000; // 1 second for fast tests
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes (production default)

describe("WriteAheadLog", () => {
  let testDir: string;
  let walPath: string;
  let wal: InstanceType<typeof WriteAheadLog>;

  beforeEach(() => {
    fsyncError.value = null;
    syncError.value = null;
    closedHandleCount.value = 0;
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

    it("logs init load failures instead of silently swallowing them", async () => {
      const localWal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      const readAllSpy = vi.spyOn(localWal, "readAll").mockRejectedValue(new Error("simulated init read failure"));
      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});

      await localWal.init();

      expect(readAllSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WAL init: failed to load active IDs"));
      warnSpy.mockRestore();
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

    it("throws WalReadCorruptionError for corrupted entry lines", async () => {
      // Write invalid JSON directly to the file
      writeFileSync(walPath, "{ invalid json }", "utf-8");

      await expect(wal.readAll()).rejects.toBeInstanceOf(WalReadCorruptionError);
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

    it("only the final drain-to-empty removal triggers a readAll() disk-verification call (#79)", async () => {
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

      // Every remove() that leaves other entries active stays O(1) (no disk read); only the
      // single removal that drains activeIds to 0 verifies against disk before clearing (#79).
      expect(readAllSpy).toHaveBeenCalledTimes(1);
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

    it("does not wipe another process's concurrently-appended entry when this instance's own activeIds drains to 0 (#79)", async () => {
      // Simulates cmd-doctor's WAL durability probe racing the long-running gateway process:
      // a second WriteAheadLog instance pointed at the same walPath, whose init() resolves
      // against an empty/pre-gateway-write file (so ensureInitialized() is a no-op for the
      // rest of its lifetime — it never re-reads disk), then the gateway appends its own real
      // entry that the probe instance's in-memory activeIds never learns about.
      const probeWal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await probeWal.init(); // resolves against the still-empty walPath

      const gatewayEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Gateway's pending entry", category: "general", importance: 0.7, source: "test" },
      };
      await wal.write(gatewayEntry); // a different WriteAheadLog instance, same walPath

      // Matches cmd-doctor.ts's `wal.write(probeEntry); wal.remove(probeId);` round-trip.
      const probeId = randomUUID();
      const probeEntry = {
        id: probeId,
        timestamp: Date.now(),
        operation: "update" as const,
        data: { text: "doctor-wal-durability-probe", probe: "doctor-wal-durability" },
      };
      await probeWal.write(probeEntry);
      await probeWal.remove(probeId);

      // The probe's own activeIds is now empty, but the gateway's entry must survive on disk.
      expect(existsSync(walPath)).toBe(true);
      const survivingEntries = await wal.readAll();
      expect(survivingEntries.map((e) => e.id)).toEqual([gatewayEntry.id]);
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

    it("repairs corrupt lines even when no entries are stale", async () => {
      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent memory", category: "general", importance: 0.8, source: "test" },
      };

      await wal.write(recentEntry);
      appendFileSync(walPath, "{not valid wal json}\n", "utf-8");

      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      const pruned = await wal.pruneStale();

      expect(pruned).toBe(0);
      expect(await wal.readAll()).toHaveLength(1);
      expect((await wal.readAll())[0].id).toBe(recentEntry.id);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WAL pruneStale detected corruption"));
      warnSpy.mockRestore();
    });

    it("skips pruning rather than clobbering a concurrent rewrite already in progress (#80)", async () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 5000,
        operation: "store" as const,
        data: { text: "Old memory", category: "general", importance: 0.7, source: "test" },
      };
      await wal.write(oldEntry);

      // Simulate a second process's pruneStale/compactIfOversized already holding the
      // cross-process rewrite lock for this walPath.
      writeFileSync(`${walPath}.rewrite.lock`, String(Date.now()), "utf-8");

      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      const pruned = await wal.pruneStale();

      expect(pruned).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WAL pruneStale skipped"));
      // The old entry is untouched — a naive stale-snapshot rewrite would have removed it.
      const entries = await wal.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(oldEntry.id);
      warnSpy.mockRestore();
      rmSync(`${walPath}.rewrite.lock`, { force: true });
    });

    it("reclaims a stale rewrite lock abandoned by a crashed process", async () => {
      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - 5000,
        operation: "store" as const,
        data: { text: "Old memory", category: "general", importance: 0.7, source: "test" },
      };
      await wal.write(oldEntry);

      // A lock file far older than WAL_REWRITE_LOCK_STALE_MS (5 min) — abandoned, not live.
      writeFileSync(`${walPath}.rewrite.lock`, String(Date.now() - 10 * 60 * 1000), "utf-8");

      const pruned = await wal.pruneStale();

      expect(pruned).toBe(1);
      expect(existsSync(walPath)).toBe(false);
    });
  });

  describe("write()/remove() wait for a live rewrite lock (loop iteration 115 regression)", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      await wal.init();
    });

    it("does not append while a concurrent rewrite holds the lock, and proceeds once it clears", async () => {
      const lockPath = `${walPath}.rewrite.lock`;
      // Simulate a second process's compactIfOversized/pruneStale already holding the
      // cross-process rewrite lock for this walPath, mid read-snapshot -> atomic-replace.
      writeFileSync(lockPath, String(Date.now()), "utf-8");

      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "New memory", category: "general", importance: 0.8, source: "test" },
      };
      const writePromise = wal.write(entry);

      // While the lock is still held, the append must not have landed yet — before the fix,
      // write() appended immediately regardless of the lock, which is exactly what could get
      // silently discarded by the rewrite's rename() a moment later.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const midEntries = await wal.readAll();
      expect(midEntries.find((e) => e.id === entry.id)).toBeUndefined();

      rmSync(lockPath, { force: true });
      await writePromise;

      const finalEntries = await wal.readAll();
      expect(finalEntries.find((e) => e.id === entry.id)).toBeDefined();
    });

    it("proceeds anyway once the bounded wait times out, so the write path never hangs indefinitely", async () => {
      const lockPath = `${walPath}.rewrite.lock`;
      writeFileSync(lockPath, String(Date.now()), "utf-8");

      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "New memory", category: "general", importance: 0.8, source: "test" },
      };

      await wal.write(entry);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("WAL write proceeding while a rewrite lock is still held"),
      );
      const entries = await wal.readAll();
      expect(entries.find((e) => e.id === entry.id)).toBeDefined();
      warnSpy.mockRestore();
      rmSync(lockPath, { force: true });
    }, 3000);

    it("remove() also waits for a live rewrite lock before appending its remove marker", async () => {
      const existingEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Existing memory", category: "general", importance: 0.8, source: "test" },
      };
      await wal.write(existingEntry);

      const lockPath = `${walPath}.rewrite.lock`;
      writeFileSync(lockPath, String(Date.now()), "utf-8");

      const removePromise = wal.remove(existingEntry.id);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const midEntries = await wal.readAll();
      expect(midEntries.find((e) => e.id === existingEntry.id)).toBeDefined();

      rmSync(lockPath, { force: true });
      await removePromise;

      const finalEntries = await wal.readAll();
      expect(finalEntries.find((e) => e.id === existingEntry.id)).toBeUndefined();
    });
  });

  describe("getValidEntries", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, TEST_MAX_AGE_MS);
      await wal.init();
    });

    it("returns only non-stale entries", async () => {
      // Use a large maxAge so slow fsync-heavy writes on CI cannot push the "recent"
      // entry past the staleness window before getValidEntries() runs.
      const maxAgeMs = 60_000;
      const localWal = new WriteAheadLog(walPath, maxAgeMs);
      await localWal.init();

      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - maxAgeMs - 1000,
        operation: "store" as const,
        data: { text: "Old", category: "general", importance: 0.7, source: "test" },
      };

      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent", category: "general", importance: 0.8, source: "test" },
      };

      await localWal.write(oldEntry);
      await localWal.write(recentEntry);

      const validEntries = await localWal.getValidEntries();
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

    it("returns valid entries when WAL contains corrupt lines", async () => {
      const maxAgeMs = 60_000;
      const localWal = new WriteAheadLog(walPath, maxAgeMs);
      await localWal.init();

      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent", category: "general", importance: 0.8, source: "test" },
      };

      await localWal.write(recentEntry);
      appendFileSync(walPath, "{not valid wal json}\n", "utf-8");

      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      const validEntries = await localWal.getValidEntries();

      expect(validEntries).toHaveLength(1);
      expect(validEntries[0].id).toBe(recentEntry.id);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to lenient read"));
      warnSpy.mockRestore();
    });
  });

  describe("compactIfOversized", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, TEST_MAX_AGE_MS);
      await wal.init();
    });

    it("retains entries older than maxAge during size compaction", async () => {
      const maxAgeMs = 1000;
      const localWal = new WriteAheadLog(walPath, maxAgeMs);
      await localWal.init();

      const oldEntry = {
        id: randomUUID(),
        timestamp: Date.now() - maxAgeMs - 5000,
        operation: "store" as const,
        data: { text: "Old pending", category: "general", importance: 0.7, source: "test" },
      };
      const recentEntry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recent pending", category: "general", importance: 0.8, source: "test" },
      };

      await localWal.write(oldEntry);
      await localWal.write(recentEntry);

      const compacted = await localWal.compactIfOversized(0);
      expect(compacted).toBe(1);

      const entries = await localWal.readAll();
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.id).sort()).toEqual([oldEntry.id, recentEntry.id].sort());
    });

    it("skips compaction rather than clobbering a concurrent rewrite already in progress (#80)", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Pending entry", category: "general", importance: 0.7, source: "test" },
      };
      await wal.write(entry);

      writeFileSync(`${walPath}.rewrite.lock`, String(Date.now()), "utf-8");

      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      const compacted = await wal.compactIfOversized(0);

      expect(compacted).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WAL compactIfOversized skipped"));
      const entries = await wal.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
      warnSpy.mockRestore();
      rmSync(`${walPath}.rewrite.lock`, { force: true });
    });
  });

  describe("readAllRecoverable", () => {
    beforeEach(async () => {
      wal = new WriteAheadLog(walPath, TEST_MAX_AGE_MS);
      await wal.init();
    });

    it("returns strict results for a clean WAL", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Clean", category: "general", importance: 0.8, source: "test" },
      };
      await wal.write(entry);

      const { entries, hadCorruption } = await wal.readAllRecoverable();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
      expect(hadCorruption).toBe(false);
    });

    it("returns recoverable entries when WAL contains corrupt lines", async () => {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Recoverable", category: "general", importance: 0.8, source: "test" },
      };
      await wal.write(entry);
      appendFileSync(walPath, "{not valid wal json}\n", "utf-8");

      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      const { entries, hadCorruption } = await wal.readAllRecoverable();

      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
      expect(hadCorruption).toBe(true);
      warnSpy.mockRestore();
    });

    it("recovers JSON array lines during lenient fallback", async () => {
      const entry1 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Line entry", category: "general", importance: 0.8, source: "test" },
      };
      const entry2 = {
        id: randomUUID(),
        timestamp: Date.now() + 1,
        operation: "store" as const,
        data: { text: "Array entry", category: "general", importance: 0.7, source: "test" },
      };
      await wal.write(entry1);
      appendFileSync(walPath, `${JSON.stringify([entry2])}\n`, "utf-8");
      appendFileSync(walPath, "{not valid wal json}\n", "utf-8");

      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      const { entries, hadCorruption } = await wal.readAllRecoverable();

      expect(hadCorruption).toBe(true);
      expect(entries.map((e) => e.id).sort()).toEqual([entry1.id, entry2.id].sort());
      warnSpy.mockRestore();
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

    it("throws when datasync fails and fallback open cannot execute", async () => {
      const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      const openError = Object.assign(new Error("fallback open rejected"), { code: "EINVAL" });
      fsyncError.value = epermError;
      failNextOpen.value = openError;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Test fallback open failure", category: "general", importance: 0.5, source: "test" },
      };
      await expect(wal.write(entry)).rejects.toThrow(/WAL write failed/);
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

    it("closes file handle when datasync throws EPERM and fsync fallback succeeds", async () => {
      const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      fsyncError.value = epermError;
      const before = closedHandleCount.value;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "close-check EPERM", category: "general", importance: 0.5, source: "test" },
      };
      await wal.write(entry);
      expect(closedHandleCount.value).toBeGreaterThan(before);
    });

    it("closes file handle when datasync throws an unexpected error (ENOSPC)", async () => {
      const enospcError = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      fsyncError.value = enospcError;
      const before = closedHandleCount.value;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "close-check ENOSPC", category: "general", importance: 0.5, source: "test" },
      };
      await expect(wal.write(entry)).rejects.toThrow(/WAL write failed/);
      expect(closedHandleCount.value).toBeGreaterThan(before);
    });

    it("closes file handle when both datasync and fsync fallback fail (EPERM cascade)", async () => {
      // datasync() fails with EPERM, then sync() also fails — fh must still be closed.
      const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      const syncFail = Object.assign(new Error("sync unsupported"), { code: "EPERM" });
      fsyncError.value = epermError;
      syncError.value = syncFail;
      const before = closedHandleCount.value;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "close-check double-fail", category: "general", importance: 0.5, source: "test" },
      };
      await expect(wal.write(entry)).rejects.toThrow(/WAL write failed/);
      // fh was opened (open() succeeded) so close() must have been called.
      expect(closedHandleCount.value).toBeGreaterThan(before);
    });

    it("chains fsync durability failures through write() error cause (#1846)", async () => {
      const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      const syncFail = Object.assign(new Error("sync unsupported"), { code: "EPERM" });
      fsyncError.value = epermError;
      syncError.value = syncFail;
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "cause-check double-fail", category: "general", importance: 0.5, source: "test" },
      };

      await expect(wal.write(entry)).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof Error)) return false;
        const durabilityErr = err.cause;
        return durabilityErr instanceof Error && /WAL fsync unavailable \(EPERM\)/.test(durabilityErr.message);
      });
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

    it("throws WalReadCorruptionError for truncated/corrupt WAL files", async () => {
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
      await expect(recoveredWal.readAll()).rejects.toBeInstanceOf(WalReadCorruptionError);
    });

    it("loads recoverable IDs on init when WAL contains corrupt lines", async () => {
      const entry1 = {
        id: randomUUID(),
        timestamp: Date.now(),
        operation: "store" as const,
        data: { text: "Entry 1", category: "general", importance: 0.7, source: "test" },
      };
      const entry2 = {
        id: randomUUID(),
        timestamp: Date.now() + 1,
        operation: "store" as const,
        data: { text: "Entry 2", category: "general", importance: 0.8, source: "test" },
      };

      await wal.write(entry1);
      await wal.write(entry2);
      appendFileSync(walPath, "{not valid wal json}\n", "utf-8");

      const recoveredWal = new WriteAheadLog(walPath, DEFAULT_MAX_AGE_MS);
      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      await recoveredWal.init();
      await expect(recoveredWal.readAll()).rejects.toBeInstanceOf(WalReadCorruptionError);

      const { entries, hadCorruption } = await recoveredWal.readAllRecoverable();
      expect(entries).toHaveLength(2);
      expect(hadCorruption).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("recovered 2 active ID(s) from lenient read after corruption"),
      );

      await recoveredWal.remove(entry1.id);

      expect(existsSync(walPath)).toBe(true);
      expect(readFileSync(walPath, "utf-8")).toContain(entry2.id);
      warnSpy.mockRestore();
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
