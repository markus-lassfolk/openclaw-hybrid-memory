/**
 * Dream steering policy (#2176) — set-and-forget config passed into Dream compose + gates.
 */

import type { DreamSteeringConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";

export const STEERING_PROFILES: Record<
  DreamSteeringConfig["profile"],
  Pick<DreamSteeringConfig, "promote" | "ignore" | "notes">
> = {
  personal: {
    promote: ["preference", "routine", "insight"],
    ignore: ["one_off_debug", "transient_path", "secret_like"],
    notes: "Focus on durable user preferences and recurring routines; ignore one-off debugging.",
  },
  coding: {
    promote: ["procedure", "tool_failure", "coding_task", "rule"],
    ignore: ["one_off_debug", "transient_path", "ops_status"],
    notes: "Prioritize coding style, tool failures, and repeatable procedures.",
  },
  ops: {
    promote: ["monitoring", "ops_status", "procedure", "tool_failure"],
    ignore: ["one_off_debug", "personal", "preference"],
    notes: "Prioritize operational reliability, monitoring, and incident patterns.",
  },
  custom: {
    promote: [],
    ignore: [],
    notes: undefined,
  },
};

/** Merge profile defaults with operator overrides. */
export function resolveSteering(cfg?: DreamSteeringConfig): DreamSteeringConfig {
  const base = cfg ?? DEFAULT_DREAMING_CONFIG.steering;
  const preset = STEERING_PROFILES[base.profile] ?? STEERING_PROFILES.personal;
  return {
    profile: base.profile,
    promote: base.promote.length > 0 ? base.promote : preset.promote,
    ignore: base.ignore.length > 0 ? base.ignore : preset.ignore,
    notes: base.notes ?? preset.notes,
  };
}

/** LLM/system suffix for maintenance steps that accept freeform steering (#2176). */
export function formatSteeringPromptBlock(steering: DreamSteeringConfig): string {
  const resolved = resolveSteering(steering);
  const lines = [
    "Dream steering policy:",
    `- Promote signal: ${resolved.promote.join(", ") || "(default)"}`,
    `- Ignore noise: ${resolved.ignore.join(", ") || "(none)"}`,
  ];
  if (resolved.notes?.trim()) lines.push(`- Notes: ${resolved.notes.trim()}`);
  return lines.join("\n");
}

export function categoryMatchesSteeringList(category: string, list: string[]): boolean {
  const cat = category.toLowerCase();
  return list.some((token) => {
    const t = token.toLowerCase().trim();
    return t.length > 0 && (cat === t || cat.includes(t));
  });
}

export function shouldSteeringIgnore(
  category: string,
  key: string | null,
  text: string,
  steering: DreamSteeringConfig,
): boolean {
  const resolved = resolveSteering(steering);
  const hay = `${category} ${key ?? ""} ${text}`.toLowerCase();
  return resolved.ignore.some((token) => {
    const t = token.toLowerCase().trim();
    return t.length > 0 && hay.includes(t);
  });
}

export function steeringPromoteBoost(category: string, steering: DreamSteeringConfig): boolean {
  const resolved = resolveSteering(steering);
  return categoryMatchesSteeringList(category, resolved.promote);
}
