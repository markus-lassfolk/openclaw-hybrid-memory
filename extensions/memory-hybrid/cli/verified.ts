import { dirname, join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import { PendingAutopilotStore } from "../services/pending-autopilot/index.js";
import {
  VERIFIED_REVIEW_QUEUE_SOURCE,
  assertVerifiedTriagePolicy,
  listVerifiedFactTriageItems,
  runVerifiedFactTriage,
  type VerifiedTriagePolicy,
} from "../services/verified-fact-triage.js";
import { type Chainable, withExit } from "./shared.js";

export interface VerifiedCliContext {
  factsDb: Pick<FactsDB, "getRawDb">;
  resolvedSqlitePath?: string;
  resolvePath?: (file: string) => string;
  reverificationDays?: number;
}

export function registerVerifiedCommands(mem: Chainable, ctx: VerifiedCliContext): void {
  const verified = mem.command("verified").description("Inspect and conservatively triage verified facts.");

  verified
    .command("list")
    .description("List the verified-fact review queue (due-for-reverification latest verified facts).")
    .option("--max <n>", "Maximum items to list (default: 100)")
    .option("--policy <policy>", "report-only, classify, or apply-obvious (default: classify)")
    .option("--json", "Emit structured JSON")
    .action(
      withExit(async (opts?: { max?: string; policy?: string; json?: boolean }) => {
        const max = parsePositiveInt(opts?.max, 100);
        const policy: VerifiedTriagePolicy = assertVerifiedTriagePolicy(String(opts?.policy ?? "classify"));
        const items = listVerifiedFactTriageItems(ctx.factsDb.getRawDb(), {
          max,
          reverificationDays: ctx.reverificationDays,
          policy,
        });
        const output = {
          reviewQueueSource: VERIFIED_REVIEW_QUEUE_SOURCE,
          count: items.length,
          items: items.map((item) => ({
            verifiedFactId: item.payload.verified.id,
            factId: item.payload.verified.factId,
            nextVerification: item.payload.verified.nextVerification,
            verifiedAt: item.payload.verified.verifiedAt,
            scope: item.payload.fact?.scope ?? null,
            scopeTarget: item.payload.fact?.scopeTarget ?? null,
            inputHash: item.inputHash,
          })),
        };
        if (opts?.json) console.log(JSON.stringify(output, null, 2));
        else {
          console.log(`Verified review queue source: ${VERIFIED_REVIEW_QUEUE_SOURCE}`);
          console.log(`Pending verified-fact reviews: ${output.count}`);
          for (const item of output.items) {
            console.log(`- ${item.factId} (verified=${item.verifiedFactId}, next=${item.nextVerification ?? "none"})`);
          }
        }
      }),
    );

  verified
    .command("triage")
    .description("Classify due verified-fact reviews with conservative non-destructive policies.")
    .option("--dry-run", "Preview only; persist no durable review/foundation state")
    .option("--apply", "Persist allowed non-destructive pending-autopilot decisions")
    .option("--policy <policy>", "report-only, classify, or apply-obvious (default: report-only)")
    .option("--max <n>", "Maximum items to inspect (default: 100)")
    .option("--json", "Emit structured JSON")
    .action(
      withExit(async (opts?: { dryRun?: boolean; apply?: boolean; policy?: string; max?: string; json?: boolean }) => {
        if (opts?.dryRun && opts?.apply) throw new Error("Use only one of --dry-run or --apply");
        const mode = opts?.apply ? "apply" : "dry-run";
        const policy: VerifiedTriagePolicy = assertVerifiedTriagePolicy(String(opts?.policy ?? "report-only"));
        if (mode === "apply" && policy === "report-only") {
          throw new Error(
            "Policy report-only is preview-only; use --dry-run or choose --policy classify/apply-obvious.",
          );
        }
        const max = parsePositiveInt(opts?.max, 100);
        const store =
          mode === "apply" && policy !== "report-only"
            ? new PendingAutopilotStore(resolvePendingAutopilotPath(ctx))
            : null;
        try {
          const result = await runVerifiedFactTriage(ctx.factsDb, {
            mode,
            policy,
            max,
            reverificationDays: ctx.reverificationDays,
            store,
          });
          if (opts?.json) console.log(JSON.stringify(result, null, 2));
          else printHumanTriage(result);
          if (result.counts.failed > 0) process.exitCode = 1;
        } finally {
          store?.close();
        }
      }),
    );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePendingAutopilotPath(ctx: VerifiedCliContext): string {
  if (ctx.resolvePath) return ctx.resolvePath("pending-autopilot.db");
  if (ctx.resolvedSqlitePath) return join(dirname(ctx.resolvedSqlitePath), "pending-autopilot.db");
  return "./pending-autopilot.db";
}

function printHumanTriage(result: Awaited<ReturnType<typeof runVerifiedFactTriage>>): void {
  console.log(`Verified fact triage ${result.mode} policy=${result.policy}`);
  console.log(`Queue source: ${result.reviewQueueSource}`);
  console.log(
    `Inspected ${result.counts.inspected}; human-review ${result.counts.needsHuman}; applied metadata ${result.counts.applied}; failed ${result.counts.failed}`,
  );
  const groups = new Map<string, typeof result.items>();
  for (const item of result.items) groups.set(item.bucket, [...(groups.get(item.bucket) ?? []), item]);
  for (const [bucket, items] of groups) {
    console.log(`\n${bucket}: ${items.length}`);
    for (const item of items) console.log(`- ${item.factId}: ${item.reason} (${item.recommendedAction})`);
  }
}
