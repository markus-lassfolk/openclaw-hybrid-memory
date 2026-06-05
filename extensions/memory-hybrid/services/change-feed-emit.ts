/**
 * Helpers for emitting change-feed events with config-aware filtering.
 */

import type { HybridMemoryConfig } from "../config.js";
import {
  type ChangeEvent,
  type ChangeEventAction,
  type ChangeEventCategory,
  type ChangeEventInput,
  type ChangeEventTier,
  type ChangeFeed,
} from "./change-feed.js";

export function isLiveChangeFeedEnabled(cfg: HybridMemoryConfig): boolean {
  return cfg.liveChangeFeed?.enabled !== false;
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
  return true;
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
    rollbackAvailable: false,
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
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: "persona",
    action: "applied",
    title: opts.title ?? `Applied persona change → ${opts.targetFile}`,
    detail: `Proposal ${opts.proposalId} applied to ${opts.targetFile}. Revert with "revert change N".`,
    proposalKey: `persona:${opts.proposalId}`,
    rollbackAvailable: true,
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
  },
): ChangeEvent | null {
  return emitChangeEvent(changeFeed, cfg, {
    sessionKey: opts.sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: opts.category ?? "skill",
    action: "applied",
    title: opts.title,
    detail: opts.detail ?? "Skill installed and active on next turn.",
    proposalKey: opts.proposalKey,
    rollbackAvailable: false,
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

export type ChangeNotifyFilter = {
  tier: ChangeEventTier;
  action: ChangeEventAction;
  category: ChangeEventCategory;
};
