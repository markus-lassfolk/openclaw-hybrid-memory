/**
 * Unified workspace root resolution for CLI handlers (TOOLS.md, skills, ingest).
 * Order: explicit override → OPENCLAW_WORKSPACE → openclaw.json agents.defaults.workspace → default.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadOpenclawRootForWorkspace, resolveAgentWorkspaceRoot } from "../cli/install/workspace.js";
import { getEnv } from "./env-manager.js";
import { expandTilde } from "./path.js";

function isUsableWorkspacePath(p: string): boolean {
  const t = p.trim();
  if (t.length === 0) return false;
  const lower = t.toLowerCase();
  return lower !== "undefined" && lower !== "null";
}

/** Resolve agent workspace root for CLI commands. */
export function resolveCliWorkspaceRoot(opts?: { workspace?: string; config?: Record<string, unknown> }): string {
  const explicit = opts?.workspace?.trim();
  if (explicit && isUsableWorkspacePath(explicit)) return expandTilde(explicit);
  const env = getEnv("OPENCLAW_WORKSPACE")?.trim();
  if (env && isUsableWorkspacePath(env)) return expandTilde(env);
  const config = opts?.config ?? loadOpenclawRootForWorkspace();
  return resolveAgentWorkspaceRoot(config);
}

/** @internal Test helper — default when env and config are empty. */
export function defaultOpenClawWorkspaceRoot(): string {
  return join(homedir(), ".openclaw", "workspace");
}
