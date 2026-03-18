/**
 * Write-Ahead Log (WAL) for crash resilience.
 * Append-only NDJSON format; fsync after each write for durability.
 */

import { mkdirSync } from "node:fs";
import { appendFile, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DecayClass } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { pluginLogger } from "../utils/logger.js";

export type WALEntry = {
  id: string;
  timestamp: number;
  operation: "store" | "delete" | "update";
  data: {
    text: string;
    category?: string;
    importance?: number;
    entity?: string | null;
    key?: string | null;
    value?: string | null;
    source?: string;
    decayClass?: DecayClass;
    summary?: string | null;
    tags?: string[];
    vector?: number[];
  };
};

const WAL_REMOVE_PREFIX = '{"op":"remove","id":';

export function isWalEntry(obj: unknown): obj is WALEntry {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "id" in obj &&
    "timestamp" in obj &&
    "operation" in obj &&
    ["store", "delete", "update"].includes((obj as WALEntry).operation)
  );
}

export class WriteAheadLog {
  private walPath: string;
  private maxAge: number;
  private fsyncWarnEmitted = false;
  private writeLock: Promise<void> = Promise.resolve();
  private activeIds = new Set<string>();
  private initPromise: Promise<void> | null = null;

  constructor(walPath: string, maxAge: number = 5 * 60 * 1000) {
    this.walPath = walPath;
    this.maxAge = maxAge;
    // mkdirSync is acceptable here — constructor runs once at startup, not on the hot path.
    mkdirSync(dirname(walPath), { recursive: true });
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      const prevLock = this.writeLock;
      let releaseLock: () => void;
      this.writeLock = new Promise((resolve) => {
        releaseLock = resolve;
      });

      try {
        await prevLock;
        const entries = await this.readAll();
        this.activeIds = new Set(entries.map((e) => e.id));
      } catch {
        this.activeIds = new Set();
      } finally {
        releaseLock!();
      }
    })();
    return this.initPromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      await this.init();
    } else {
      await this.initPromise;
    }
  }

  private async fsyncAfterWrite(): Promise<void> {
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(this.walPath, "r");
      await fh.datasync();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EINVAL") {
        // Some filesystems (e.g. NTFS via WSL2) do not support fsync on a
        // read-only file descriptor.  The data has already been written by
        // appendFile / writeFile; skipping fsync here is safe and the
        // durability guarantee degrades to best-effort on those filesystems.
        if (!this.fsyncWarnEmitted) {
          pluginLogger.warn(
            `[WAL] fsync skipped (${code}): filesystem may not support fsync – durability is best-effort`,
          );
          this.fsyncWarnEmitted = true;
        }
      } else {
        throw err;
      }
    } finally {
      await fh?.close();
    }
  }

  async write(entry: WALEntry): Promise<void> {
    const prevLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      const line = JSON.stringify(entry) + "\n";
      await appendFile(this.walPath, line, "utf-8");
      this.activeIds.add(entry.id);
      await this.fsyncAfterWrite();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-write",
        subsystem: "wal",
      });
      throw new Error(`WAL write failed: ${err}`);
    } finally {
      releaseLock!();
    }
  }

  async readAll(): Promise<WALEntry[]> {
    let rawContent: string;
    try {
      rawContent = await readFile(this.walPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const content = rawContent.trim();
    if (!content) return [];

    // Backward-compat: support full-file JSON array format if present.
    if (content.startsWith("[")) {
      try {
        const entries = JSON.parse(content) as WALEntry[];
        return Array.isArray(entries) ? entries : [];
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "wal-parse-array",
          severity: "info",
          subsystem: "wal",
        });
        // Fall back to NDJSON parsing if the array is corrupted.
        pluginLogger.warn(
          `WAL readAll: failed to parse JSON array format, falling back to line-by-line parsing: ${err}`,
        );
      }
    }

    const removedIds = new Set<string>();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith(WAL_REMOVE_PREFIX)) continue;
      try {
        const obj = JSON.parse(trimmed) as { op: string; id: string };
        if (obj.op === "remove" && obj.id) removedIds.add(obj.id);
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "wal-parse-remove",
          severity: "info",
          subsystem: "wal",
        });
        pluginLogger.warn(`WAL readAll: failed to parse remove line, skipping: ${err}`);
      }
    }

    const entries: WALEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(WAL_REMOVE_PREFIX)) continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (isWalEntry(obj) && !removedIds.has(obj.id)) entries.push(obj);
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "wal-parse-entry",
          severity: "info",
          subsystem: "wal",
        });
        pluginLogger.warn(`WAL readAll: failed to parse WAL entry line, skipping: ${err}`);
      }
    }

    return entries;
  }

  async remove(id: string): Promise<void> {
    const prevLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      await this.ensureInitialized();
      const line = JSON.stringify({ op: "remove", id }) + "\n";
      await appendFile(this.walPath, line, "utf-8");
      await this.fsyncAfterWrite();
      this.activeIds.delete(id);
      if (this.activeIds.size === 0) {
        await this.clear();
      }
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-remove",
        subsystem: "wal",
      });
      throw new Error(`WAL remove failed: ${err}`);
    } finally {
      releaseLock!();
    }
  }

  async clear(): Promise<void> {
    try {
      await rm(this.walPath, { force: true });
      this.activeIds.clear();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-clear",
        subsystem: "wal",
      });
      throw new Error(`WAL clear failed: ${err}`);
    }
  }

  async getValidEntries(): Promise<WALEntry[]> {
    const entries = await this.readAll();
    const now = Date.now();
    return entries.filter((e) => now - e.timestamp < this.maxAge);
  }

  async pruneStale(): Promise<number> {
    const prevLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      const entries = await this.readAll();
      const now = Date.now();
      const valid = entries.filter((e) => now - e.timestamp < this.maxAge);
      const pruned = entries.length - valid.length;

      if (pruned > 0) {
        if (valid.length === 0) {
          await this.clear();
        } else {
          const ndjson = valid.map((e) => JSON.stringify(e)).join("\n") + (valid.length ? "\n" : "");
          await writeFile(this.walPath, ndjson, "utf-8");
          await this.fsyncAfterWrite();
          this.activeIds.clear();
          for (const e of valid) {
            this.activeIds.add(e.id);
          }
        }
      }
      return pruned;
    } finally {
      releaseLock!();
    }
  }
}
