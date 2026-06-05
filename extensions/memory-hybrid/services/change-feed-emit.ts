/**
 * Helpers for emitting change-feed events with config-aware filtering.
 */

import type { HybridMemoryConfig } from "../config.js";
import type { FactsDB } from "../backends/facts-db.js";
import {
  ChangeFeed,
  type ChangeEvent,
  type ChangeEventAction,
  type ChangeEventCategory,
  type ChangeEventInput,
  type ChangeEventTier,
} from "./change-feed.js";

/** Session key for system-wide events surfaced to every chat session (dream-cycle, pipelines). */
export const BROADCAST_CHANGE_SESSION_KEY = "__broadcast__";

export function isLiveChangeFeedEnabled(cfg: HybridMemoryConfig): boolean {
  return cfg.liveChangeFeed?.enabled !== false;
}

/** Lazily attach a change feed to CLI/cron paths that share the facts DB. */
export function resolveChangeFeed(
  cfg: HybridMemoryConfig,
  factsDb?: Pick<FactsDB, "getRawDb"> | null,
  existing?: ChangeFeed | null,
): ChangeFeed | null {
  if (!isLiveChangeFeedEnabled(cfg)) return null;
  if (existing) return existing;
  if (!factsDb) return null;
  try {
    return new ChangeFeed(factsDb as FactsDB);
  } catch {
    return null;
  }
}

export function shouldNotifyChangeInChat(
  cfg: HybridMemoryConfig,
  event: Pick<ChangeEvent, "tier" | "action" | "category">,
): boolean {
  const lcf = cfg.liveChangeFeed;
  if (!lcf || lcf.enabled === false || lcf.notifyInChat === false) return false;
  const notifyOn = lcf.notifyOn;
  if (event.tier === "session" && event.action === "detected") return notifyOn.sessionAdaptation;
  if (event.action === "proposed") return notifyOn.proposalCreated;
  if (event.action === "applied") return notifyOn.proposalApplied;
  if (event.action === "reverted") return notifyOn.proposalReverted;
  if (event.category === "dream-cycle" && event.action === "detected") return notifyOn.dreamCycleComplete;
  return false;
}

export function emitChangeEvent(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  input: ChangeEventInput,
): ChangeEvent | null {
  if (!changeFeed || !isLiveChangeFeedEnabled(cfg)) return null;
  return changeFeed.append(input);
}

export function emitPersonaProposed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    proposalId: string;
    title: string;
    targetFile: string;
    detail?: string;
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: "persona",
    action: "proposed",
    title: `Persona proposal: ${opts.title}`,
    detail: opts.detail ?? `Pending change for ${opts.targetFile}`,
    proposalKey: `persona:${opts.proposalId}`,
    rollbackAvailable: true,
    activation: "next-reload",
  });
}

export function emitPersonaApplied(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    proposalId: string;
    targetFile: string;
    title?: string;
    rollbackAvailable?: boolean;
  },
): ChangeEvent | null {
  const proposalKey = `persona:${opts.proposalId}`;
  supersedeActiveAppliedEvents(changeFeed, proposalKey);
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: "persona",
    action: "applied",
    title: opts.title ?? `Applied persona change → ${opts.targetFile}`,
    detail: `Proposal ${opts.proposalId} applied to ${opts.targetFile}. Revert with "revert change N".`,
    proposalKey,
    rollbackAvailable: opts.rollbackAvailable === true,
    activation: "next-reload",
  });
}

export function emitSkillApplied(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    proposalKey: string;
    title: string;
    detail?: string;
    category?: Extract<ChangeEventCategory, "skill" | "procedure-skill" | "tool">;
    rollbackAvailable?: boolean;
  },
): ChangeEvent | null {
  if (opts.proposalKey) {
    supersedeActiveAppliedEvents(changeFeed, opts.proposalKey);
  }
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: opts.category ?? "skill",
    action: "applied",
    title: opts.title,
    detail: opts.detail ?? "Skill installed and active on next turn.",
    proposalKey: opts.proposalKey,
    rollbackAvailable: opts.rollbackAvailable !== false,
    activation: "next-turn",
  });
}

export function emitFrustrationDetected(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    level: number;
    trend: string;
    adaptationAction: string;
    adaptationReasoning: string;
  },
): ChangeEvent | null {
  supersedeActiveFrustrationEvents(changeFeed, opts.sessionKey);
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "session",
    category: "frustration",
    action: "detected",
    title: `Frustration detected (${opts.level.toFixed(2)}/${opts.trend})`,
    detail: `Adaptation: ${opts.adaptationAction} — ${opts.adaptationReasoning}`,
    proposalKey: null,
    rollbackAvailable: true,
    activation: "immediate",
  });
}

export function emitChangeReverted(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    originalEvent: ChangeEvent;
    detail: string;
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: opts.originalEvent.tier,
    category: opts.originalEvent.category,
    action: "reverted",
    title: `Reverted: ${opts.originalEvent.title}`,
    detail: opts.detail,
    proposalKey: opts.originalEvent.proposalKey,
    rollbackAvailable: false,
    activation: opts.originalEvent.activation,
  });
}

export function emitPipelinePersonaProposed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  created: { id: string; title: string; targetFile: string },
  detail?: string,
): ChangeEvent | null {
  return emitPersonaProposed(changeFeed, cfg, {
    sessionKey: BROADCAST_CHANGE_SESSION_KEY,
    proposalId: created.id,
    title: created.title,
    targetFile: created.targetFile,
    detail,
  });
}

/** Mark a pending proposed change event superseded after successful apply. */
export function supersedeActiveProposedEvent(
  changeFeed: ChangeFeed | null | undefined,
  proposalKey: string,
): void {
  if (!changeFeed) return;
  const proposed = changeFeed.findActiveByProposalKey(proposalKey, "proposed");
  if (proposed) changeFeed.markSuperseded(proposed.id);
}

/** Mark prior applied events for the same proposal superseded (re-apply / duplicate emits). */
export function supersedeActiveAppliedEvents(
  changeFeed: ChangeFeed | null | undefined,
  proposalKey: string,
  exceptId?: string,
): void {
  if (!changeFeed || !proposalKey) return;
  changeFeed.markSupersededByProposalKey(proposalKey, "applied", exceptId);
}

/** Keep one active dream-cycle completion notice on the broadcast channel. */
export function supersedeActiveDreamCycleEvents(changeFeed: ChangeFeed | null | undefined): void {
  if (!changeFeed) return;
  for (const ev of changeFeed.listRecent({
    sessionKey: BROADCAST_CHANGE_SESSION_KEY,
    limit: 20,
    status: "active",
  })) {
    if (ev.category === "dream-cycle" && ev.action === "detected") {
      changeFeed.markSuperseded(ev.id);
    }
  }
}

/** Supersede prior active frustration detections for a session (one live adaptation notice). */
export function supersedeActiveFrustrationEvents(
  changeFeed: ChangeFeed | null | undefined,
  sessionKey: string,
  exceptId?: string,
): void {
  if (!changeFeed) return;
  const key = sessionKey.trim() || "default";
  for (const ev of changeFeed.listRecent({ sessionKey: key, limit: 50, status: "active" })) {
    if (
      ev.id !== exceptId &&
      ev.tier === "session" &&
      ev.category === "frustration" &&
      ev.action === "detected"
    ) {
      changeFeed.markSuperseded(ev.id);
    }
  }
}

/** Withdraw a pending proposed change when rejected outside the revert flow. */
export function syncProposalWithdrawnInChangeFeed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  proposalKey: string,
  detail: string,
): void {
  if (!changeFeed) return;
  const proposed = changeFeed.findActiveByProposalKey(proposalKey, "proposed");
  if (!proposed || proposed.status !== "active") return;
  changeFeed.markReverted(proposed.id);
  emitChangeReverted(changeFeed, cfg, {
    sessionKey: proposed.sessionKey,
    originalEvent: proposed,
    detail,
  });
}

/** Mark an applied change withdrawn when the underlying proposal is quarantined/removed. */
export function syncAppliedWithdrawnInChangeFeed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  proposalKey: string,
  detail: string,
): void {
  if (!changeFeed) return;
  const applied = changeFeed.findActiveByProposalKey(proposalKey, "applied");
  if (!applied || applied.status !== "active") return;
  changeFeed.markReverted(applied.id);
  emitChangeReverted(changeFeed, cfg, {
    sessionKey: applied.sessionKey,
    originalEvent: applied,
    detail,
  });
}

export function emitDreamCycleComplete(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    success: boolean;
    digestSummary: string;
    personaProposalsCreated?: number;
    crystallizationProposalsCreated?: number;
    skillWorkshopBridged?: number;
  },
): ChangeEvent | null {
  const detailParts = [opts.digestSummary];
  if (opts.personaProposalsCreated != null && opts.personaProposalsCreated > 0) {
    detailParts.push(`${opts.personaProposalsCreated} persona proposal(s) auto-created`);
  }
  if (opts.crystallizationProposalsCreated != null && opts.crystallizationProposalsCreated > 0) {
    detailParts.push(`${opts.crystallizationProposalsCreated} crystallization proposal(s) auto-created`);
  }
  if (opts.skillWorkshopBridged != null && opts.skillWorkshopBridged > 0) {
    detailParts.push(`${opts.skillWorkshopBridged} skill workshop proposal(s) bridged`);
  }
  supersedeActiveDreamCycleEvents(changeFeed);
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: BROADCAST_CHANGE_SESSION_KEY,
    timestamp: Date.now(),
    tier: "persistent",
    category: "dream-cycle",
    action: "detected",
    title: opts.success ? "Dream cycle complete" : "Dream cycle finished with errors",
    detail: detailParts.join(". "),
    proposalKey: null,
    rollbackAvailable: false,
    activation: "next-turn",
  });
}

export type ChangeFeedEmitOpts = {
  changeFeed?: ChangeFeed | null;
  cfg: HybridMemoryConfig;
  sessionKey?: string;
};

export function emitCrystallizationProposed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    proposalId: string;
    skillName: string;
    detail?: string;
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: "skill",
    action: "proposed",
    title: `Skill proposal: ${opts.skillName}`,
    detail: opts.detail ?? "Pending crystallization approval",
    proposalKey: `crystallization:${opts.proposalId}`,
    rollbackAvailable: true,
    activation: "next-turn",
  });
}

export function emitToolProposed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    proposalId: string;
    toolName: string;
    detail?: string;
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: "tool",
    action: "proposed",
    title: `Tool proposal: ${opts.toolName}`,
    detail: opts.detail ?? "Pending tool extension approval",
    proposalKey: `tool:${opts.proposalId}`,
    rollbackAvailable: true,
    activation: "next-turn",
  });
}

export function emitSkillWorkshopProposed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    proposalId: string;
    skillName: string;
    detail?: string;
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: BROADCAST_CHANGE_SESSION_KEY,
    timestamp: Date.now(),
    tier: "persistent",
    category: "skill",
    action: "proposed",
    title: `Skill workshop proposal: ${opts.skillName}`,
    detail: opts.detail ?? "Bridged to skill-workshop for review",
    proposalKey: `skill-workshop:${opts.proposalId}`,
    rollbackAvailable: true,
    activation: "next-turn",
  });
}

export function emitProcedureSkillProposed(
  changeFeed: ChangeFeed | null | undefined,
  cfg: HybridMemoryConfig,
  opts: {
    sessionKey: string;
    procedureId: string;
    title: string;
    detail?: string;
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: "procedure-skill",
    action: "proposed",
    title: `Procedure skill ready: ${opts.title}`,
    detail: opts.detail ?? "Validated procedure ready for skill promotion",
    proposalKey: `procedure-skill:${opts.procedureId}`,
    rollbackAvailable: true,
    activation: "next-turn",
  });
}

export type ChangeNotifyFilter = {
  tier: ChangeEventTier;
  action: ChangeEventAction;
  category: ChangeEventCategory;
};
