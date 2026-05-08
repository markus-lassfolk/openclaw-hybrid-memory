/**
 * CLI registration for `manage digest` command (Issue #1197).
 *
 * Surfaces pending backlogs across persona proposals, procedure promotions,
 * tool proposals, crystallization proposals, and verified facts.
 */

import {
  buildPendingReviewDigestReport,
  writePendingReviewDigestOutput,
} from "../../../services/pending-review-digest.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageDigest(mem: Chainable, b: ManageBindings): void {
  const digest = mem
    .command("digest")
    .description("Surface pending review backlogs across proposals/procedures/tools/crystallization stores.");

  digest
    .command("pending")
    .description(
      "Show pending backlogs: persona proposals, procedure promotions, tool proposals, crystallization, verified facts.",
    )
    .option("--since <duration>", "Lookback window, e.g. 7d, 24h, 2w (default: 7d)")
    .option("--format <fmt>", "Output format: md or json (default: md)")
    .option("--out <path>", "Output file path, or '-' for stdout (default: -)")
    .action(
      withExit(async (opts?: { since?: string; format?: string; out?: string }) => {
        const rawFormat = String(opts?.format ?? "md").toLowerCase();
        const format = rawFormat === "json" ? "json" : "md";
        const outPath = opts?.out ?? "-";
        const report = buildPendingReviewDigestReport({ cfg: b.cfg, factsDb: b.factsDb, since: opts?.since });
        writePendingReviewDigestOutput({ report, format, outPath });
      }),
    );
}
