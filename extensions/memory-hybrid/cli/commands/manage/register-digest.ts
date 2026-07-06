/**
 * CLI registration for `manage digest` command (Issue #1197).
 *
 * Surfaces pending backlogs across persona proposals, procedure promotions,
 * tool proposals, crystallization proposals, and verified facts.
 */

import { runPendingDigestAutopilotCron } from "../../../services/pending-digest-autopilot-cron.js";
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
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
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
        const report = buildPendingReviewDigestReport({
          cfg: b.cfg,
          factsDb: b.factsDb,
          since: opts?.since,
        });
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
    .option("--workspace <path>", "Workspace containing allowed persona target files")
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
        if (opts?.apply && opts?.dryRun) {
          throw new Error("--dry-run and --apply are mutually exclusive for digest autopilot");
        }
        if (opts?.apply && !opts?.stateDb) {
          throw new Error("--apply requires --state-db so parent classification decisions are recorded durably");
        }
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
          workspace: opts?.workspace,
          resolvedSqlitePath: b.cfg.sqlitePath,
        });
        process.stdout.write(opts?.json ? stablePendingDigestAutopilotJson(result) : `${result.humanSummary}\n`);
      }),
    );

  digest
    .command("autopilot-cron")
    .description(
      "Cron wrapper for pending digest autopilot (#1330). Enforces guard/lock/config safety, writes HM artifacts, and emits structured summary.",
    )
    .option("--json", "Emit structured summary JSON")
    .option("-v, --verbose", "Mirror internal step progress as the run executes (stderr in --json mode, stdout otherwise)")
    .action(
      withExit(async (opts?: { json?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        // In --json mode, progress must go to stderr, not stdout — stdout is reserved for the
        // final structured summary so downstream consumers can safely parse it as pure JSON.
        const progressStream = opts?.json ? process.stderr : process.stdout;
        const result = await runPendingDigestAutopilotCron({
          cfg: b.cfg,
          factsDb: b.factsDb,
          onProgress: verbose ? (line: string) => progressStream.write(`${line}\n`) : undefined,
        });
        process.stdout.write(opts?.json ? `${JSON.stringify(result.summary, null, 2)}\n` : `${result.humanSummary}\n`);
        if (result.summary.status === "failed" || result.summary.status === "partial") {
          throw new Error(
            `pending digest autopilot cron ${result.summary.status}; see ${result.summary.artifacts.hmLog} and ${result.summary.artifacts.hmExit}`,
          );
        }
      }),
    );
}

type DigestAutopilotCliOptions = {
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
  stateDb?: string;
  workspace?: string;
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
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) throw new Error(`Invalid numeric option: ${value}`);
  return Number.parseInt(normalized, 10);
}
