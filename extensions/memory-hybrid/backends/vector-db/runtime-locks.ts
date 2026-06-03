/**
 * Module-level cooperative locks for LanceDB readers, optimize exclusivity, and re-index
 * exclusion. Refcount maps use `.get(path) ?? 0` intentionally: updates run in synchronous
 * JS blocks (no await between read and write), which is safe on Node's single-threaded model.
 * Async callers must re-check immediately before mutating LanceDB (#1841).
 */
export const activeReadersByPath = new Map<string, number>();
export const optimizeExclusiveLockByPath = new Map<string, boolean>();
export const reindexExclusiveLockByPath = new Map<string, number>();

export function getActiveReaderCount(dbPath: string): number {
  return activeReadersByPath.get(dbPath) ?? 0;
}

export function incrementActiveReaderCount(dbPath: string): void {
  activeReadersByPath.set(dbPath, getActiveReaderCount(dbPath) + 1);
}

export function decrementActiveReaderCount(dbPath: string): void {
  activeReadersByPath.set(dbPath, Math.max(0, getActiveReaderCount(dbPath) - 1));
}

export function isOptimizeLocked(dbPath: string): boolean {
  return optimizeExclusiveLockByPath.get(dbPath) === true;
}

export function setOptimizeLock(dbPath: string, locked: boolean): void {
  optimizeExclusiveLockByPath.set(dbPath, locked);
}

export function getReindexLockCount(dbPath: string): number {
  return reindexExclusiveLockByPath.get(dbPath) ?? 0;
}

export function incrementReindexLockCount(dbPath: string): void {
  reindexExclusiveLockByPath.set(dbPath, getReindexLockCount(dbPath) + 1);
}

export function decrementReindexLockCount(dbPath: string): void {
  const next = getReindexLockCount(dbPath) - 1;
  if (next <= 0) {
    reindexExclusiveLockByPath.delete(dbPath);
    return;
  }
  reindexExclusiveLockByPath.set(dbPath, next);
}

/** Returns true when a re-index operation currently holds the cooperative re-index lock. */
export function isReindexLockHeld(dbPath: string): boolean {
  return getReindexLockCount(dbPath) > 0;
}

/**
 * Wait until no re-index lock is held. Re-validates synchronously after each drain so a lock
 * acquired during an await does not leave callers proceeding into LanceDB mutations (#1841).
 */
export async function waitForReindexLockClear(dbPath: string, maxWaitMs = 30_000): Promise<void> {
  const started = Date.now();
  while (isReindexLockHeld(dbPath)) {
    if (Date.now() - started > maxWaitMs) {
      throw new Error(
        `VectorDB operation blocked by active re-index lock for >${maxWaitMs}ms. Retry after re-index completes.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
