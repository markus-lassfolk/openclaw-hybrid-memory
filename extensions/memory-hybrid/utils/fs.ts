/**
 * File system utilities
 */

import { statSync, readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Returns the byte size of a file, or 0 if it cannot be read.
 */
export function getFileSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

/**
 * Recursively calculate the total size of a directory (synchronous).
 * @param dirPath - Path to the directory
 * @returns Total size in bytes, or 0 if the directory cannot be read
 */
export function getDirSizeSync(dirPath: string): number {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          total += statSync(fullPath).size;
        } catch {
          // skip unreadable files
        }
      } else if (entry.isDirectory()) {
        total += getDirSizeSync(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Recursively calculate the total size of a directory (asynchronous).
 * @param dirPath - Path to the directory
 * @returns Total size in bytes, or 0 if the directory cannot be read
 */
export async function getDirSize(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          total += (await stat(fullPath)).size;
        } catch {
          // skip unreadable files
        }
      } else if (entry.isDirectory()) {
        total += await getDirSize(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}
