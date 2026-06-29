/**
 * Shared OpenClaw workspace root resolution (TOOLS.md, skills, ingest).
 * Kept separate from utils/path.ts to avoid import cycles with cli/install/workspace.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getEnv } from "./env-manager.js";

function expandTildeLocal(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

function isUsableWorkspacePath(p: string): boolean {
  const t = p.trim();
  if (t.length === 0) return false;
  const lower = t.toLowerCase();
  return lower !== "undefined" && lower !== "null";
}

/** Path to merged OpenClaw config JSON for workspace resolution. */
export function resolveOpenclawJsonPathForWorkspace(): string {
  const explicit = getEnv("OPENCLAW_CONFIG")?.trim() || getEnv("OPENCLAW_CONFIG_PATH")?.trim();
  if (explicit) return expandTildeLocal(explicit);
  const owHome = getEnv("OPENCLAW_HOME")?.trim();
  if (owHome) return join(expandTildeLocal(owHome), "openclaw.json");
  return join(homedir(), ".openclaw", "openclaw.json");
}

/** OpenClaw home directory (parent of openclaw.json). Honors OPENCLAW_HOME and config path env vars. */
export function resolveOpenclawHomeDir(): string {
  return dirname(resolveOpenclawJsonPathForWorkspace());
}

/** Load openclaw.json for workspace resolution; returns `{}` when missing/unreadable. */
export function loadOpenclawRootForWorkspace(): Record<string, unknown> {
  const configPath = resolveOpenclawJsonPathForWorkspace();
  try {
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Resolve agent workspace root.
 * Order: OPENCLAW_WORKSPACE → agents.defaults.workspace → agent.workspace → ~/.openclaw/workspace.
 */
export function resolveAgentWorkspaceRoot(config: Record<string, unknown>): string {
  const env = getEnv("OPENCLAW_WORKSPACE")?.trim();
  if (env && isUsableWorkspacePath(env)) return expandTildeLocal(env);
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const ws = defaults?.workspace;
  if (typeof ws === "string" && isUsableWorkspacePath(ws)) return expandTildeLocal(ws.trim());
  const agentBlock = config.agent as Record<string, unknown> | undefined;
  const legacyWs = agentBlock?.workspace;
  if (typeof legacyWs === "string" && isUsableWorkspacePath(legacyWs)) return expandTildeLocal(legacyWs.trim());
  return join(homedir(), ".openclaw", "workspace");
}

/** Resolve workspace with optional CLI override (never uses plugin config). */
export function resolveOpenClawWorkspaceRoot(opts?: { workspace?: string }): string {
  const explicit = opts?.workspace?.trim();
  if (explicit && isUsableWorkspacePath(explicit)) return expandTildeLocal(explicit);
  return resolveAgentWorkspaceRoot(loadOpenclawRootForWorkspace());
}
