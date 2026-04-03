/**
 * Locate OpenClaw session transcript files (~/.openclaw/agents/<agent>/sessions/*.jsonl)
 * for a given session key. Used to reconcile ACTIVE-TASK.md when subagent rows drift (#978).
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const t = sessionKey.trim();
  if (!t.startsWith("agent:")) return null;
  const parts = t.split(":");
  if (parts.length < 3) return null;
  const id = parts[1]?.trim();
  return id && id.length > 0 ? id : null;
}

/**
 * Heuristic: value looks like an OpenClaw session key or a bare session UUID.
 * Free-text subagent labels (e.g. human nicknames) are excluded to avoid false reconciles.
 */
export function looksLikeOpenClawSessionRef(ref: string | undefined): boolean {
  const t = ref?.trim() ?? "";
  if (!t) return false;
  if (t.startsWith("agent:")) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
}

/**
 * Best-effort: find a session JSONL whose basename corresponds to `sessionKey`.
 * Checks the agent-scoped sessions directory first when the key parses as `agent:<id>:…`.
 */
export async function findOpenClawSessionJsonlForKey(
  sessionKey: string,
  openclawHome = join(homedir(), ".openclaw"),
): Promise<string | null> {
  const key = sessionKey.trim();
  if (!key) return null;

  const baseCandidates = new Set<string>([
    `${key}.jsonl`,
    `${key.replace(/:/g, "_")}.jsonl`,
    `${key.replace(/:/g, "-")}.jsonl`,
  ]);
  const uuidMatch = key.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuidMatch) {
    baseCandidates.add(`${uuidMatch[1]}.jsonl`);
  }

  const tryDir = async (sessionsDir: string): Promise<string | null> => {
    if (!existsSync(sessionsDir)) return null;
    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      return null;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl") || f.startsWith(".deleted")) continue;
      if (baseCandidates.has(f)) return join(sessionsDir, f);
      const base = f.slice(0, -".jsonl".length);
      if (base === key) return join(sessionsDir, f);
      if (uuidMatch && (base === uuidMatch[1] || f.includes(uuidMatch[1]))) {
        return join(sessionsDir, f);
      }
    }
    return null;
  };

  const agentId = parseAgentIdFromSessionKey(key);
  if (agentId) {
    const hit = await tryDir(join(openclawHome, "agents", agentId, "sessions"));
    if (hit) return hit;
  }

  const agentsRoot = join(openclawHome, "agents");
  if (!existsSync(agentsRoot)) return null;
  let names: string[];
  try {
    names = await readdir(agentsRoot);
  } catch {
    return null;
  }
  for (const name of names) {
    const hit = await tryDir(join(agentsRoot, name, "sessions"));
    if (hit) return hit;
  }
  return null;
}

export async function isOpenClawSessionLikelyPresent(sessionKey: string, openclawHome?: string): Promise<boolean> {
  return (await findOpenClawSessionJsonlForKey(sessionKey, openclawHome)) != null;
}
