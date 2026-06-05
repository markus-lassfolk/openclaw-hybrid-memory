/**
 * Optional bridge to OpenClaw Skill Workshop proposal filesystem (Phase 5).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { getEnv } from "../utils/env-manager.js";
import { homedir } from "node:os";
import { atomicWriteFile } from "../utils/atomic-write.js";

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

function skillWorkshopRoot(): string {
  const state = getEnv("OPENCLAW_STATE_DIR") ?? join(homedir(), ".openclaw");
  return join(state, "skill-workshop", "proposals");
}

export function writeSkillWorkshopProposal(input: SkillWorkshopBridgeInput): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const id = input.proposalId ?? randomUUID();
    const dir = join(skillWorkshopRoot(), id);
    mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString();
    const frontmatter = [
      "---",
      `name: "${input.name.replace(/"/g, '\\"')}"`,
      `description: "${input.description.replace(/"/g, '\\"').slice(0, 160)}"`,
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
