/**
 * Shared CLI utilities
 *
 * Contains concurrency lock infrastructure and other utilities shared across
 * multiple CLI command modules.
 */

/** In-memory concurrency lock: prevents two simultaneous scans of the same type. */
const SCAN_IN_PROGRESS = new Map<string, boolean>();

/** 23-hour threshold for startup guard (milliseconds). */
export const SCAN_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

/**
 * Apply the 23h startup guard and concurrency lock for a scan type.
 * Returns a skip reason string if the scan should be skipped, or null if it can proceed.
 * If it can proceed, marks the scan as in-progress (caller must call clearScanLock when done).
 */
export function acquireScanSlot(
  scanType: string,
  lastRunAt: number | undefined,
  logger: { info?: (s: string) => void },
): string | null {
  if (SCAN_IN_PROGRESS.get(scanType)) {
    const msg = `Skipping ${scanType}: already running`;
    logger.info?.(msg);
    return msg;
  }
  if (lastRunAt !== undefined && lastRunAt !== 0 && Date.now() - lastRunAt < SCAN_MIN_INTERVAL_MS) {
    const hoursAgo = ((Date.now() - lastRunAt) / 3_600_000).toFixed(1);
    const msg = `Skipping ${scanType}: last run was ${hoursAgo}h ago (threshold: 23h). Use --full to override.`;
    logger.info?.(msg);
    return msg;
  }
  SCAN_IN_PROGRESS.set(scanType, true);
  return null;
}

export function clearScanLock(scanType: string): void {
  SCAN_IN_PROGRESS.delete(scanType);
}
