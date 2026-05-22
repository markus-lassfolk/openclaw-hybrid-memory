/**
 * WAL helpers — wrap the write-before-commit / remove-after-commit pattern.
 * Each call site was 8–12 lines of identical boilerplate; these reduce it to 1–2 lines.
 *
 * Circuit breaker: After 10 consecutive failures, WAL is disabled to prevent degradation.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type WALEntry, WAL_ENTRY_SCHEMA_VERSION, type WriteAheadLog } from "../backends/wal.js";
import { capturePluginError } from "./error-reporter.js";

const WAL_FAILURE_THRESHOLD = 10;
const WAL_DISABLED_SENTINEL = ".wal.disabled";
let walFailureCount = 0;
let walDisabled = false;
let walPersistentDisableWarned = false;

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
  return join(dirname(walPath), WAL_DISABLED_SENTINEL);
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
  walFailureCount = 0;
  walDisabled = false;
  walPersistentDisableWarned = false;
}

export function clearWalDisabledSentinelAtPath(walPath: string): boolean {
  try {
    rmSync(getWalDisabledSentinelPath(walPath), { force: true });
    resetWalCircuitBreakerState();
    return true;
  } catch {
    return false;
  }
}

function persistWalDisabledSentinel(walPath: string, err: unknown): string {
  const sentinelPath = getWalDisabledSentinelPath(walPath);
  mkdirSync(dirname(sentinelPath), { recursive: true });
  const payload = {
    reason: "wal-circuit-breaker-threshold",
    threshold: WAL_FAILURE_THRESHOLD,
    failureCount: walFailureCount,
    trippedAt: new Date().toISOString(),
    error: err instanceof Error ? err.message : String(err),
  };
  writeFileSync(sentinelPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return sentinelPath;
}

export function getWalCircuitBreakerState(wal: WriteAheadLog | null): WalCircuitBreakerState {
  const walPath = resolveWalPath(wal);
  const sentinelPath = walPath ? getWalDisabledSentinelPath(walPath) : null;
  return {
    failureCount: walFailureCount,
    inMemoryDisabled: walDisabled,
    persistentDisabled: walPath ? isWalPersistentlyDisabledAtPath(walPath) : false,
    walPath,
    sentinelPath,
  };
}

export async function walWrite(
  wal: WriteAheadLog | null,
  operation: "store" | "update",
  data: Record<string, unknown>,
  logger: { warn: (msg: string) => void },
  supersedeTargetId?: string,
): Promise<string> {
  const id = randomUUID();
  if (!wal) return id;
  if (walDisabled) return id;
  const walPath = resolveWalPath(wal);
  if (walPath && isWalPersistentlyDisabledAtPath(walPath)) {
    walDisabled = true;
    if (!walPersistentDisableWarned) {
      logger.warn(
        `memory-hybrid: WAL persistently disabled via ${getWalDisabledSentinelPath(walPath)} (remove sentinel to retry after fixing durability errors)`,
      );
      walPersistentDisableWarned = true;
    }
    return id;
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
    walFailureCount = 0; // Reset on success
    walPersistentDisableWarned = false;
  } catch (err) {
    walFailureCount++;
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "wal",
      operation: "wal-write",
    });
    logger.warn(`memory-hybrid: WAL write failed: ${err}`);
    if (walFailureCount >= WAL_FAILURE_THRESHOLD) {
      walDisabled = true;
      logger.warn(`memory-hybrid: WAL disabled after ${WAL_FAILURE_THRESHOLD} consecutive failures`);
      if (walPath) {
        try {
          const sentinelPath = persistWalDisabledSentinel(walPath, err);
          logger.warn(`memory-hybrid: WAL persistent disable sentinel written: ${sentinelPath}`);
        } catch (persistErr) {
          logger.warn(`memory-hybrid: failed to persist WAL disable sentinel: ${persistErr}`);
        }
      }
    }
  }
  return id;
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
