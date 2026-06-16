/**
 * Persist per-turn injection attribution (Issue #1916).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TurnAttribution } from "./per-turn-attribution.js";

export function recordInjectionAttribution(
  db: DatabaseSync,
  input: {
    sessionKey?: string | null;
    agentId?: string | null;
    attribution: TurnAttribution;
  },
): void {
  const { attribution, sessionKey, agentId } = input;
  if (attribution.injectedFactIds.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO injection_attribution
     (id, occurred_at, session_key, agent_id, turn_index, injected_fact_ids, referenced_fact_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    now,
    sessionKey ?? null,
    agentId ?? null,
    attribution.turnIndex,
    JSON.stringify(attribution.injectedFactIds),
    JSON.stringify(attribution.referencedFactIds),
  );
}
