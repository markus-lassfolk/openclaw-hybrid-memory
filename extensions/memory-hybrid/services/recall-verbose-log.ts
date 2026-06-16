/**
 * Structured verbose logging for recall pipeline (Issues #1910, #1918).
 * Enabled via OPENCLAW_HM_VERBOSE=1|debug|trace
 */

import { nowIso } from "../utils/dates.js";

export type RecallVerboseEvent = {
  evt: string;
  feature: string;
  stage?: string;
  session_id?: string;
  recall_id?: string;
  latency_ms?: number;
  decision?: string;
  intent?: string;
  confidence?: number;
  intent_source?: string;
  bypassed?: boolean;
  candidates_in?: number;
  candidates_out?: number;
  mmr_demoted?: number;
  top3_changed_vs_v1?: boolean;
  [key: string]: string | number | boolean | undefined;
};

let verboseLevel: "off" | "basic" | "debug" | "trace" = "off";

/** Initialize from OPENCLAW_HM_VERBOSE env (call once at plugin startup). */
export function initHmVerboseFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const raw = (env.OPENCLAW_HM_VERBOSE ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "basic") verboseLevel = "basic";
  else if (raw === "debug") verboseLevel = "debug";
  else if (raw === "trace") verboseLevel = "trace";
  else verboseLevel = "off";
}

export function isHmVerbose(): boolean {
  return verboseLevel !== "off";
}

export function getHmVerboseLevel(): typeof verboseLevel {
  return verboseLevel;
}

export function emitRecallVerboseLog(
  event: RecallVerboseEvent,
  logger?: { debug?: (msg: string) => void },
): void {
  if (verboseLevel === "off") return;
  const payload = { ts: nowIso(), ...event };
  const line = JSON.stringify(payload);
  logger?.debug?.(`memory-hybrid: ${line}`);
}
