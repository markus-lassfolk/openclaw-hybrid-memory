/**
 * Shared workshop feature flags and limits.
 */

import type { HybridMemoryConfig } from "../config.js";

export const DEFAULT_WORKSHOP_MAX_PENDING = 50;

export const MISSION_CONTROL_SESSION_KEY = "mission-control";

export function isWorkshopEnabled(cfg?: HybridMemoryConfig): boolean {
  if (!cfg) return false;
  const explicit = cfg.workshop?.enabled;
  if (explicit === false) return false;
  if (explicit === true) return true;
  return (
    cfg.personaProposals?.enabled === true ||
    cfg.crystallization?.enabled === true ||
    cfg.selfExtension?.enabled === true ||
    cfg.procedures?.enabled !== false
  );
}

export function resolveWorkshopMaxPending(cfg?: HybridMemoryConfig): number {
  const fromWorkshop = cfg?.workshop?.maxPending;
  if (typeof fromWorkshop === "number" && fromWorkshop >= 0) return Math.floor(fromWorkshop);
  const configured = cfg?.personaProposals?.workshopMaxPending;
  if (typeof configured === "number" && configured >= 0) return Math.floor(configured);
  return DEFAULT_WORKSHOP_MAX_PENDING;
}

export function resolveWorkshopSessionKey(cfg?: HybridMemoryConfig): string {
  const configured = cfg?.workshop?.sessionKey?.trim();
  return configured || MISSION_CONTROL_SESSION_KEY;
}
