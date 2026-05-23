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
