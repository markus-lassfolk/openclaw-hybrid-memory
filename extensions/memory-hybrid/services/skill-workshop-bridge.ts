/**
 * Optional bridge to OpenClaw Skill Workshop proposal filesystem (Phase 5).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { getEnv } from "../utils/env-manager.js";
import { homedir } from "node:os";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { nowIso } from "../utils/dates.js";

export type SkillWorkshopBridgeInput = {
  name: string;
  description: string;
  skillContent: string;
  proposalId?: string;
};

export function isSkillWorkshopPluginActive(api?: { getTool?: (name: string) => unknown }): boolean {
  try {
    return typeof api?.getTool === "function" && api.getTool("skill_workshop") != null;
  } catch {
    return false;
  }
}

function escapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function skillWorkshopRoot(): string {
  const state = getEnv("OPENCLAW_STATE_DIR") ?? join(homedir(), ".openclaw");
  return join(state, "skill-workshop", "proposals");
}

export function writeSkillWorkshopProposal(input: SkillWorkshopBridgeInput): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const id = input.proposalId ?? randomUUID();
    const dir = join(skillWorkshopRoot(), id);
    mkdirSync(dir, { recursive: true });
    const date = nowIso();
    const frontmatter = [
      "---",
      `name: "${escapeYamlDoubleQuoted(input.name)}"`,
      `description: "${escapeYamlDoubleQuoted(input.description).slice(0, 160)}"`,
      "status: proposal",
      'version: "v1"',
      `date: "${date}"`,
      "---",
      "",
    ].join("\n");
    const proposalPath = join(dir, "PROPOSAL.md");
    atomicWriteFile(proposalPath, `${frontmatter}${input.skillContent}`);
    atomicWriteFile(
      join(dir, "proposal.json"),
      JSON.stringify({ id, name: input.name, description: input.description, createdAt: date, source: "hybrid-memory-bridge" }, null, 2),
    );
    return { ok: true, path: proposalPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a bridged skill-workshop proposal directory (best-effort). */
export function removeSkillWorkshopProposal(proposalId: string): { ok: true } | { ok: false; error: string } {
  const id = proposalId.trim();
  if (!id) return { ok: false, error: "missing proposal id" };
  const dir = join(skillWorkshopRoot(), id);
  if (!existsSync(dir)) return { ok: true };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
