/**
 * Bridge dream-cycle reflection output into governed proposal queues (Phase 4).
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { FactsDB } from "../backends/facts-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import { inferTargetFile } from "../cli/cmd-store.js";
import { resolvePipelineProposalTarget } from "../cli/proposals.js";
import type { HybridMemoryConfig } from "../config.js";
import { getEnv } from "../utils/env-manager.js";
import { enforceMaxPendingCap, makeUnifiedKey } from "./unified-proposals.js";
import { isSkillWorkshopPluginActive, writeSkillWorkshopProposal } from "./skill-workshop-bridge.js";

export type DreamCycleProposalBridgeInput = {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  proposalsDb: ProposalsDB | null;
  patternsStored: number;
  rulesGenerated: number;
  /** Rule fact IDs created during this dream cycle (avoids re-proposing existing rules). */
  newRuleFactIds?: string[];
  /** Pattern fact IDs created during this dream cycle. */
  newPatternFactIds?: string[];
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  api?: { getTool?: (name: string) => unknown };
  workspaceRoot?: string;
};

const MAX_PERSONA_PROPOSALS_PER_CYCLE = 5;
const MAX_SKILL_WORKSHOP_PROPOSALS_PER_CYCLE = 3;

function pendingSuggestedChanges(proposalsDb: ProposalsDB): Set<string> {
  return new Set(
    proposalsDb
      .list({ status: "pending" })
      .map((p) => p.suggestedChange.trim())
      .filter(Boolean),
  );
}

function resolveNewFacts(
  factsDb: FactsDB,
  ids: string[] | undefined,
  category: "rule" | "pattern",
): Array<{ id: string; text: string }> {
  if (!ids?.length) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const out: Array<{ id: string; text: string }> = [];
  for (const id of ids) {
    const fact = factsDb.getById(id);
    if (!fact || fact.category !== category || fact.supersededAt) continue;
    if (fact.expiresAt !== null && fact.expiresAt <= nowSec) continue;
    const text = fact.text?.trim();
    if (!text) continue;
    out.push({ id: fact.id, text });
  }
  return out;
}

export function runDreamCycleProposalBridge(input: DreamCycleProposalBridgeInput): {
  personaProposalsCreated: number;
  skillWorkshopBridged: number;
} {
  if (input.cfg.nightlyCycle.autoPropose !== true) {
    return { personaProposalsCreated: 0, skillWorkshopBridged: 0 };
  }

  let personaProposalsCreated = 0;
  let skillWorkshopBridged = 0;
  const workspaceRoot = input.workspaceRoot ?? getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const allowedFiles = input.cfg.personaProposals.allowedFiles;
  const minConf = input.cfg.personaProposals.minConfidence;
  const evidenceSessions = Array.from(
    { length: Math.max(1, input.cfg.personaProposals.minSessionEvidence) },
    () => "dream-cycle-pipeline",
  );

  const capStores = {
    cfg: input.cfg,
    factsDb: input.factsDb,
    proposalsDb: input.proposalsDb,
    crystallizationStore: null,
    toolProposalStore: null,
  };

  if (input.rulesGenerated > 0 && input.proposalsDb && input.cfg.personaProposals.enabled) {
    const pendingChanges = pendingSuggestedChanges(input.proposalsDb);
    const newRules = resolveNewFacts(input.factsDb, input.newRuleFactIds, "rule").slice(
      0,
      MAX_PERSONA_PROPOSALS_PER_CYCLE,
    );

    for (const { text } of newRules) {
      if (text.length < 20) continue;
      if (pendingChanges.has(text)) continue;

      const cap = enforceMaxPendingCap(capStores);
      if (!cap.ok) {
        input.logger.warn(
          `memory-hybrid: dream-cycle auto-propose stopped (${cap.error}, pending=${cap.pending})`,
        );
        break;
      }

      const targetFile = inferTargetFile(text);
      const resolved = resolvePipelineProposalTarget({
        targetFile,
        suggestedChange: text,
        allowedFiles,
        workspaceRoot,
        confidence: 0.75,
        proposalTTLDays: input.cfg.personaProposals.proposalTTLDays,
        minConfidence: minConf,
        proposalsDb: input.proposalsDb ?? undefined,
      });
      if (!resolved) continue;

      const created = input.proposalsDb.create({
        targetFile: resolved.targetFile,
        title: `Dream-cycle rule: ${text.slice(0, 60)}`,
        observation: "Auto-proposed from dream-cycle reflect-rules output",
        suggestedChange: text,
        confidence: resolved.confidence,
        evidenceSessions,
        expiresAt: resolved.expiresAt,
        targetMtimeMs: resolved.targetMtimeMs,
        targetHash: resolved.targetHash,
      });
      pendingChanges.add(text);
      personaProposalsCreated++;
      input.logger.info(
        `memory-hybrid: dream-cycle auto-proposed persona rule ${makeUnifiedKey("persona", created.id)}`,
      );
    }
  }

  if (isSkillWorkshopPluginActive(input.api) && input.patternsStored > 0) {
    const newPatterns = resolveNewFacts(input.factsDb, input.newPatternFactIds, "pattern").slice(
      0,
      MAX_SKILL_WORKSHOP_PROPOSALS_PER_CYCLE,
    );
    for (const { id, text } of newPatterns) {
      const slug = `dream-pattern-${id.slice(0, 8)}`;
      const bridged = writeSkillWorkshopProposal({
        name: slug,
        description: text.slice(0, 160),
        skillContent: `# ${slug}\n\n${text}\n`,
        proposalId: id,
      });
      if (bridged.ok) {
        skillWorkshopBridged++;
        input.logger.info(`memory-hybrid: bridged skill workshop proposal at ${bridged.path}`);
      }
    }
  }

  return { personaProposalsCreated, skillWorkshopBridged };
}
