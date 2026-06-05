/**
 * Shared dream-cycle artifact directory resolution.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getEnv } from "./env-manager.js";

/** Parent directory containing `run-{runId}/stage-*.json` artifact folders. */
export function resolveDreamCycleLogDir(): string {
  const envDir = getEnv("HYBRID_MEM_DREAM_STAGE_DIR");
  if (envDir?.trim()) return envDir.trim();
  const openclawHome = getEnv("OPENCLAW_HOME")?.trim() || join(homedir(), ".openclaw");
  return join(openclawHome, "logs", "dream-cycle");
}
