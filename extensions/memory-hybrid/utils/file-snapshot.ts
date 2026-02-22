/**
 * Capture a lightweight snapshot of a file for conflict detection.
 */

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

export type FileSnapshot = {
  mtimeMs: number;
  hash: string;
};

export function getFileSnapshot(path: string): FileSnapshot | null {
  try {
    const stat = statSync(path);
    const content = readFileSync(path);
    const hash = createHash("sha256").update(content).digest("hex");
    return { mtimeMs: stat.mtimeMs, hash };
  } catch {
    return null;
  }
}
