/**
 * Load active tasks for agent tools (list/get/propose_goal) — mirrors injection sources.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ScopeFilter } from "../types/memory.js";
import { detectStaleTasks, readActiveTaskFile, type ActiveTaskEntry } from "./active-task.js";
import { loadTaskLedgerFromFacts } from "./task-ledger-facts.js";
import { parseDuration } from "../utils/duration.js";

export type LoadedActiveTasks = {
  tasks: ActiveTaskEntry[];
  path: string;
  source: "facts" | "markdown";
};

export async function loadActiveTasksForTools(
  cfg: HybridMemoryConfig,
  resolvedActiveTaskPath: string,
  factsDb: FactsDB | null,
  scopeFilter?: ScopeFilter | null,
): Promise<LoadedActiveTasks | null> {
  if (!cfg.activeTask.enabled) return null;
  const staleMinutes = parseDuration(cfg.activeTask.staleThreshold);

  if (cfg.activeTask.ledger === "facts") {
    if (!factsDb) return null;
    // SECURITY: loadTaskLedgerFromFacts accepts an optional scopeFilter but silently returns
    // every tenant's task facts when it's omitted — must be threaded through explicitly.
    const { active } = loadTaskLedgerFromFacts(factsDb, undefined, scopeFilter);
    return {
      tasks: detectStaleTasks(active, staleMinutes),
      path: resolvedActiveTaskPath,
      source: "facts",
    };
  }

  const file = await readActiveTaskFile(resolvedActiveTaskPath, staleMinutes);
  if (!file) {
    return { tasks: [], path: resolvedActiveTaskPath, source: "markdown" };
  }
  return { tasks: file.active, path: resolvedActiveTaskPath, source: "markdown" };
}

export function findActiveTaskByLabel(tasks: ActiveTaskEntry[], label: string): ActiveTaskEntry | undefined {
  const want = label.trim();
  if (!want) return undefined;
  return tasks.find((t) => t.label === want) ?? tasks.find((t) => t.label.toLowerCase() === want.toLowerCase());
}
