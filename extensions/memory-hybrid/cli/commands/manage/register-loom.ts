/**
 * CLI registration for The Loom (Epic #2150): `evidence`, `belief`, `live-checks`,
 * `loops`, `drift`, `lifecycle`, `attention`, `runway`, and `loom brief|report`.
 * Thin operator-facing wrappers over the same LoomStore/services the agent tools use.
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import type { LoomStore } from "../../../backends/loom-store.js";
import { parseLoomConfig } from "../../../config/parsers/loom.js";
import { buildRunway } from "../../../services/agent-runway.js";
import { rankAttention } from "../../../services/attention-steward.js";
import { renderClaimExplainMarkdown } from "../../../services/belief-explain.js";
import { runDriftScout } from "../../../services/drift-scout.js";
import { renderEvidenceCapsuleMarkdown } from "../../../services/evidence-capsule-render.js";
import { redactEvidenceCapsuleInput } from "../../../services/evidence-redaction.js";
import { resolveGoalsDir } from "../../../services/goal-stewardship.js";
import { buildLoomBrief, renderLoomBriefMarkdown } from "../../../services/loom-brief.js";
import { buildLoomReport, renderLoomReportHtml, renderLoomReportMarkdown } from "../../../services/loom-report.js";
import {
  applyLifecycleAction,
  LifecycleConfirmRequiredError,
  LifecycleStrongConfirmRequiredError,
  listLifecycleCandidates,
} from "../../../services/memory-lifecycle.js";
import type { CreateEvidenceCapsuleInput } from "../../../types/evidence-types.js";
import type { LifecycleAction, LifecycleTargetKind } from "../../../types/lifecycle-workflow-types.js";
import type { LoopOwner, LoopStatus, LoopType } from "../../../types/open-loop-types.js";
import { getEnv } from "../../../utils/env-manager.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

function requireStore(store: LoomStore | null | undefined): LoomStore {
  if (!store) {
    throw new Error("The Loom is disabled. Set loom.enabled: true in plugin config.");
  }
  return store;
}

function writeOut(text: string, outPath?: string): void {
  if (!outPath || outPath === "-") {
    console.log(text);
    return;
  }
  writeFileSync(outPath, text, "utf-8");
  console.log(`Wrote ${outPath}`);
}

export function registerManageLoom(mem: Chainable, b: ManageBindings): void {
  const { cfg } = b;
  // Falls back to parsed defaults if `cfg.loom` is missing entirely (minimal/stub configs in
  // tests, or partial config objects) — command registration below reads `lc.*` eagerly for
  // option defaults, before any `loom.enabled` gate has a chance to run.
  const lc = cfg.loom ?? parseLoomConfig(cfg as Record<string, unknown>);

  // --- evidence ---------------------------------------------------------
  const evidence = mem.command("evidence").description("Evidence capsules — durable proof objects (#2148).");
  evidence
    .command("create <title>")
    .description("Create an evidence capsule.")
    .requiredOption("--claim <text>", "The claim/statement this capsule supports.")
    .option("--evidence <lines...>", "Evidence lines (kind=command; free text).")
    .option("--limits <text>", "What was NOT checked.")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (title: string, opts?: { claim?: string; evidence?: string[]; limits?: string; json?: boolean }) => {
          const store = requireStore(b.loomStore);
          const input: CreateEvidenceCapsuleInput = {
            title,
            claim: opts?.claim ?? "",
            evidence: (opts?.evidence ?? []).map((text) => ({ kind: "observation" as const, text })),
            limits: opts?.limits,
          };
          const content = redactEvidenceCapsuleInput(input, {
            redactSecrets: lc.evidence.redactSecrets,
            rejectUnredactable: lc.evidence.rejectUnredactable,
          });
          const capsule = store.createEvidenceCapsule({ content });
          console.log(opts?.json ? JSON.stringify(capsule, null, 2) : `Created ${capsule.id}`);
        },
      ),
    );
  evidence
    .command("attach <capsuleId>")
    .description("Attach a capsule to a task/goal/claim.")
    .option("--task <label>", "Active task label")
    .option("--goal <id>", "Goal id")
    .option("--claim <id>", "Claim id")
    .action(
      withExit(async (capsuleId: string, opts?: { task?: string; goal?: string; claim?: string }) => {
        const store = requireStore(b.loomStore);
        const capsule = store.resolveEvidenceCapsule(capsuleId);
        if (!capsule) throw new Error(`Evidence capsule not found: ${capsuleId}`);
        let updated = capsule;
        if (opts?.task !== undefined || opts?.goal !== undefined) {
          updated = store.attachEvidenceCapsule(capsule.id, { linkedTaskLabel: opts?.task, linkedGoalId: opts?.goal });
        }
        if (opts?.claim) updated = store.linkEvidenceCapsuleToClaim(capsule.id, opts.claim);
        console.log(`Attached ${updated.id}`);
      }),
    );
  evidence
    .command("show <capsuleId>")
    .description("Show one evidence capsule.")
    .option("--format <fmt>", "md|json", "md")
    .action(
      withExit(async (capsuleId: string, opts?: { format?: string }) => {
        const store = requireStore(b.loomStore);
        const capsule = store.resolveEvidenceCapsule(capsuleId);
        if (!capsule) throw new Error(`Evidence capsule not found: ${capsuleId}`);
        console.log(
          opts?.format === "json"
            ? JSON.stringify(capsule, null, 2)
            : renderEvidenceCapsuleMarkdown(capsule, { concise: false }),
        );
      }),
    );
  evidence
    .command("list")
    .description("List evidence capsules.")
    .option("--task <label>", "Filter by linked task label")
    .option("--goal <id>", "Filter by linked goal id")
    .option("--limit <n>", "Max rows", "50")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { task?: string; goal?: string; limit?: string; json?: boolean }) => {
        const store = requireStore(b.loomStore);
        const capsules = store.listEvidenceCapsules({
          linkedTaskLabel: opts?.task,
          linkedGoalId: opts?.goal,
          limit: Number.parseInt(opts?.limit ?? "50", 10),
        });
        if (opts?.json) {
          console.log(JSON.stringify(capsules, null, 2));
          return;
        }
        if (capsules.length === 0) {
          console.log("No evidence capsules.");
          return;
        }
        for (const c of capsules) console.log(`${c.id.slice(0, 8)}  ${c.title}`);
      }),
    );

  // --- belief -------------------------------------------------------------
  const belief = mem.command("belief").description("Belief graph / claim ledger (#2151).");
  belief
    .command("assert")
    .description("Assert a claim.")
    .requiredOption("--entity <entity>", "Entity")
    .requiredOption("--key <key>", "Predicate/key")
    .requiredOption("--value <value>", "Value")
    .option("--why <text>", "Justification")
    .option("--confidence <n>", "0-1 confidence")
    .option("--live-check", "Require a live check before use")
    .option("--live-check-reason <text>", "Why a live check is required")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (opts?: {
          entity?: string;
          key?: string;
          value?: string;
          why?: string;
          confidence?: string;
          liveCheck?: boolean;
          liveCheckReason?: string;
          json?: boolean;
        }) => {
          const store = requireStore(b.loomStore);
          const claim = store.assertClaim({
            entity: opts?.entity ?? "",
            predicate: opts?.key ?? "",
            value: opts?.value ?? "",
            why: opts?.why,
            confidence: opts?.confidence ? Number.parseFloat(opts.confidence) : undefined,
            liveCheckRequired: opts?.liveCheck,
            liveCheckReason: opts?.liveCheckReason,
          });
          console.log(opts?.json ? JSON.stringify(claim, null, 2) : `Asserted ${claim.id} (${claim.status})`);
        },
      ),
    );
  belief
    .command("get")
    .description("Get beliefs for an entity.")
    .requiredOption("--entity <entity>", "Entity")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { entity?: string; json?: boolean }) => {
        const store = requireStore(b.loomStore);
        const beliefs = store.getBeliefsForEntity(opts?.entity ?? "");
        if (opts?.json) {
          console.log(JSON.stringify(beliefs, null, 2));
          return;
        }
        if (beliefs.length === 0) {
          console.log("No beliefs.");
          return;
        }
        for (const c of beliefs) console.log(`${c.id.slice(0, 8)}  [${c.status}] ${c.predicate} = ${c.value}`);
      }),
    );
  belief
    .command("verify <claimId>")
    .description("Mark a claim verified.")
    .option("--evidence <capsuleId>", "Evidence capsule id")
    .action(
      withExit(async (claimId: string, opts?: { evidence?: string }) => {
        const store = requireStore(b.loomStore);
        const claim = store.resolveClaim(claimId);
        if (!claim) throw new Error(`Claim not found: ${claimId}`);
        const updated = store.verifyClaim(claim.id, { evidenceCapsuleId: opts?.evidence });
        console.log(`${updated.id} -> ${updated.status}`);
      }),
    );
  belief
    .command("contradict <claimId>")
    .description("Mark two claims as contradicting.")
    .requiredOption("--with <otherClaimId>", "The other claim id")
    .option("--reason <text>", "Reason")
    .action(
      withExit(async (claimId: string, opts?: { with?: string; reason?: string }) => {
        const store = requireStore(b.loomStore);
        const claim = store.resolveClaim(claimId);
        const other = store.resolveClaim(opts?.with ?? "");
        if (!claim || !other) throw new Error("Claim not found.");
        const updated = store.contradictClaim(claim.id, other.id, opts?.reason);
        console.log(`${updated.id} -> contradicted`);
      }),
    );
  belief
    .command("supersede <claimId>")
    .description("Mark a claim superseded by another.")
    .requiredOption("--by <newClaimId>", "The superseding claim id")
    .action(
      withExit(async (claimId: string, opts?: { by?: string }) => {
        const store = requireStore(b.loomStore);
        const claim = store.resolveClaim(claimId);
        const successor = store.resolveClaim(opts?.by ?? "");
        if (!claim || !successor) throw new Error("Claim not found.");
        const updated = store.supersedeClaim(claim.id, successor.id);
        console.log(`${updated.id} -> superseded by ${successor.id}`);
      }),
    );
  belief
    .command("explain <claimId>")
    .description("Explain a claim.")
    .option("--format <fmt>", "md|json", "md")
    .action(
      withExit(async (claimId: string, opts?: { format?: string }) => {
        const store = requireStore(b.loomStore);
        const claim = store.resolveClaim(claimId);
        if (!claim) throw new Error(`Claim not found: ${claimId}`);
        const liveCheck = store.getLiveCheckStatus(claim.id);
        console.log(
          opts?.format === "json"
            ? JSON.stringify({ claim, liveCheck }, null, 2)
            : renderClaimExplainMarkdown(claim, liveCheck),
        );
      }),
    );
  belief
    .command("require-live-check <claimId>")
    .description("Declare that a claim requires a live check before use.")
    .requiredOption("--reason <text>", "Reason")
    .action(
      withExit(async (claimId: string, opts?: { reason?: string }) => {
        const store = requireStore(b.loomStore);
        const claim = store.resolveClaim(claimId);
        if (!claim) throw new Error(`Claim not found: ${claimId}`);
        const updated = store.requireLiveCheck(claim.id, { reason: opts?.reason ?? "" });
        console.log(`${updated.id} now requires a live check.`);
      }),
    );

  // --- live-checks ----------------------------------------------------------
  const liveChecks = mem.command("live-checks").description("Live-check contracts on claims (#2156).");
  liveChecks
    .command("list")
    .description("List claims requiring a live check.")
    .option("--scope <scope>", "Filter by scope (entity match)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { scope?: string; json?: boolean }) => {
        const store = requireStore(b.loomStore);
        const claims = store.listUnsatisfiedLiveChecks().filter((c) => !opts?.scope || c.entity === opts.scope);
        const withStatus = claims.map((c) => ({ claim: c, status: store.getLiveCheckStatus(c.id) }));
        if (opts?.json) {
          console.log(JSON.stringify(withStatus, null, 2));
          return;
        }
        if (withStatus.length === 0) {
          console.log("No live checks pending.");
          return;
        }
        for (const x of withStatus)
          console.log(`[${x.status.state}] ${x.claim.entity} ${x.claim.predicate} (${x.claim.id.slice(0, 8)})`);
      }),
    );
  liveChecks
    .command("satisfy <claimId>")
    .description("Record that a live check was satisfied.")
    .option("--evidence <capsuleId>", "Evidence capsule id")
    .option("--note <text>", "Note")
    .action(
      withExit(async (claimId: string, opts?: { evidence?: string; note?: string }) => {
        const store = requireStore(b.loomStore);
        const claim = store.resolveClaim(claimId);
        if (!claim) throw new Error(`Claim not found: ${claimId}`);
        const event = store.satisfyLiveCheck({
          claimId: claim.id,
          evidenceCapsuleId: opts?.evidence,
          note: opts?.note,
          ttlHours: lc.liveChecks.defaultTtlHours,
        });
        console.log(`Satisfied${event.expiresAt ? ` (valid until ${event.expiresAt})` : ""}.`);
      }),
    );

  // --- loops ------------------------------------------------------------
  const loops = mem.command("loops").description("Open-loop obligations ledger (#2152).");
  loops
    .command("create <title>")
    .description("Create an open loop.")
    .requiredOption("--type <type>", "Loop type")
    .option("--closure <text>", "Closure criteria")
    .option("--next <text>", "Next action")
    .option("--owner <owner>", "human|agent|system|unknown")
    .option("--scope <scope>", "Scope")
    .option("--entity <entity>", "Entity")
    .option("--repo <repo>", "Repo")
    .option("--evidence-required", "Require evidence to close")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (
          title: string,
          opts?: {
            type?: string;
            closure?: string;
            next?: string;
            owner?: string;
            scope?: string;
            entity?: string;
            repo?: string;
            evidenceRequired?: boolean;
            json?: boolean;
          },
        ) => {
          const store = requireStore(b.loomStore);
          const loop = store.createOpenLoop(
            {
              title,
              loopType: (opts?.type ?? "watch_condition") as LoopType,
              closureCriteria: opts?.closure,
              nextAction: opts?.next,
              owner: opts?.owner as LoopOwner | undefined,
              scope: opts?.scope,
              entity: opts?.entity,
              repo: opts?.repo,
              evidenceRequired: opts?.evidenceRequired,
            },
            { defaultResurfaceDays: lc.openLoops.defaultResurfaceDays },
          );
          console.log(opts?.json ? JSON.stringify(loop, null, 2) : `Created ${loop.id}`);
        },
      ),
    );
  loops
    .command("list")
    .description("List open loops.")
    .option("--status <status...>", "Filter by status")
    .option("--scope <scope>", "Filter by scope")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { status?: string[]; scope?: string; json?: boolean }) => {
        const store = requireStore(b.loomStore);
        const list = store.listOpenLoops({ status: opts?.status as LoopStatus[] | undefined, scope: opts?.scope });
        if (opts?.json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        if (list.length === 0) {
          console.log("No open loops.");
          return;
        }
        for (const l of list) console.log(`${l.id.slice(0, 8)}  [${l.status}] ${l.title}`);
      }),
    );
  loops
    .command("close <loopId>")
    .description("Close an open loop.")
    .option("--evidence <capsuleId>", "Evidence capsule id")
    .option("--reason <text>", "Reason")
    .action(
      withExit(async (loopId: string, opts?: { evidence?: string; reason?: string }) => {
        const store = requireStore(b.loomStore);
        const loop = store.resolveOpenLoop(loopId);
        if (!loop) throw new Error(`Open loop not found: ${loopId}`);
        const updated = store.closeOpenLoop(loop.id, { evidenceCapsuleId: opts?.evidence, reason: opts?.reason });
        console.log(`${updated.id} -> ${updated.status}`);
      }),
    );
  loops
    .command("resurface")
    .description("List loops due for resurfacing.")
    .option("--due", "Only loops already due")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const store = requireStore(b.loomStore);
        const due = store.listLoopsDueForResurface();
        if (opts?.json) {
          console.log(JSON.stringify(due, null, 2));
          return;
        }
        if (due.length === 0) {
          console.log("Nothing due.");
          return;
        }
        for (const l of due) console.log(`${l.id.slice(0, 8)}  ${l.title}`);
      }),
    );

  // --- drift --------------------------------------------------------------
  const drift = mem.command("drift").description("Drift scout — stale instructions/deprecated commands (#2146).");
  drift
    .command("scout")
    .description("Scan for drift.")
    .option("--since <window>", "Lookback (unused placeholder for future cron-based scans)")
    .option("--include <items...>", "cron,skills,wiki,facts,active_tasks")
    .option("--apply-safe", "Apply mechanical auto_safe fixes")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { include?: string[]; applySafe?: boolean; json?: boolean }) => {
        const store = requireStore(b.loomStore);
        const report = runDriftScout(
          { factsDb: b.factsDb, loomStore: store },
          {
            include: opts?.include as never,
            applySafe: opts?.applySafe,
            deprecatedCommands: lc.drift.deprecatedCommands,
          },
        );
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`${report.newCount} new, ${report.existingCount} existing, ${report.appliedSafeCount} auto-fixed.`);
        for (const f of report.findings.slice(0, 20))
          console.log(`- [${f.severity}] ${f.driftType}: ${f.oldText.slice(0, 80)}`);
      }),
    );

  // --- lifecycle ------------------------------------------------------------
  // Named `memory-lifecycle` (not `lifecycle`) — that top-level command name is already taken by
  // the GitHub sync adapters group (Issue #1196, cli/commands/manage/register-lifecycle.ts).
  const lifecycle = mem
    .command("memory-lifecycle")
    .description("Memory lifecycle workflows — demote/archive/delete (#2155).");
  lifecycle
    .command("candidates")
    .description("Report-only: list lifecycle candidates.")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const store = requireStore(b.loomStore);
        const report = listLifecycleCandidates({ factsDb: b.factsDb, loomStore: store });
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (report.candidates.length === 0) {
          console.log("No lifecycle candidates.");
          return;
        }
        for (const c of report.candidates)
          console.log(`[${c.suggestedAction}] ${c.targetId.slice(0, 8)}: ${c.explanation}`);
      }),
    );
  for (const action of ["demote", "archive", "delete"] as const) {
    lifecycle
      .command(`${action} <targetId>`)
      .description(`${action} a fact.`)
      .requiredOption("--reason <text>", "Reason")
      .option("--confirm", "Confirm (required for delete)")
      .option("--strong-confirm <token>", "Strong confirm token (required to delete a verified fact)")
      .action(
        withExit(async (targetId: string, opts?: { reason?: string; confirm?: boolean; strongConfirm?: string }) => {
          const store = requireStore(b.loomStore);
          try {
            const result = applyLifecycleAction(
              { factsDb: b.factsDb, loomStore: store },
              {
                targetKind: "fact" as LifecycleTargetKind,
                targetId,
                action: action as LifecycleAction,
                reason: opts?.reason ?? "",
                confirm: opts?.confirm,
                strongConfirm: opts?.strongConfirm,
              },
              { requireStrongConfirmForVerified: lc.lifecycle.requireStrongConfirmForVerified },
            );
            console.log(result.message);
          } catch (err) {
            if (err instanceof LifecycleConfirmRequiredError || err instanceof LifecycleStrongConfirmRequiredError) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            throw err;
          }
        }),
      );
  }

  // --- attention ------------------------------------------------------------
  const attention = mem.command("attention").description("Attention steward — ranking, demotion, focus (#2153).");
  attention
    .command("rank")
    .description("Rank what deserves attention.")
    .option("--scope <scope>", "Scope")
    .option("--entity <entity>", "Entity")
    .option("--limit <n>", "Max rows", String(lc.attention.defaultLimit))
    .option("--format <fmt>", "md|json", "md")
    .action(
      withExit(async (opts?: { scope?: string; entity?: string; limit?: string; format?: string }) => {
        const store = requireStore(b.loomStore);
        const report = rankAttention(
          { loomStore: store, serendipityStore: b.serendipityStore },
          { scope: opts?.scope, entity: opts?.entity, limit: Number.parseInt(opts?.limit ?? "20", 10) },
        );
        if (opts?.format === "json") {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (report.items.length === 0) {
          console.log("Nothing needs attention.");
          return;
        }
        for (const i of report.items) console.log(`[${i.category}] ${i.title} (score ${i.score.toFixed(2)})`);
      }),
    );
  attention
    .command("demote <targetKind> <targetId>")
    .description("Demote an item (non-destructive).")
    .option("--reason <text>", "Reason")
    .action(
      withExit(async (targetKind: string, targetId: string, opts?: { reason?: string }) => {
        const store = requireStore(b.loomStore);
        const override = store.setAttentionOverride({
          targetKind: targetKind as never,
          targetId,
          action: "demote",
          reason: opts?.reason,
        });
        console.log(`Demoted ${override.targetKind}:${override.targetId.slice(0, 8)}`);
      }),
    );
  attention
    .command("snooze <targetKind> <targetId>")
    .description("Snooze an item until a date.")
    .requiredOption("--until <date>", "ISO date")
    .action(
      withExit(async (targetKind: string, targetId: string, opts?: { until?: string }) => {
        const store = requireStore(b.loomStore);
        const override = store.setAttentionOverride({
          targetKind: targetKind as never,
          targetId,
          action: "snooze",
          snoozedUntil: opts?.until,
        });
        console.log(`Snoozed ${override.targetKind}:${override.targetId.slice(0, 8)} until ${override.snoozedUntil}`);
      }),
    );

  // --- runway ---------------------------------------------------------------
  mem
    .command("runway")
    .description("Agent Runway API — compact preflight context (#2145).")
    .option("--agent <name>", "Agent name")
    .option("--scope <scope>", "Scope")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { agent?: string; scope?: string; json?: boolean }) => {
        const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? pathJoin(homedir(), ".openclaw", "workspace");
        const goalsDir =
          cfg.goalStewardship?.enabled === true
            ? resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir)
            : undefined;
        const bundle = await buildRunway(
          { factsDb: b.factsDb, loomStore: b.loomStore ?? null, serendipityStore: b.serendipityStore, goalsDir },
          { agent: opts?.agent, scope: opts?.scope, maxItemsPerSection: lc.runway.maxItemsPerSection },
        );
        if (opts?.json) {
          console.log(JSON.stringify(bundle, null, 2));
          return;
        }
        console.log(
          `${bundle.activeTasks.length} active task(s), ${bundle.goals.length} goal(s), ${bundle.loom.openLoops.length} open loop(s).`,
        );
        for (const w of bundle.warnings) console.log(`! ${w}`);
      }),
    );

  // --- loom brief / report ---------------------------------------------------
  const loom = mem.command("loom").description("The Loom — brief and report (#2154, #2157).");
  loom
    .command("brief")
    .description("Pre-action synthesis brief.")
    .option("--scope <scope>", "Scope", "")
    .option("--task <task>", "Active task label")
    .option("--format <fmt>", "md|json", "json")
    .action(
      withExit(async (opts?: { scope?: string; task?: string; format?: string }) => {
        const store = requireStore(b.loomStore);
        const brief = buildLoomBrief(
          { loomStore: store },
          { scope: opts?.scope ?? "", task: opts?.task, maxChars: lc.brief.maxChars },
        );
        console.log(opts?.format === "md" ? renderLoomBriefMarkdown(brief) : JSON.stringify(brief, null, 2));
      }),
    );
  loom
    .command("report")
    .description("Loom dashboard report for human review.")
    .option("--format <fmt>", "html|md", "md")
    .option("--scope <scope>", "workspace|repo")
    .option("--output <path>", "Write to path, or - for stdout", "-")
    .action(
      withExit(async (opts?: { format?: string; output?: string }) => {
        const store = requireStore(b.loomStore);
        const report = buildLoomReport(
          { factsDb: b.factsDb, loomStore: store, serendipityStore: b.serendipityStore },
          { maxItemsPerSection: lc.report.maxItemsPerSection },
        );
        const text = opts?.format === "html" ? renderLoomReportHtml(report) : renderLoomReportMarkdown(report);
        writeOut(text, opts?.output);
      }),
    );
}
