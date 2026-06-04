/**
 * Resolve session JSONL paths for extract-* maintenance CLIs.
 * When procedures.allAgentSessions is true, scans every agent session dir under ~/.openclaw/agents.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HybridMemoryConfig } from "../config.js";
import { getSessionFilePathsSince } from "../cli/cmd-extract-sessions.js";

export function resolveExtractSessionFilePaths(
  cfg: HybridMemoryConfig,
  days: number,
  sinceTimestamp?: number,
): string[] {
  if (cfg.procedures.allAgentSessions) {
    const agentsRoot = join(homedir(), ".openclaw", "agents");
    if (!existsSync(agentsRoot)) return [];
    const paths: string[] = [];
    for (const agent of readdirSync(agentsRoot)) {
      const sessionDir = join(agentsRoot, agent, "sessions");
      paths.push(...getSessionFilePathsSince(sessionDir, days, sinceTimestamp));
    }
    return paths;
  }
  return getSessionFilePathsSince(cfg.procedures.sessionsDir, days, sinceTimestamp);
}
