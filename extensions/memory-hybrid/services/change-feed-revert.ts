/**
 * Revert a numbered change event from the live change feed.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { HybridMemoryConfig } from "../config.js";
import type { SessionState } from "../lifecycle/types.js";
import type { ChangeEvent, ChangeFeed } from "./change-feed.js";
import { BROADCAST_CHANGE_SESSION_KEY, emitChangeReverted, supersedeActiveFrustrationEvents } from "./change-feed-emit.js";
import { removeSkillWorkshopProposal } from "./skill-workshop-bridge.js";
import { parseUnifiedKey } from "./unified-proposals.js";
import {
  type WorkshopServiceContext,
  withWorkshopDefaults,
  workshopQuarantine,
  workshopReject,
  workshopRevertProcedureSkill,
  workshopUndo,
  workshopWithdrawTool,
} from "./workshop-service.js";

export type ChangeRevertResult =
  | { ok: true; message: string; event: ChangeEvent; revertedEvent: ChangeEvent | null }
  | { ok: false; error: string };

export type ChangeRevertContext = {
  changeFeed: ChangeFeed;
  cfg: HybridMemoryConfig;
  workshopCtx: WorkshopServiceContext;
  sessionKey: string;
  /** Reset session frustration level (Tier 1 revert). */
  resetFrustration?: () => void;
  /** In-chat display #N → event id map for the current chat session. */
  displayRevertMap?: Map<number, string> | null;
};

export function resolveChangeEventForRevert(
  changeFeed: ChangeFeed,
  ordinal: number,
  sessionKey: string,
  displayRevertMap?: Map<number, string> | null,
): ChangeEvent | null {
  if (displayRevertMap?.has(ordinal)) {
    const displayEventId = displayRevertMap.get(ordinal)!;
    const byDisplay = changeFeed.getById(displayEventId);
    if (byDisplay?.status === "active") return byDisplay;
    return null;
  }

  const key = sessionKey.trim() || "default";
  const inSession = changeFeed.getByOrdinal(key, ordinal);
  if (inSession?.status === "active") return inSession;

  if (key !== BROADCAST_CHANGE_SESSION_KEY) {
    const broadcast = changeFeed.getByOrdinal(BROADCAST_CHANGE_SESSION_KEY, ordinal);
    if (broadcast?.status === "active") return broadcast;
  }

  return null;
}

export function lookupDisplayRevertMap(
  sessionState: SessionState | null | undefined,
  sessionKey: string,
): Map<number, string> | null {
  return sessionState?.displayRevertMap.get(sessionKey) ?? null;
}

export function createFrustrationResetCallback(
  sessionState: SessionState | null | undefined,
  sessionKey: string,
): (() => void) | undefined {
  if (!sessionState) return undefined;
  return () => {
    sessionState.frustrationStateMap.set(sessionKey, { level: 0, turns: [] });
    sessionState.frustrationThresholdBandMap.set(sessionKey, "none");
  };
}

export function buildChangeRevertContext(opts: {
  changeFeed: ChangeFeed;
  cfg: HybridMemoryConfig;
  workshopCtx: WorkshopServiceContext;
  sessionKey: string;
  sessionState?: SessionState | null;
}): ChangeRevertContext {
  return {
    changeFeed: opts.changeFeed,
    cfg: opts.cfg,
    workshopCtx: opts.workshopCtx,
    sessionKey: opts.sessionKey,
    resetFrustration: createFrustrationResetCallback(opts.sessionState, opts.sessionKey),
    displayRevertMap: lookupDisplayRevertMap(opts.sessionState, opts.sessionKey),
  };
}

function pruneDisplayRevertMap(
  displayRevertMap: Map<number, string> | null | undefined,
  eventId: string,
): void {
  if (!displayRevertMap) return;
  for (const [slot, id] of displayRevertMap.entries()) {
    if (id === eventId) displayRevertMap.delete(slot);
  }
}

function finishRevert(
  ctx: ChangeRevertContext,
  event: ChangeEvent,
  message: string,
  revertedEvent: ChangeEvent | null,
): ChangeRevertResult {
  pruneDisplayRevertMap(ctx.displayRevertMap, event.id);
  return { ok: true, message, event, revertedEvent };
}

function activationNote(event: ChangeEvent): string {
  switch (event.category) {
    case "frustration":
      return "Takes effect on the next agent turn.";
    case "persona":
      return "File restored from rollback; active after next session reload.";
    case "skill":
      return "Skill quarantined; active on next turn after skill reload.";
    case "procedure-skill":
      return "Procedure skill uninstalled; active after next skill reload.";
    case "tool":
      return "Tool proposal withdrawn; active on next turn.";
    default:
      return event.activation === "immediate"
        ? "Takes effect immediately."
        : event.activation === "next-turn"
          ? "Takes effect on the next agent turn."
          : "Takes effect after next session reload.";
  }
}

export function revertChangeEvent(ctx: ChangeRevertContext, event: ChangeEvent): ChangeRevertResult {
  if (event.status !== "active") {
    return { ok: false, error: `Change #${event.ordinal} is already ${event.status}` };
  }

  if (event.tier === "session" && event.category === "frustration") {
    ctx.resetFrustration?.();
    supersedeActiveFrustrationEvents(ctx.changeFeed, event.sessionKey, event.id);
    ctx.changeFeed.markReverted(event.id);
    const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
      sessionKey: event.sessionKey,
      originalEvent: event,
      detail: "Frustration level reset for this session.",
    });
    return finishRevert(
      ctx,
      event,
      `Reverted change #${event.ordinal}: frustration adaptation cleared. ${activationNote(event)}`,
      revertedEvent,
    );
  }

  if (event.action === "proposed" && event.proposalKey) {
    if (event.proposalKey.startsWith("skill-workshop:")) {
      const proposalId = event.proposalKey.slice("skill-workshop:".length);
      const removed = removeSkillWorkshopProposal(proposalId);
      const detail = removed.ok
        ? "Skill workshop proposal withdrawn and removed from filesystem."
        : `Skill workshop proposal withdrawn (filesystem cleanup: ${removed.error}).`;
      ctx.changeFeed.markReverted(event.id);
      const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: event.sessionKey,
        originalEvent: event,
        detail,
      });
      return finishRevert(
        ctx,
        event,
        `Reverted change #${event.ordinal}: ${detail} ${activationNote(event)}`,
        revertedEvent,
      );
    }

    const result = workshopReject(ctx.workshopCtx, event.proposalKey, "reverted via change feed", {
      skipChangeFeed: true,
    });
    if (!result.ok) return { ok: false, error: result.error };
    ctx.changeFeed.markReverted(event.id);
    const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
      sessionKey: event.sessionKey,
      originalEvent: event,
      detail: "Pending proposal withdrawn.",
    });
    return finishRevert(
      ctx,
      event,
      `Reverted change #${event.ordinal}: proposal withdrawn. ${activationNote(event)}`,
      revertedEvent,
    );
  }

  if (event.action === "applied" && event.proposalKey) {
    if (event.proposalKey.startsWith("persona:")) {
      if (!event.rollbackAvailable) {
        return { ok: false, error: `Change #${event.ordinal} has no rollback metadata` };
      }
      const result = workshopUndo(ctx.workshopCtx, event.proposalKey, { changeEventId: event.id });
      if (!result.ok) return { ok: false, error: result.error };
      return finishRevert(
        ctx,
        event,
        `Reverted change #${event.ordinal}: ${result.message} ${activationNote(event)}`,
        null,
      );
    }

    if (event.proposalKey.startsWith("crystallization:")) {
      const result = workshopQuarantine(ctx.workshopCtx, event.proposalKey, "reverted via change feed", {
        skipChangeFeed: true,
      });
      if (!result.ok) return { ok: false, error: result.error };
      ctx.changeFeed.markReverted(event.id);
      const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: event.sessionKey,
        originalEvent: event,
        detail: "Crystallization skill quarantined.",
      });
      return finishRevert(
        ctx,
        event,
        `Reverted change #${event.ordinal}: skill quarantined. ${activationNote(event)}`,
        revertedEvent,
      );
    }

    if (event.proposalKey.startsWith("procedure-skill:")) {
      const parsed = parseUnifiedKey(event.proposalKey);
      if (!parsed || parsed.type !== "procedure-skill") {
        return { ok: false, error: `Invalid procedure-skill key: ${event.proposalKey}` };
      }
      const result = workshopRevertProcedureSkill(ctx.workshopCtx, parsed.storeId, "reverted via change feed", {
        skipChangeFeed: true,
      });
      if (!result.ok) return { ok: false, error: result.error };
      ctx.changeFeed.markReverted(event.id);
      const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: event.sessionKey,
        originalEvent: event,
        detail: result.message,
      });
      return finishRevert(
        ctx,
        event,
        `Reverted change #${event.ordinal}: ${result.message} ${activationNote(event)}`,
        revertedEvent,
      );
    }

    if (event.proposalKey.startsWith("tool:")) {
      const result = workshopWithdrawTool(ctx.workshopCtx, event.proposalKey, "reverted via change feed", {
        skipChangeFeed: true,
      });
      if (!result.ok) return { ok: false, error: result.error };
      ctx.changeFeed.markReverted(event.id);
      const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: event.sessionKey,
        originalEvent: event,
        detail: result.message,
      });
      return finishRevert(
        ctx,
        event,
        `Reverted change #${event.ordinal}: ${result.message} ${activationNote(event)}`,
        revertedEvent,
      );
    }
  }

  if (!event.rollbackAvailable) {
    return { ok: false, error: `Change #${event.ordinal} is not revertible` };
  }

  return { ok: false, error: `Revert not supported for change #${event.ordinal} (${event.category}/${event.action})` };
}

export function revertChangeByOrdinal(
  ctx: ChangeRevertContext,
  ordinal: number,
  sessionKey?: string,
): ChangeRevertResult {
  const key = (sessionKey ?? ctx.sessionKey).trim() || "default";
  const event = resolveChangeEventForRevert(ctx.changeFeed, ordinal, key, ctx.displayRevertMap);
  if (!event) {
    const displayEventId = ctx.displayRevertMap?.get(ordinal);
    if (displayEventId) {
      const known = ctx.changeFeed.getById(displayEventId);
      if (known && known.status !== "active") {
        return { ok: false, error: `Change #${ordinal} is already ${known.status}` };
      }
    }
    return { ok: false, error: `Change #${ordinal} not found for session ${key}` };
  }
  return revertChangeEvent(ctx, event);
}

export function revertChangeById(ctx: ChangeRevertContext, id: string): ChangeRevertResult {
  const event = ctx.changeFeed.getById(id);
  if (!event) return { ok: false, error: `Change event ${id} not found` };
  return revertChangeEvent(ctx, event);
}

export function buildWorkshopCtxForRevert(
  base: Omit<WorkshopServiceContext, "api"> & { api?: ClawdbotPluginApi },
): WorkshopServiceContext {
  return withWorkshopDefaults(base);
}
