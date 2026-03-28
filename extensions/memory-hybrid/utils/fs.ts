/**
 * File system utilities
 */

import { readdirSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Returns the byte size of a file, or 0 if it cannot be read.
 */
export function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Returns the byte size of a file asynchronously, or 0 if it cannot be read.
 */
export async function getFileSizeAsync(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
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
    const promises = entries.map(async (entry) => {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          return (await stat(fullPath)).size;
        } catch {
          return 0;
        }
      } else if (entry.isDirectory()) {
        return getDirSize(fullPath);
      }
      return 0;
    });
    const sizes = await Promise.all(promises);
    return sizes.reduce((total, size) => total + size, 0);
  } catch {
    return 0;
  }
}

/**
 * Reads and parses a JSON file.
 * @param filePath - Path to the JSON file
 * @returns Parsed JSON object, or null if the file cannot be read or parsed
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}
