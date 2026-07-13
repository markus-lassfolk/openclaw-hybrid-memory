/**
 * CLI registration for `smoke e2e` (issue #2088).
 *
 * A first-class end-to-end pipeline smoke test: store → embed → recall → link → episode →
 * forget → verify, using disposable uniquely-tagged facts and mandatory best-effort cleanup.
 * Safe to run against a production local memory store.
 */

import { runSmokeE2E, type SmokeE2EResult } from "../../../services/smoke-e2e.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

function printLeftoverHints(result: SmokeE2EResult): void {
  const { leftover } = result;
  if (leftover.factIds.length === 0 && leftover.episodeIds.length === 0 && leftover.linkIds.length === 0) return;
  console.log("");
  console.log("Cleanup did not fully complete. Manual remediation:");
  for (const id of leftover.linkIds) console.log(`  openclaw hybrid-mem link delete ${id}`);
  for (const id of leftover.factIds) console.log(`  openclaw hybrid-mem forget ${id} --yes`);
  for (const id of leftover.episodeIds) {
    console.log(`  episode ${id} — no CLI delete yet; remove manually: DELETE FROM episodes WHERE id = '${id}';`);
  }
}

export function registerManageSmoke(mem: Chainable, b: ManageBindings): void {
  const { factsDb, vectorDb, embeddings, cfg } = b;

  const smoke = mem.command("smoke").description("Built-in end-to-end pipeline smoke tests (#2088).");

  smoke
    .command("e2e")
    .description(
      "Store/embed/recall/link/auto-link/episode/forget pipeline check with disposable test facts (decayClass=ephemeral, unique run id). Cleanup runs by default; pass --no-cleanup to leave artifacts in place for inspection.",
    )
    .option("--json", "Output as JSON")
    .option("--no-cleanup", "Leave disposable test artifacts in place instead of best-effort cleanup")
    .action(
      withExit(async (opts?: { json?: boolean; cleanup?: boolean }) => {
        const result = await runSmokeE2E({
          factsDb,
          vectorDb,
          embeddings,
          graphConfig: cfg.graph,
          cleanup: opts?.cleanup !== false,
        });

        if (opts?.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`=== Smoke E2E (run ${result.runId}) ===`);
          for (const step of result.steps) {
            const icon = step.status === "pass" ? "✅" : step.status === "skip" ? "⏭️ " : "❌";
            console.log(`${icon} ${step.name} (${step.durationMs}ms): ${step.detail}`);
          }
          console.log(`Overall: ${result.overall === "pass" ? "✅ pass" : "❌ fail"} in ${result.durationMs}ms`);
          printLeftoverHints(result);
        }

        if (result.overall === "fail") process.exitCode = 1;
      }),
    );
}
