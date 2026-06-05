/**
 * Notify OpenClaw skill loader that on-disk skills changed (Phase 5).
 */

import { getEnv } from "../utils/env-manager.js";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDefaultWorkspaceDir(): string {
  return getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
}

export async function bumpSkillsSnapshotBestEffort(opts: {
  workspaceDir?: string;
  changedPath?: string;
  reason?: string;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<void> {
  const workspaceDir = opts.workspaceDir ?? resolveDefaultWorkspaceDir();
  try {
    const skillsSdkPath = "openclaw/plugin-sdk/skills";
    const mod = await import(/* @vite-ignore */ skillsSdkPath).catch(() => null);
    const bump = mod?.bumpSkillsSnapshotVersion as
      | ((args: { workspaceDir: string; reason: string; changedPath?: string }) => void)
      | undefined;
    if (typeof bump !== "function") {
      opts.logger?.debug?.("memory-hybrid: bumpSkillsSnapshotVersion unavailable on this OpenClaw version");
      return;
    }
    bump({
      workspaceDir,
      reason: opts.reason ?? "hybrid-memory-skill-install",
      changedPath: opts.changedPath,
    });
  } catch (err) {
    opts.logger?.warn?.(`memory-hybrid: bumpSkillsSnapshotVersion failed (non-fatal): ${err}`);
  }
}
