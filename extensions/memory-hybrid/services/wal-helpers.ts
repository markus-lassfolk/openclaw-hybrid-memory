/**
 * WAL helpers — wrap the write-before-commit / remove-after-commit pattern.
 * Circuit breaker state is tracked per WAL file path (#1917 multi-vault isolation).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type WALEntry, WAL_ENTRY_SCHEMA_VERSION, type WriteAheadLog } from "../backends/wal.js";
import { nowIso } from "../utils/dates.js";
import { capturePluginError } from "./error-reporter.js";

const WAL_FAILURE_THRESHOLD = 10;
const DEFAULT_BREAKER_KEY = "__default__";

type WalBreakerSlice = {
  failureCount: number;
  inMemoryDisabled: boolean;
  persistentDisableWarned: boolean;
};

const walBreakerByPath = new Map<string, WalBreakerSlice>();

function breakerKey(walPath: string | null): string {
  return walPath ?? DEFAULT_BREAKER_KEY;
}

function getBreakerSlice(walPath: string | null): WalBreakerSlice {
  const key = breakerKey(walPath);
  let slice = walBreakerByPath.get(key);
  if (!slice) {
    slice = { failureCount: 0, inMemoryDisabled: false, persistentDisableWarned: false };
    walBreakerByPath.set(key, slice);
  }
  return slice;
}

export type WalCircuitBreakerState = {
  failureCount: number;
  inMemoryDisabled: boolean;
  persistentDisabled: boolean;
  walPath: string | null;
  sentinelPath: string | null;
};

/** JSON.stringify drops Float32Array as `{}`; normalize before WAL persistence (#896). */
function normalizeWalPayload(data: Record<string, unknown>): WALEntry["data"] {
  const d = { ...data } as Record<string, unknown>;
  const v = d.vector;
  if (v instanceof Float32Array) {
    d.vector = Array.from(v);
  }
  return d as WALEntry["data"];
}

export function getWalDisabledSentinelPath(walPath: string): string {
  return `${walPath}.disabled`;
}

function resolveWalPath(wal: WriteAheadLog | null): string | null {
  if (!wal) return null;
  const maybeGetPath = (wal as { getPath?: () => string }).getPath;
  if (typeof maybeGetPath !== "function") return null;
  try {
    const walPath = maybeGetPath.call(wal);
    if (typeof walPath !== "string") return null;
    const trimmed = walPath.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function isWalPersistentlyDisabledAtPath(walPath: string): boolean {
  try {
    return existsSync(getWalDisabledSentinelPath(walPath));
  } catch {
    return false;
  }
}

function resetWalCircuitBreakerState(): void {
  walBreakerByPath.clear();
}

function persistWalDisabledSentinel(walPath: string, failureCount: number, err: unknown): string {
  const sentinelPath = getWalDisabledSentinelPath(walPath);
  mkdirSync(dirname(sentinelPath), { recursive: true });
  const payload = {
    reason: "wal-circuit-breaker-threshold",
    threshold: WAL_FAILURE_THRESHOLD,
    failureCount,
    trippedAt: nowIso(),
    error: err instanceof Error ? err.message : String(err),
  };
  writeFileSync(sentinelPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return sentinelPath;
}

export function getWalCircuitBreakerState(wal: WriteAheadLog | null): WalCircuitBreakerState {
  const walPath = resolveWalPath(wal);
  const slice = getBreakerSlice(walPath);
  const sentinelPath = walPath ? getWalDisabledSentinelPath(walPath) : null;
  return {
    failureCount: slice.failureCount,
    inMemoryDisabled: slice.inMemoryDisabled,
    persistentDisabled: walPath ? isWalPersistentlyDisabledAtPath(walPath) : false,
    walPath,
    sentinelPath,
  };
}

/** True when WAL is configured but the write did not durably land (fail closed). */
export function isWalWriteFailure(
  wal: WriteAheadLog | null | undefined,
  walEntryId: string | null,
): walEntryId is null {
  if (wal == null) return false;
  return walEntryId === null;
}

export async function walWrite(
  wal: WriteAheadLog | null,
  operation: "store" | "update",
  data: Record<string, unknown>,
  logger: { warn: (msg: string) => void },
  supersedeTargetId?: string,
): Promise<string | null> {
  if (!wal) return null;
  const id = randomUUID();
  const walPath = resolveWalPath(wal);
  const slice = getBreakerSlice(walPath);

  if (slice.inMemoryDisabled) {
    logger.warn("memory-hybrid: WAL write skipped (circuit breaker disabled)");
    return null;
  }
  if (walPath && isWalPersistentlyDisabledAtPath(walPath)) {
    slice.inMemoryDisabled = true;
    if (!slice.persistentDisableWarned) {
      logger.warn(
        `memory-hybrid: WAL persistently disabled via ${getWalDisabledSentinelPath(walPath)} (remove sentinel to retry after fixing durability errors)`,
      );
      slice.persistentDisableWarned = true;
    }
    return null;
  }
  try {
    const entry: WALEntry = {
      id,
      timestamp: Date.now(),
      schemaVersion: WAL_ENTRY_SCHEMA_VERSION,
      operation,
      data: normalizeWalPayload(data),
    };
    if (operation === "update" && supersedeTargetId) {
      entry.targetId = supersedeTargetId;
    }
    await wal.write(entry);
    slice.failureCount = 0;
    slice.persistentDisableWarned = false;
    return id;
  } catch (err) {
    slice.failureCount++;
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "wal",
      operation: "wal-write",
    });
    logger.warn(`memory-hybrid: WAL write failed: ${err}`);
    if (slice.failureCount >= WAL_FAILURE_THRESHOLD) {
      slice.inMemoryDisabled = true;
      logger.warn(`memory-hybrid: WAL disabled after ${WAL_FAILURE_THRESHOLD} consecutive failures`);
      if (walPath) {
        try {
          const sentinelPath = persistWalDisabledSentinel(walPath, slice.failureCount, err);
          logger.warn(`memory-hybrid: WAL persistent disable sentinel written: ${sentinelPath}`);
        } catch (persistErr) {
          logger.warn(`memory-hybrid: failed to persist WAL disable sentinel: ${persistErr}`);
        }
      }
    }
    return null;
  }
}

export async function walRemove(
  wal: WriteAheadLog | null,
  id: string,
  logger: { warn: (msg: string) => void },
): Promise<void> {
  if (wal) {
    try {
      await wal.remove(id);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "wal",
        operation: "wal-remove",
      });
      logger.warn(`memory-hybrid: WAL cleanup failed: ${err}`);
    }
  }
}

/**
 * Reset the WAL circuit breaker state to its initial values.
 * Intended for use in tests only — do not call in production code.
 */
export function _resetWalCircuitBreakerForTesting(): void {
  resetWalCircuitBreakerState();
}
