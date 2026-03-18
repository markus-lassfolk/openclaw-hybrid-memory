/**
 * Write-Ahead Log (WAL) for crash resilience.
 * Append-only NDJSON format; fsync after each write for durability.
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DecayClass } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";

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
  /** In-memory set of IDs that are currently active (written but not removed).
   *  Seeded with a single O(n) parse at construction; updated on every
   *  write/remove/clear so that remove() never needs to call readAll(). */
  private activeIds: Set<string>;

  constructor(walPath: string, maxAge: number = 5 * 60 * 1000) {
    this.walPath = walPath;
    this.maxAge = maxAge;
    mkdirSync(dirname(walPath), { recursive: true });
    // One-time O(n) parse to seed the in-memory active-ID set.
    // Wrapped in try-catch so that a bad path (e.g. a directory) does not
    // prevent construction – write/remove will surface the error at call time.
    try {
      this.activeIds = new Set(this.readAll().map((e) => e.id));
    } catch {
      this.activeIds = new Set();
    }
  }

  private fsyncAfterWrite(): void {
    const fd = openSync(this.walPath, "r");
    try {
      fsyncSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EINVAL") {
        // Some filesystems (e.g. NTFS via WSL2) do not support fsync on a
        // read-only file descriptor.  The data has already been written by
        // appendFileSync / writeFileSync; skipping fsync here is safe and the
        // durability guarantee degrades to best-effort on those filesystems.
        if (!this.fsyncWarnEmitted) {
          console.warn(`[WAL] fsync skipped (${code}): filesystem may not support fsync – durability is best-effort`);
          this.fsyncWarnEmitted = true;
        }
      } else {
        throw err;
      }
    } finally {
      closeSync(fd);
    }
  }

  write(entry: WALEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.walPath, line, "utf-8");
      this.fsyncAfterWrite();
      this.activeIds.add(entry.id);
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-write",
        subsystem: "wal",
      });
      throw new Error(`WAL write failed: ${err}`);
    }
  }

  readAll(): WALEntry[] {
    if (!existsSync(this.walPath)) return [];
    const content = readFileSync(this.walPath, "utf-8").trim();
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
        console.warn(`WAL readAll: failed to parse JSON array format, falling back to line-by-line parsing: ${err}`);
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
        console.warn(`WAL readAll: failed to parse remove line, skipping: ${err}`);
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
        console.warn(`WAL readAll: failed to parse WAL entry line, skipping: ${err}`);
      }
    }

    return entries;
  }

  remove(id: string): void {
    try {
      const line = JSON.stringify({ op: "remove", id }) + "\n";
      appendFileSync(this.walPath, line, "utf-8");
      this.fsyncAfterWrite();
      // Use the in-memory set — no O(n) readAll() needed.
      this.activeIds.delete(id);
      if (this.activeIds.size === 0) this.clear();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-remove",
        subsystem: "wal",
      });
      throw new Error(`WAL remove failed: ${err}`);
    }
  }

  clear(): void {
    try {
      if (existsSync(this.walPath)) rmSync(this.walPath, { force: true });
      this.activeIds.clear();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-clear",
        subsystem: "wal",
      });
      throw new Error(`WAL clear failed: ${err}`);
    }
  }

  getValidEntries(): WALEntry[] {
    const entries = this.readAll();
    const now = Date.now();
    return entries.filter((e) => now - e.timestamp < this.maxAge);
  }

  pruneStale(): number {
    const entries = this.readAll();
    const now = Date.now();
    const valid = entries.filter((e) => now - e.timestamp < this.maxAge);
    const pruned = entries.length - valid.length;

    if (pruned > 0) {
      if (valid.length === 0) {
        this.clear();
      } else {
        const ndjson = valid.map((e) => JSON.stringify(e)).join("\n") + (valid.length ? "\n" : "");
        writeFileSync(this.walPath, ndjson, "utf-8");
        this.fsyncAfterWrite();
      }
      // Sync the in-memory set after compaction.
      this.activeIds = new Set(valid.map((e) => e.id));
    }
    return pruned;
  }
}
