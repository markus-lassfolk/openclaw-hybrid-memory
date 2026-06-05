import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile } from "../../utils/atomic-write.js";

export interface CheckpointStore<T> {
  load(): T | null;
  save(state: T): void;
  clear(): void;
  path: string;
}

export function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function createFileCheckpointStore<T>(path: string): CheckpointStore<T> {
  return {
    path,
    load(): T | null {
      return readJsonFile<T>(path);
    },
    save(state: T): void {
      atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
    },
    clear(): void {
      if (!existsSync(path)) return;
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
    },
  };
}
