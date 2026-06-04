/**
 * Write-Ahead Log (WAL) for crash resilience.
 * Append-only NDJSON format; fsync after each write for durability.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { appendFile, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DecayClass } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { pluginLogger } from "../utils/logger.js";

export const WAL_ENTRY_SCHEMA_VERSION = 1;

export type WALEntry = {
  schemaVersion?: number;
  id: string;
  timestamp: number;
  operation: "store" | "delete" | "update";
  targetId?: string;
  data: {
    text: string;
    why?: string | null;
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
    embeddingModelName?: string | null;
    // Optional metadata fields (best-effort) so replay can preserve semantics.
    scope?: "global" | "user" | "agent" | "session";
    scopeTarget?: string | null;
    sourceSessions?: string | null;
    provenanceSession?: string | null;
    sourceTurn?: number | null;
    extractionMethod?: string | null;
    extractionConfidence?: number | null;
    decayFreezeUntil?: number | null;
    preserveUntil?: number | null;
    preserveTags?: string[] | null;
    provenanceJson?: string | null;
    // Non-replayable diagnostic marker entries (for example doctor WAL durability probes).
    probe?: string;
  };
};

const WAL_REMOVE_PREFIX = '{"op":"remove","id":';

export class WalReadCorruptionError extends Error {
  readonly corruptLineCount: number;
  readonly lineNumbers: number[];

  constructor(corruptLineCount: number, lineNumbers: number[]) {
    super(
      `WAL readAll: ${corruptLineCount} corrupt entry line(s) at line(s) ${lineNumbers.join(", ")}; refusing partial replay`,
    );
    this.name = "WalReadCorruptionError";
    this.corruptLineCount = corruptLineCount;
    this.lineNumbers = lineNumbers;
  }
}

export function isWalEntry(obj: unknown): obj is WALEntry {
  if (typeof obj !== "object" || obj === null || !("id" in obj) || !("timestamp" in obj) || !("operation" in obj)) {
    return false;
  }
  const sv = (obj as WALEntry).schemaVersion;
  if (sv !== undefined && (typeof sv !== "number" || !Number.isFinite(sv) || sv < 1)) {
    return false;
  }
  const op = (obj as WALEntry).operation;
  if (!["store", "delete", "update"].includes(op)) return false;
  if ("targetId" in obj && (obj as WALEntry).targetId !== undefined) {
    const tid = (obj as WALEntry).targetId;
    if (typeof tid !== "string" || tid.length === 0) return false;
  }
  return true;
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

  getPath(): string {
    return this.walPath;
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
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "wal-init",
          subsystem: "wal",
        });
        pluginLogger.warn(
          `WAL init: failed to load active IDs, continuing with empty in-memory set: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.activeIds = new Set();
      } finally {
        // biome-ignore lint/style/noNonNullAssertion: Synchronous
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
      // "a+" read+append so fdatasync works on more filesystems than read-only or append-only edge cases (issue #854).
      fh = await open(this.walPath, "a+");
      try {
        await fh.datasync();
        return;
      } catch (datasyncErr) {
        const code = (datasyncErr as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EINVAL") throw datasyncErr;
        // Intentional fail-fast when neither datasync nor fsync can persist WAL writes (#7, #1846).
        // Some filesystems (e.g. NTFS via WSL2) reject fdatasync; reopen and try fsync() as fallback.
        await fh.close().catch(() => {});
        fh = undefined;
        try {
          fh = await open(this.walPath, "a+");
        } catch (openErr) {
          throw openErr;
        }
        try {
          await fh.sync();
          if (!this.fsyncWarnEmitted) {
            pluginLogger.warn(
              `[WAL] datasync() unsupported (${code}), using fsync() fallback — durability available but may be slower`,
            );
            this.fsyncWarnEmitted = true;
          }
          return;
        } catch (syncErr) {
          if (!this.fsyncWarnEmitted) {
            pluginLogger.error(
              `[WAL] CRITICAL: Both datasync() and fsync() failed (${code}) — WAL durability unavailable on this filesystem. Data loss may occur on crash. Consider moving the database to a POSIX-compliant filesystem.`,
            );
            this.fsyncWarnEmitted = true;
          }
          const causes = [datasyncErr, syncErr].filter((e): e is Error => e instanceof Error);
          const err = new Error(`WAL fsync unavailable (${code}): datasync and fsync fallback both failed`, {
            cause: syncErr instanceof Error ? syncErr : datasyncErr,
          });
          if (causes.length > 1) {
            (err as Error & { causes: Error[] }).causes = causes;
          }
          throw err;
        }
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
      const line = `${JSON.stringify(entry)}\n`;
      await appendFile(this.walPath, line, "utf-8");
      this.activeIds.add(entry.id);
      await this.fsyncAfterWrite();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-write",
        subsystem: "wal",
      });
      throw new Error(`WAL write failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      // biome-ignore lint/style/noNonNullAssertion: Synchronous
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
      if (!trimmed?.startsWith(WAL_REMOVE_PREFIX)) continue;
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
    const corruptLineNumbers: number[] = [];
    const lines = content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const trimmed = lines[lineIndex]?.trim();
      if (!trimmed || trimmed.startsWith(WAL_REMOVE_PREFIX)) continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (isWalEntry(obj) && !removedIds.has(obj.id)) entries.push(obj);
        else if (!isWalEntry(obj)) {
          corruptLineNumbers.push(lineIndex + 1);
        }
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "wal-parse-entry",
          severity: "info",
          subsystem: "wal",
        });
        pluginLogger.warn(`WAL readAll: failed to parse WAL entry line ${lineIndex + 1}, marking corrupt: ${err}`);
        corruptLineNumbers.push(lineIndex + 1);
      }
    }

    if (corruptLineNumbers.length > 0) {
      throw new WalReadCorruptionError(corruptLineNumbers.length, corruptLineNumbers);
    }

    return entries;
  }

  async remove(id: string): Promise<void> {
    await this.ensureInitialized();
    const prevLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      const line = `${JSON.stringify({ op: "remove", id })}\n`;
      await appendFile(this.walPath, line, "utf-8");
      this.activeIds.delete(id);
      await this.fsyncAfterWrite();
      if (this.activeIds.size === 0) {
        await this._clearInternal();
      }
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-remove",
        subsystem: "wal",
      });
      throw new Error(`WAL remove failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      // biome-ignore lint/style/noNonNullAssertion: Synchronous
      releaseLock!();
    }
  }

  private async _clearInternal(): Promise<void> {
    try {
      await rm(this.walPath, { force: true });
      this.activeIds.clear();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "wal-clear",
        subsystem: "wal",
      });
      throw new Error(`WAL clear failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  async clear(): Promise<void> {
    const prevLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      await this._clearInternal();
    } finally {
      // biome-ignore lint/style/noNonNullAssertion: Synchronous
      releaseLock!();
    }
  }

  async getValidEntries(): Promise<WALEntry[]> {
    const entries = await this.readAll();
    const now = Date.now();
    return entries.filter((e) => now - e.timestamp < this.maxAge);
  }

  private async atomicRewriteEntries(valid: WALEntry[]): Promise<void> {
    if (valid.length === 0) {
      await this._clearInternal();
      return;
    }
    const ndjson = valid.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmpPath = `${this.walPath}.prune.${process.pid}.tmp`;
    await writeFile(tmpPath, ndjson, "utf-8");
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(tmpPath, "r+");
      try {
        await fh.datasync();
      } catch (datasyncErr) {
        const code = (datasyncErr as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EINVAL") throw datasyncErr;
        await fh.close().catch(() => {});
        fh = await open(tmpPath, "r+");
        await fh.sync();
      }
    } finally {
      await fh?.close().catch(() => {});
    }
    await rename(tmpPath, this.walPath);
    this.activeIds.clear();
    for (const e of valid) {
      this.activeIds.add(e.id);
    }
    await this.fsyncAfterWrite();
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
        await this.atomicRewriteEntries(valid);
      }
      return pruned;
    } finally {
      // biome-ignore lint/style/noNonNullAssertion: Synchronous
      releaseLock!();
    }
  }

  async compactIfOversized(maxBytes: number): Promise<number> {
    const prevLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      if (!existsSync(this.walPath)) return 0;
      const st = statSync(this.walPath);
      if (st.size <= maxBytes) return 0;
      // Size-triggered rewrite only — never age-prune pending entries (#1876).
      const entries = await this.readAll();
      await this.atomicRewriteEntries(entries);
      return 0;
    } catch (err) {
      pluginLogger.info(
        `memory-hybrid: WAL compactIfOversized size check failed; skipping compaction: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      // biome-ignore lint/style/noNonNullAssertion: Synchronous
      releaseLock!();
    }
  }
}
