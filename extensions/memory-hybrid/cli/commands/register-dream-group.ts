/**
 * CLI group: `hybrid-mem dream …` (#2170 / #2171 / Epic #2169).
 *
 * Machine-first: run / status / promote / rollback. Manual promote is an escape hatch.
 */

import type { FactsDB } from "../../backends/facts-db.js";
import { DreamCandidateStore } from "../../backends/dream-candidate-store.js";
import type { DreamingConfig } from "../../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../../config/types/dreaming.js";
import { promoteDreamRun } from "../../services/dream-promote.js";
import { rollbackDreamRun } from "../../services/dream-rollback.js";
import { type DreamStepRunners, runDream } from "../../services/dream-run.js";
import { selectDreamSessions } from "../../services/dream-permission.js";
import { buildDreamRoiReport } from "../../services/dream-roi.js";
import { evaluateDreamOutcome } from "../../services/dream-outcome.js";
import type { ManageContext } from "../context.js";
import type { Chainable } from "../shared.js";
import { createCommandGroup } from "./cli-group-utils.js";

/** Commander nodes that expose `.argument` (see cli/skills.ts). */
type ArgumentChainable = {
  command(name: string): ArgumentChainable;
  argument(name: string, desc?: string): ArgumentChainable;
  description(desc: string): ArgumentChainable;
  option(flags: string, desc?: string, defaultValue?: unknown): ArgumentChainable;
  action(fn: (...args: any[]) => void | Promise<void>): ArgumentChainable;
};

export type DreamCliContext = {
  factsDb: FactsDB;
  dreaming?: DreamingConfig;
  /** Optional manage bindings so compose stages call existing runners. */
  manage?: Pick<
    ManageContext,
    | "runDistill"
    | "runSelfCorrectionRun"
    | "runContradictionCandidates"
    | "runResolveContradictionsAuto"
    | "runReflection"
    | "runConsolidate"
    | "runDreamCycle"
  >;
};

function getStore(factsDb: FactsDB): DreamCandidateStore {
  return new DreamCandidateStore(factsDb.getRawDb());
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function buildStepRunners(ctx: DreamCliContext): DreamStepRunners {
  const m = ctx.manage;
  if (!m) return {};

  const sink = {
    log: (s: string) => {
      process.stderr.write(`${s}\n`);
    },
    warn: (s: string) => {
      process.stderr.write(`${s}\n`);
    },
  };

  const runners: DreamStepRunners = {};

  if (m.runDistill) {
    runners.distill = async ({ dryRun }) => {
      const result = await m.runDistill!({ days: 7, dryRun }, sink);
      return {
        detail: `dryRun=${dryRun} stored=${result.stored} extracted=${result.factsExtracted} sessions=${result.sessionsScanned}`,
      };
    };
  }

  if (m.runSelfCorrectionRun) {
    runners["self-correction"] = async ({ dryRun }) => {
      const result = await m.runSelfCorrectionRun!({ dryRun: true, applyTools: false });
      return { detail: `dryRun=${dryRun} ${JSON.stringify(result ?? "self-correction done")}` };
    };
  }

  if (m.runContradictionCandidates || m.runResolveContradictionsAuto) {
    runners.contradictions = async ({ dryRun }) => {
      const parts: string[] = [];
      if (m.runContradictionCandidates) {
        const c = await m.runContradictionCandidates({ dryRun });
        parts.push(`candidates=${JSON.stringify(c)}`);
      }
      if (dryRun) {
        parts.push("resolve=skipped_dry_run");
      } else if (m.runResolveContradictionsAuto) {
        const r = await m.runResolveContradictionsAuto({});
        parts.push(`resolve=${JSON.stringify(r)}`);
      }
      return { detail: parts.join("; ") || "contradictions skipped" };
    };
  }

  if (m.runReflection) {
    runners.reflect = async ({ dryRun }) => {
      const result = await m.runReflection({
        window: 7,
        dryRun,
        model: "",
        verbose: false,
      });
      return { detail: JSON.stringify(result) };
    };
  }

  if (m.runConsolidate) {
    runners.consolidate = async ({ dryRun }) => {
      const result = await m.runConsolidate({
        threshold: 0.92,
        limit: 10,
        dryRun,
        includeStructured: true,
        model: "",
      });
      return { detail: JSON.stringify(result) };
    };
  }

  if (m.runDreamCycle) {
    runners["dream-cycle-core"] = async ({ dryRun }) => {
      const result = await m.runDreamCycle!({ dryRun, verbose: false });
      return { detail: JSON.stringify(result) };
    };
  }

  return runners;
}

function parseSessionList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function registerDreamGroup(mem: Chainable, ctx: DreamCliContext): void {
  const group = createCommandGroup(
    mem,
    "dream",
    "Autonomous Dreaming — unified Dream run, candidate status, machine promote/rollback",
  ) as ArgumentChainable;

  (group.command("run") as ArgumentChainable)
    .description("Unified Dream: compose maintenance stages → candidates → optional promote (#2171)")
    .option("--sessions <ids>", "Comma-separated session ids to attach")
    .option("--session-scopes <pairs>", "Optional id:scope pairs (e.g. s1:session,s2:global) for #2174")
    .option("--steering <id>", "Optional steering policy id override")
    .option("--dry-shadow", "Force shadow candidate run (no live promote apply)")
    .option("--promote", "Run machine promote after compose")
    .option("--force-promote", "Promote with --force (escape hatch)")
    .option("--compose <steps>", "Comma-separated compose override")
    .option("--json", "Machine-readable JSON")
    .action(
      async (opts: {
        sessions?: string;
        sessionScopes?: string;
        steering?: string;
        dryShadow?: boolean;
        promote?: boolean;
        forcePromote?: boolean;
        compose?: string;
        json?: boolean;
      }) => {
        const base = ctx.dreaming ?? DEFAULT_DREAMING_CONFIG;
        const composeOverride = opts.compose
          ? opts.compose
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const dreamCfg: DreamingConfig = {
          ...base,
          enabled: true,
          compose: composeOverride?.length
            ? (composeOverride as DreamingConfig["compose"])
            : base.compose,
          candidateStore: { ...base.candidateStore, enabled: true },
        };

        const rawIds = parseSessionList(opts.sessions);
        const scopeMap = new Map<string, string>();
        if (opts.sessionScopes) {
          for (const part of opts.sessionScopes.split(",")) {
            const [id, scope] = part.split(":").map((s) => s.trim());
            if (id && scope) scopeMap.set(id, scope);
          }
        }
        // Explicit --sessions: default ACL to session (⊆ any target). Bulk discovery must pass scopes.
        const attachment = selectDreamSessions(
          rawIds.map((sessionId) => ({
            sessionId,
            effectiveScope:
              scopeMap.get(sessionId) ??
              (base.permissionBoundary.personalMode ? "global" : "session"),
          })),
          dreamCfg.permissionBoundary,
          dreamCfg.maxSessions,
        );

        try {
          const result = await runDream({
            factsDb: ctx.factsDb,
            store: getStore(ctx.factsDb),
            cfg: dreamCfg,
            sessionIds: attachment.included,
            steeringPolicyId: opts.steering ?? dreamCfg.steering.profile,
            steps: buildStepRunners(ctx),
            dryShadow: opts.dryShadow === true,
            promote: opts.promote === true || opts.forcePromote === true ? true : undefined,
            forcePromote: opts.forcePromote === true,
          });
          printJson({
            dreamRunId: result.dreamRunId,
            status: result.run.status,
            shadow: result.run.shadow,
            mode: dreamCfg.mode,
            steering: dreamCfg.steering,
            inputStoreRevision: result.run.inputStoreRevision,
            sessionIds: result.run.sessionIds,
            excludedSessions: attachment.excluded,
            candidateCount: result.candidates.length,
            stepSummaries: result.stepSummaries,
            promoteResult: result.promoteResult ?? null,
            timedOut: result.timedOut,
            costFeature: result.costFeature,
          });
          if (result.run.status === "failed") process.exitCode = 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`dream run failed: ${message}\n`);
          process.exitCode = 1;
        }
      },
    );

  (group.command("status") as ArgumentChainable)
    .description("Show a dream run (or list recent runs)")
    .argument("[id]", "Dream run id")
    .option("--limit <n>", "Max runs when listing", "20")
    .option("--json", "Machine-readable JSON")
    .action((id: string | undefined, opts: { limit?: string; json?: boolean }) => {
      const store = getStore(ctx.factsDb);
      if (id) {
        const run = store.getDreamRun(id);
        if (!run) {
          process.stderr.write(`dream status: run not found: ${id}\n`);
          process.exitCode = 1;
          return;
        }
        const entries = store.listCandidateEntries(id);
        printJson({ run, entries, dreaming: ctx.dreaming ?? DEFAULT_DREAMING_CONFIG });
        return;
      }
      const limit = Math.max(1, Number.parseInt(opts.limit ?? "20", 10) || 20);
      printJson({ runs: store.listDreamRuns(limit) });
    });

  (group.command("promote") as ArgumentChainable)
    .description("Run machine gates and promote (or shadow would-promote). Escape hatch: --force")
    .argument("<id>", "Dream run id")
    .option("--force", "Apply even when shadow/autoPromote is off")
    .option("--json", "Machine-readable JSON")
    .action((id: string, opts: { force?: boolean; json?: boolean }) => {
      const store = getStore(ctx.factsDb);
      const cfg = ctx.dreaming ?? DEFAULT_DREAMING_CONFIG;
      const result = promoteDreamRun(ctx.factsDb, store, id, {
        force: opts.force === true,
        cfg,
      });
      printJson(result);
      if (result.error || result.status === "failed" || result.status === "quarantined") {
        process.exitCode = result.applied ? 0 : 1;
      }
    });

  (group.command("rollback") as ArgumentChainable)
    .description("Roll back a promoted dream run via reverse plans")
    .argument("<id>", "Dream run id")
    .option("--reason <text>", "Rollback reason")
    .option("--force", "Allow rollback when status is not promoted")
    .option("--json", "Machine-readable JSON")
    .action((id: string, opts: { reason?: string; force?: boolean; json?: boolean }) => {
      const store = getStore(ctx.factsDb);
      const result = rollbackDreamRun(ctx.factsDb, store, id, {
        reason: opts.reason,
        force: opts.force === true,
      });
      printJson(result);
      if (!result.rolledBack) process.exitCode = 1;
    });

  (group.command("report") as ArgumentChainable)
    .description("Dream ROI report — cost + outcome summaries (#2179)")
    .option("--since-days <n>", "Lookback days", "30")
    .option("--limit <n>", "Max runs", "100")
    .option("--json", "Machine-readable JSON")
    .action((opts: { sinceDays?: string; limit?: string; json?: boolean }) => {
      const store = getStore(ctx.factsDb);
      const days = Math.max(1, Number.parseInt(opts.sinceDays ?? "30", 10) || 30);
      const untilSec = Math.floor(Date.now() / 1000);
      const report = buildDreamRoiReport(store, {
        sinceSec: untilSec - days * 24 * 3600,
        untilSec,
        limit: Math.max(1, Number.parseInt(opts.limit ?? "100", 10) || 100),
        db: ctx.factsDb.getRawDb(),
      });
      printJson(report);
    });

  (group.command("observe") as ArgumentChainable)
    .description("Evaluate post-promote outcomes and optionally auto-rollback (#2173)")
    .argument("<id>", "Dream run id")
    .option("--effect-score <n>", "Observed effect score 0..1", "0")
    .option("--success-rate <n>", "Observed success rate 0..1", "0")
    .option("--retry-rate <n>", "Observed retry rate", "0")
    .option("--sessions <n>", "Sessions observed in window", "0")
    .option("--apply", "Apply rollback when regression detected and autoRollback.enabled")
    .option("--json", "Machine-readable JSON")
    .action(
      (
        id: string,
        opts: {
          effectScore?: string;
          successRate?: string;
          retryRate?: string;
          sessions?: string;
          apply?: boolean;
          json?: boolean;
        },
      ) => {
        const store = getStore(ctx.factsDb);
        const cfg = ctx.dreaming ?? DEFAULT_DREAMING_CONFIG;
        const report = evaluateDreamOutcome(
          ctx.factsDb,
          store,
          id,
          {
            effectScore: Number.parseFloat(opts.effectScore ?? "0") || 0,
            successRate: Number.parseFloat(opts.successRate ?? "0") || 0,
            retryRate: Number.parseFloat(opts.retryRate ?? "0") || 0,
            sessionsObserved: Number.parseInt(opts.sessions ?? "0", 10) || 0,
          },
          {
            cfg,
            applyRollback: opts.apply === true,
            minSessions: 3,
          },
        );
        printJson(report);
        if (report.decision === "rollback" && opts.apply && !report.rollback?.rolledBack) {
          process.exitCode = 1;
        }
      },
    );
}
