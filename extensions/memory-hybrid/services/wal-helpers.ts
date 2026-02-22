/**
 * WAL helpers — wrap the write-before-commit / remove-after-commit pattern.
 * Each call site was 8–12 lines of identical boilerplate; these reduce it to 1–2 lines.
 *
 * Circuit breaker: After 10 consecutive failures, WAL is disabled to prevent degradation.
 */

import { randomUUID } from "node:crypto";
import type { WriteAheadLog } from "../backends/wal.js";
import { capturePluginError } from "../services/error-reporter.js";

const WAL_FAILURE_THRESHOLD = 10;
let walFailureCount = 0;
let walDisabled = false;

export function walWrite(
  wal: WriteAheadLog | null,
  operation: "store" | "update",
  data: Record<string, unknown>,
  logger: { warn: (msg: string) => void },
): string {
  const id = randomUUID();
  if (wal && !walDisabled) {
    try {
      wal.write({ id, timestamp: Date.now(), operation, data: data as any });
      walFailureCount = 0; // Reset on success
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
      }
    }
  }
  return id;
}

export function walRemove(
  wal: WriteAheadLog | null,
  id: string,
  logger: { warn: (msg: string) => void },
): void {
  if (wal) {
    try {
      wal.remove(id);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "wal",
        operation: "wal-remove",
      });
      logger.warn(`memory-hybrid: WAL cleanup failed: ${err}`);
    }
  }
}
