/**
 * Path utilities for memory-hybrid extension.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand tilde (~) in path to user's home directory.
 * Handles both "~" and "~/..." patterns.
 */
export function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(1));
  }
  return p;
}
