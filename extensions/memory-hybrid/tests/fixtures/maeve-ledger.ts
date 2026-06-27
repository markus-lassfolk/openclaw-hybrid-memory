/**
 * Production-shaped project-ledger fixtures (Maeve multi-agent deployment).
 * Used by lifecycle guard integration tests (#1479, #1486).
 */

import type { FactsDB } from "../../backends/facts-db.js";
import { TASK_LEDGER_CATEGORY } from "../../services/task-ledger-facts.js";

export const NOW_ISO = "2026-05-10T08:31:00.000Z";
export const MAIN_TELEGRAM_SESSION = "agent:main:telegram:bc88cdda-db96-4c80-9021-44015f2ca1d9";
export const MAIN_CANONICAL_SESSION = "agent:main:main";
export const FORGE_SUBAGENT_SESSION = "agent:forge:subagent:1";

function storeProjectFact(db: FactsDB, entity: string, key: string, value: string): void {
  db.store({
    text: `Task [${entity}] ${key}: ${value}`,
    category: TASK_LEDGER_CATEGORY,
    importance: 0.7,
    entity,
    key,
    value,
    source: "active-task",
    decayClass: "permanent",
  });
}

/** Active Forge subagent task (unrelated to main Telegram session). */
export function seedForgeActiveTask(db: FactsDB, updatedIso: string = NOW_ISO): void {
  const entity = "forge-pr-42";
  storeProjectFact(db, entity, "status", "in_progress");
  storeProjectFact(db, entity, "next", "Wait for review.");
  storeProjectFact(db, entity, "task_updated", updatedIso);
  storeProjectFact(db, entity, "related_session", FORGE_SUBAGENT_SESSION);
}

/** Main-agent waiting task with configurable related_session. */
export function seedMainTelegramCheckpoint(
  db: FactsDB,
  opts: { relatedSession?: string; updatedIso?: string; entity?: string } = {},
): string {
  const entity = opts.entity ?? "issue-telegram";
  const relatedSession = opts.relatedSession ?? MAIN_CANONICAL_SESSION;
  const updatedIso = opts.updatedIso ?? NOW_ISO;
  storeProjectFact(db, entity, "status", "waiting");
  storeProjectFact(db, entity, "next", "Recheck CI.");
  storeProjectFact(db, entity, "task_updated", updatedIso);
  storeProjectFact(db, entity, "related_session", relatedSession);
  storeProjectFact(db, entity, "wake_at", "2026-05-10T08:41:00.000Z");
  return entity;
}

export function pendingCiTurnMessages(): unknown[] {
  return [
    { role: "user", content: "How is CI?" },
    { role: "assistant", content: "CI is still pending and checks are running." },
  ];
}

export function benignFinalizationMessages(): unknown[] {
  return [
    { role: "user", content: "Thanks, all done." },
    { role: "assistant", content: "Glad everything is complete." },
  ];
}
