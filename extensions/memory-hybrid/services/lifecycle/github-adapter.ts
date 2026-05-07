/**
 * GitHub lifecycle adapter — Phase 2 stub (Issue #1196).
 * Wire `syncLifecycleFromGitHub` when lifecycle.adapters.github.enabled is true.
 */

import type { FactsDB } from "../../backends/facts-db.js";

export type LifecycleSyncReport = {
  ok: false;
  reason: "not_implemented";
};

export async function syncLifecycleFromGitHub(
  _factsDb: FactsDB,
  _opts: Record<string, unknown>,
): Promise<LifecycleSyncReport> {
  throw new Error(
    "syncLifecycleFromGitHub: not implemented — enable Phase 2 GitHub lifecycle adapter (follow-up issue).",
  );
}
