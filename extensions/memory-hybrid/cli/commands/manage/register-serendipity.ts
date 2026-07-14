/**
 * CLI registration for `serendipity list|show|record|resolve|digest|backlog|sweep|level` (Issue #2119).
 *
 * Operator-facing surface over the SerendipityStore: inspect findings, resolve
 * them, manage scoped engagement levels, and run the opt-in Level-4 sweep.
 * Thin wrappers over the same store the serendipity_* agent tools use.
 */

import type { SerendipityStore } from "../../../backends/serendipity-store.js";
import { buildSerendipityDigestReport, writeSerendipityDigestOutput } from "../../../services/serendipity-digest.js";
import { parsePendingDigestSinceDays } from "../../../services/pending-review-digest.js";
import { decideSerendipityAction } from "../../../services/serendipity-policy.js";
import { renderSerendipitySweepSummary, runSerendipitySweep } from "../../../services/serendipity-sweep-cron.js";
import type {
  SerendipityFindingType,
  SerendipityRiskLevel,
  SerendipityScope,
  SerendipityStatus,
} from "../../../types/serendipity-types.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

function requireStore(store: SerendipityStore | null | undefined): SerendipityStore {
  if (!store) {
    throw new Error("Serendipity Protocol is disabled. Set serendipityProtocol.enabled: true in plugin config.");
  }
  return store;
}

export function registerManageSerendipity(mem: Chainable, b: ManageBindings): void {
  const { cfg } = b;
  const sp = cfg.serendipityProtocol;
  const ser = mem.command("serendipity").description("Inspect and manage bounded proactive findings (#2119).");

  ser
    .command("list")
    .description("List findings (or the actionable deferred backlog with --backlog).")
    .option("--status <status>", "Filter by status")
    .option("--type <type>", "Filter by finding type")
    .option("--risk <risk>", "Filter by risk level")
    .option("--repo <repo>", "Filter by repo")
    .option("--backlog", "Only actionable, non-expired deferred findings")
    .option("--limit <n>", "Max rows (default 50)", "50")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (opts?: {
          status?: string;
          type?: string;
          risk?: string;
          repo?: string;
          backlog?: boolean;
          limit?: string;
          json?: boolean;
        }) => {
          const store = requireStore(b.serendipityStore);
          const limit = Math.max(1, Math.min(500, Number.parseInt(opts?.limit ?? "50", 10) || 50));
          const findings = opts?.backlog
            ? store.listActionableDeferred({ level: 4, repo: opts?.repo, limit })
            : store.list({
                status: opts?.status ? [opts.status as SerendipityStatus] : undefined,
                findingType: opts?.type ? [opts.type as SerendipityFindingType] : undefined,
                riskLevel: opts?.risk ? [opts.risk as SerendipityRiskLevel] : undefined,
                repo: opts?.repo,
                limit,
              });
          if (opts?.json) {
            console.log(JSON.stringify(findings, null, 2));
            return;
          }
          if (findings.length === 0) {
            console.log("No findings match.");
            return;
          }
          for (const f of findings) {
            console.log(
              `${f.id.slice(0, 8)}  [${f.status}] ${f.title} (${f.findingType}, risk ${f.riskLevel}, ${f.adjacency})`,
            );
          }
        },
      ),
    );

  ser
    .command("show <id>")
    .description("Show one finding, with the recommended action for the default level.")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (id: string, opts?: { json?: boolean }) => {
        const store = requireStore(b.serendipityStore);
        const finding = store.resolve(id);
        if (!finding) throw new Error(`Finding not found: ${id}`);
        const decision = decideSerendipityAction(finding, sp.defaultLevel);
        if (opts?.json) {
          console.log(JSON.stringify({ finding, decision }, null, 2));
          return;
        }
        console.log(`${finding.id}  ${finding.title}`);
        console.log(`  status=${finding.status} type=${finding.findingType} risk=${finding.riskLevel}`);
        console.log(`  reversibility=${finding.reversibility} adjacency=${finding.adjacency}`);
        console.log(`  description: ${finding.description}`);
        if (finding.evidence.length > 0) console.log(`  evidence:\n    - ${finding.evidence.join("\n    - ")}`);
        console.log(`  recommended (level ${decision.level}): ${decision.action} — ${decision.rationale}`);
      }),
    );

  ser
    .command("record <title>")
    .description("Record a finding.")
    .requiredOption("--type <type>", "Finding type")
    .option("--description <text>", "Description", "")
    .option("--risk <risk>", "Risk level (low|medium|high)")
    .option("--repo <repo>", "Repo")
    .option("--entity <entity>", "Entity")
    .option("--evidence <items...>", "Evidence lines")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (
          title: string,
          opts?: {
            type?: string;
            description?: string;
            risk?: string;
            repo?: string;
            entity?: string;
            evidence?: string[];
            json?: boolean;
          },
        ) => {
          const store = requireStore(b.serendipityStore);
          const finding = store.create(
            {
              title,
              description: opts?.description ?? "",
              findingType: (opts?.type ?? "other") as SerendipityFindingType,
              riskLevel: opts?.risk as SerendipityRiskLevel | undefined,
              repo: opts?.repo,
              entity: opts?.entity,
              evidence: opts?.evidence,
            },
            { defaultTtlDays: sp.deferredTtlDays },
          );
          console.log(opts?.json ? JSON.stringify(finding, null, 2) : `Recorded ${finding.id}`);
        },
      ),
    );

  ser
    .command("resolve <id>")
    .description("Resolve a finding (fixed|filed|remembered|proposed|dismissed|deferred).")
    .requiredOption("--status <status>", "New status")
    .option("--action <text>", "What was done")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (id: string, opts?: { status?: string; action?: string; json?: boolean }) => {
        const store = requireStore(b.serendipityStore);
        const finding = store.resolve(id);
        if (!finding) throw new Error(`Finding not found: ${id}`);
        const updated = store.transition(finding.id, opts?.status as SerendipityStatus, { actionTaken: opts?.action });
        console.log(
          opts?.json ? JSON.stringify(updated, null, 2) : `Finding ${finding.id.slice(0, 8)} → ${updated.status}`,
        );
      }),
    );

  ser
    .command("backlog")
    .description("Show the actionable deferred backlog ranked by urgency and leverage.")
    .option("--limit <n>", "Max rows (default 20)", "20")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { limit?: string; json?: boolean }) => {
        const store = requireStore(b.serendipityStore);
        const limit = Math.max(1, Math.min(500, Number.parseInt(opts?.limit ?? "20", 10) || 20));
        const findings = store.listActionableDeferred({ level: 4, limit });
        if (opts?.json) {
          console.log(JSON.stringify(findings, null, 2));
          return;
        }
        if (findings.length === 0) {
          console.log("Backlog is empty.");
          return;
        }
        for (const f of findings) {
          console.log(
            `${f.id.slice(0, 8)}  ${f.title} (${f.findingType}, risk ${f.riskLevel}, → ${f.suggestedAction})`,
          );
        }
      }),
    );

  ser
    .command("digest")
    .description("Compact digest of findings + actionable backlog.")
    .option("--since <window>", "Lookback, e.g. 7d/24h/2w", "7d")
    .option("--format <fmt>", "md|json", "md")
    .option("--out <path>", "Write to path, or - for stdout")
    .action(
      withExit(async (opts?: { since?: string; format?: string; out?: string }) => {
        const store = requireStore(b.serendipityStore);
        const sinceDays = parsePendingDigestSinceDays(opts?.since ?? "7d");
        const report = buildSerendipityDigestReport({ store, sinceDays, level: 4 });
        const format = opts?.format === "json" ? "json" : "md";
        writeSerendipityDigestOutput({ report, format, outPath: opts?.out ?? "-" });
      }),
    );

  ser
    .command("sweep")
    .description("Run the opt-in Level-4 deferred-backlog sweep (prune + report).")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const summary = runSerendipitySweep({ cfg, store: b.serendipityStore ?? null });
        if (opts?.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }
        console.log(renderSerendipitySweepSummary(summary));
      }),
    );

  const level = ser.command("level").description("Get or set scoped engagement levels.");
  level
    .command("get")
    .description("List stored level preferences and the config default.")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const store = requireStore(b.serendipityStore);
        const prefs = store.listLevelPrefs();
        if (opts?.json) {
          console.log(JSON.stringify({ defaultLevel: sp.defaultLevel, prefs }, null, 2));
          return;
        }
        console.log(`Default level: ${sp.defaultLevel}`);
        if (prefs.length === 0) {
          console.log("No scoped overrides.");
          return;
        }
        for (const p of prefs) {
          console.log(
            `  ${p.scope}${p.scopeTarget ? `:${p.scopeTarget}` : ""} = ${p.level}${p.enabled ? "" : " (disabled)"}`,
          );
        }
      }),
    );
  level
    .command("set <level>")
    .description("Set a scoped engagement level (0–4).")
    .requiredOption("--scope <scope>", "global|user|agent|session|repo|channel")
    .option("--target <target>", "Scope target (id/name); omit for global")
    .option("--disabled", "Store as disabled (serendipity off for this scope)")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (levelArg: string, opts?: { scope?: string; target?: string; disabled?: boolean; json?: boolean }) => {
          const store = requireStore(b.serendipityStore);
          const value = Number.parseFloat(levelArg);
          if (!Number.isFinite(value)) throw new Error(`Invalid level: ${levelArg}`);
          const pref = store.setLevel(
            (opts?.scope ?? "global") as SerendipityScope,
            opts?.target ?? null,
            value,
            !opts?.disabled,
          );
          console.log(
            opts?.json
              ? JSON.stringify(pref, null, 2)
              : `Set ${pref.scope}${pref.scopeTarget ? `:${pref.scopeTarget}` : ""} = ${pref.level}`,
          );
        },
      ),
    );
}
