/**
 * CLI registration for `manage digest` command (Issue #1197).
 *
 * Surfaces pending backlogs across persona proposals, procedure promotions,
 * tool proposals, crystallization proposals, and verified facts.
 */

import {
  type PendingDigestAutopilotMaxima,
  type PendingDigestAutopilotPolicies,
  runPendingDigestAutopilot,
  stablePendingDigestAutopilotJson,
} from "../../../services/pending-digest-autopilot.js";
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

  digest
    .command("autopilot")
    .description(
      "Read-only parent pending-digest autopilot (#1326). Uses #1334 foundation and delegates to queue adapters; apply records decisions only.",
    )
    .option("--dry-run", "Preview only; default and non-mutating")
    .option("--apply", "Record allowed parent classify decisions through #1334 state; no queue mutations in Phase 1")
    .option("--json", "Emit stable structured JSON instead of the concise human summary")
    .option("--state-db <path>", "Optional pending-autopilot state DB for apply-mode decision records")
    .option("--persona-policy <policy>", "disabled|report-only|cautious|apply-safe")
    .option("--procedure-policy <policy>", "disabled|report-only|dry-run-skills|auto-safe")
    .option("--verified-policy <policy>", "disabled|report-only|classify|apply-obvious")
    .option("--tool-policy <policy>", "disabled|report-only|classify")
    .option("--crystallization-policy <policy>", "disabled|report-only|classify")
    .option("--max-persona <n>", "Maximum persona proposals to inspect (default: 20)")
    .option("--max-procedures <n>", "Maximum procedures to inspect (default: 50)")
    .option("--max-verified <n>", "Maximum verified review placeholders to inspect (default: 100)")
    .option("--max-tools <n>", "Maximum tool proposals to inspect (default: 50)")
    .option("--max-crystallization <n>", "Maximum crystallization proposals to inspect (default: 50)")
    .action(
      withExit(async (opts?: DigestAutopilotCliOptions) => {
        const mode = opts?.apply ? "apply" : "dry-run";
        const policies: Partial<PendingDigestAutopilotPolicies> = {
          persona: opts?.personaPolicy as PendingDigestAutopilotPolicies["persona"] | undefined,
          procedures: opts?.procedurePolicy as PendingDigestAutopilotPolicies["procedures"] | undefined,
          verified: opts?.verifiedPolicy as PendingDigestAutopilotPolicies["verified"] | undefined,
          tools: opts?.toolPolicy as PendingDigestAutopilotPolicies["tools"] | undefined,
          crystallization: opts?.crystallizationPolicy as PendingDigestAutopilotPolicies["crystallization"] | undefined,
        };
        const max: Partial<PendingDigestAutopilotMaxima> = {
          persona: parseOptionalInt(opts?.maxPersona),
          procedures: parseOptionalInt(opts?.maxProcedures),
          verified: parseOptionalInt(opts?.maxVerified),
          tools: parseOptionalInt(opts?.maxTools),
          crystallization: parseOptionalInt(opts?.maxCrystallization),
        };
        const result = await runPendingDigestAutopilot({
          cfg: b.cfg,
          factsDb: b.factsDb,
          mode,
          policies,
          max,
          stateDbPath: opts?.stateDb,
        });
        process.stdout.write(opts?.json ? stablePendingDigestAutopilotJson(result) : `${result.humanSummary}\n`);
      }),
    );
}

type DigestAutopilotCliOptions = {
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
  stateDb?: string;
  personaPolicy?: string;
  procedurePolicy?: string;
  verifiedPolicy?: string;
  toolPolicy?: string;
  crystallizationPolicy?: string;
  maxPersona?: string;
  maxProcedures?: string;
  maxVerified?: string;
  maxTools?: string;
  maxCrystallization?: string;
};

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric option: ${value}`);
  return parsed;
}
