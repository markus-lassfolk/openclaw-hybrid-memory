import { getEnv } from "./env-manager.js";
/**
 * Path utilities for memory-hybrid extension.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
  const home = getEnv("HOME") ?? homedir();
  if (p === "$HOME" || p.startsWith("$HOME/")) {
    return home + p.slice("$HOME".length);
  }
  return expandTilde(p);
}

/**
 * Resolve the OpenClaw workspace root directory.
 * Defaults to ~/.openclaw/workspace if OPENCLAW_WORKSPACE is not set.
 */
export function resolveWorkspaceRoot(): string {
  return getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
}

/**
 * Resolve a potentially-relative file path against the workspace root.
 * If the path is absolute, returns it as-is.
 * If the path is relative, joins it with the workspace root.
 */
export function resolveWorkspacePath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(resolveWorkspaceRoot(), filePath);
}
