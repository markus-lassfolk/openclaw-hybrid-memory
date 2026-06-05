/**
 * Revert a numbered change event from the live change feed.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { HybridMemoryConfig } from "../config.js";
import type { ChangeEvent, ChangeFeed } from "./change-feed.js";
import { emitChangeReverted } from "./change-feed-emit.js";
import {
  type WorkshopServiceContext,
  workshopQuarantine,
  workshopReject,
  workshopUndo,
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
};

function activationNote(event: ChangeEvent): string {
  switch (event.category) {
    case "frustration":
      return "Takes effect on the next agent turn.";
    case "persona":
      return "File restored from rollback; active after next session reload.";
    case "skill":
    case "procedure-skill":
      return "Skill quarantined; active on next turn after skill reload.";
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
    ctx.changeFeed.markReverted(event.id);
    const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
      sessionKey: ctx.sessionKey,
      originalEvent: event,
      detail: "Frustration level reset for this session.",
    });
    return {
      ok: true,
      message: `Reverted change #${event.ordinal}: frustration adaptation cleared. ${activationNote(event)}`,
      event,
      revertedEvent,
    };
  }

  if (event.action === "proposed" && event.proposalKey) {
    if (event.proposalKey.startsWith("persona:")) {
      const result = workshopReject(ctx.workshopCtx, event.proposalKey, "reverted via change feed");
      if (!result.ok) return { ok: false, error: result.error };
      ctx.changeFeed.markReverted(event.id);
      const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: ctx.sessionKey,
        originalEvent: event,
        detail: "Pending persona proposal rejected.",
      });
      return {
        ok: true,
        message: `Reverted change #${event.ordinal}: proposal withdrawn. ${activationNote(event)}`,
        event,
        revertedEvent,
      };
    }
  }

  if (event.action === "applied" && event.proposalKey) {
    if (event.proposalKey.startsWith("persona:")) {
      if (!event.rollbackAvailable) {
        return { ok: false, error: `Change #${event.ordinal} has no rollback metadata` };
      }
      const result = workshopUndo(ctx.workshopCtx, event.proposalKey);
      if (!result.ok) return { ok: false, error: result.error };
      ctx.changeFeed.markReverted(event.id);
      const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: ctx.sessionKey,
        originalEvent: event,
        detail: result.message,
      });
      return {
        ok: true,
        message: `Reverted change #${event.ordinal}: ${result.message} ${activationNote(event)}`,
        event,
        revertedEvent,
      };
    }

    if (event.proposalKey.startsWith("crystallization:")) {
      const result = workshopQuarantine(ctx.workshopCtx, event.proposalKey, "reverted via change feed");
      if (!result.ok) return { ok: false, error: result.error };
      ctx.changeFeed.markReverted(event.id);
      const revertedEvent = emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: ctx.sessionKey,
        originalEvent: event,
        detail: "Crystallization skill quarantined.",
      });
      return {
        ok: true,
        message: `Reverted change #${event.ordinal}: skill quarantined. ${activationNote(event)}`,
        event,
        revertedEvent,
      };
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
  const event = ctx.changeFeed.getByOrdinal(key, ordinal);
  if (!event) return { ok: false, error: `Change #${ordinal} not found for session ${key}` };
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
  return base as WorkshopServiceContext;
}
