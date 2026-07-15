/**
 * `maintenance graph-link-enrichment` — bounded, safe graph-link backfill for orphan facts (#2127).
 */

import { enrichOrphanFactLinksBySharedSourceEvent } from "../../../services/graph-link-enrichment.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerGraphLinkEnrichmentCommand(mem: Chainable, b: ManageBindings): void {
  const { factsDb } = b;

  mem
    .command("graph-link-enrichment")
    .description(
      "Backfill explicit graph links for orphan facts that share a recorded source event " +
        "(facts.provenance_json.sourceEventIds). Dry-run by default; never overwrites or removes " +
        "an existing link of any type.",
    )
    .option("--limit <n>", "Maximum orphan facts to scan per run", "500")
    .option("--apply", "Actually create links; default is dry-run (report only)")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { limit?: string; apply?: boolean; json?: boolean }) => {
        const limit = Number.parseInt(opts?.limit ?? "500", 10);
        if (!Number.isFinite(limit) || limit < 1) {
          console.error("error: --limit must be a positive integer");
          process.exitCode = 1;
          return;
        }
        const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, {
          limit,
          dryRun: !opts?.apply,
        });

        if (opts?.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const mode = result.dryRun ? "dry-run" : "apply";
        console.log(
          `graph-link-enrichment (${mode}): scanned ${result.factsScanned} orphan fact(s), ` +
            `${result.sourceEventGroups} shared-source-event group(s), ` +
            `${result.dryRun ? "would create" : "created"} ${result.linksCreated} link(s)`,
        );
        if (result.dryRun && result.linksCreated > 0) {
          console.log("Re-run with --apply to create these links.");
        }
      }),
    );
}
