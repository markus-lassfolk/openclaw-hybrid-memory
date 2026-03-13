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

/**
 * Expand home directory placeholders in a path.
 * Handles both leading "~" and literal "$HOME" prefixes.
 * Use this when reading path values from user configuration files.
 */
export function expandHomePlaceholders(p: string): string {
  const home = process.env.HOME ?? homedir();
  if (p === "$HOME" || p.startsWith("$HOME/")) {
    return home + p.slice("$HOME".length);
  }
  return expandTilde(p);
}
