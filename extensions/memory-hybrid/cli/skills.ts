/**
 * CLI: skill proposal queue (crystallization lifecycle) and generated-skill telemetry.
 *
 * Commands:
 * - hybrid-mem skills queue | show | validate | reject | install | telemetry …
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { CrystallizationQueueStatusFilter, CrystallizationStore } from "../backends/crystallization-store.js";
import {
  assertCrystallizationQueueStatusFilter,
  CRYSTALLIZATION_QUEUE_STATUS_FILTERS,
} from "../backends/crystallization-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";
import {
  summarizeSkillProposalValidation,
  type SkillProposalValidationResult,
} from "../services/generated-skill-validation.js";
import { GeneratedSkillLifecycleService } from "../services/generated-skill-lifecycle.js";
import { SkillValidator } from "../services/skill-validator.js";
import type { Chainable } from "./shared.js";
import { relativeTime, withExit } from "./shared.js";

type ArgumentChainable = {
  command(name: string): ArgumentChainable;
  argument(name: string, desc?: string): ArgumentChainable;
  description(desc: string): ArgumentChainable;
  option(flags: string, desc?: string, defaultValue?: unknown): ArgumentChainable;
  requiredOption(flags: string, desc?: string, defaultValue?: unknown): ArgumentChainable;
  action(fn: (...args: any[]) => void | Promise<void>): ArgumentChainable;
};

type SkillsCliContext = {
  crystallizationStore?: CrystallizationStore | null;
  cfg: HybridMemoryConfig;
  factsDb?: FactsDB | null;
};

function formatIso(ts: number | null | undefined): string {
  return typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString() : "never";
}

function formatRate(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a";
}

function requireStore(ctx: SkillsCliContext): CrystallizationStore {
  const store = ctx.crystallizationStore;
  if (!store) {
    throw new Error("Crystallization store is not available (plugin not fully initialized?)");
  }
  return store;
}

function formatProposalReadiness(p: { validationResult?: SkillProposalValidationResult }): string {
  const vr = p.validationResult;
  if (!vr) return " — validation: not run";
  if (vr.approvalDecision === "allow") return " — ready ✓";
  if (vr.approvalDecision === "allow-with-override") return " — needs override";
  if (vr.approvalDecision === "deny") return " — blocked (deny)";
  return ` — ${vr.approvalDecision}`;
}

export function registerSkillsCommands(mem: Chainable, ctx: SkillsCliContext): void {
  const skills = mem
    .command("skills")
    .description("Generated skill proposals (crystallization queue) and promoted-skill telemetry") as ArgumentChainable;

  const factsDb = ctx.factsDb ?? null;
  if (factsDb) {
    registerGeneratedSkillTelemetryCli(skills, factsDb);
  }

  const queue = skills.command("queue") as ArgumentChainable;

  queue
    .description("List proposal cards in the approval queue")
    .option(
      "--status <status>",
      `Filter: ${CRYSTALLIZATION_QUEUE_STATUS_FILTERS.join(", ")} (pending=drafted+validated, approved=approved+installed; ready=validated+allow; needs-override=validated+allow-with-override)`,
    )
    .option("--limit <n>", "Limit results (default: 20)")
    .option("--json", "Print JSON")
    .action(
      withExit(async (opts: { status?: string; limit?: string; json?: boolean }) => {
        const store = requireStore(ctx);
        const limit = opts.limit ? Math.max(1, Math.min(100, Number(opts.limit))) : 20;
        const status = (opts.status as CrystallizationQueueStatusFilter | undefined) ?? undefined;
        let proposals;
        try {
          assertCrystallizationQueueStatusFilter(opts.status);
          proposals = store.list({ status, limit });
        } catch (err) {
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, count: proposals.length, proposals }, null, 2));
          return;
        }

        if (proposals.length === 0) {
          console.log(status ? `No ${status} skill proposals found.` : "No skill proposals found.");
          return;
        }

        for (const p of proposals) {
          let observed = "";
          try {
            const snap = JSON.parse(p.patternSnapshot) as { totalCount?: number; successRate?: number };
            if (typeof snap.totalCount === "number") {
              observed = ` (${snap.totalCount} runs, ${Math.round((snap.successRate ?? 0) * 100)}% success)`;
            }
          } catch {
            // ignore
          }
          console.log(`[${p.status}] ${p.skillName}${observed}${formatProposalReadiness(p)}`);
          console.log(`  id: ${p.id}`);
          if (p.validationResult) {
            console.log(`  validation: ${summarizeSkillProposalValidation(p.validationResult)}`);
          }
          if (p.category) console.log(`  category: ${p.category}`);
          if (p.outputPath) console.log(`  output: ${p.outputPath}`);
          if (p.rejectionReason) console.log(`  rejected: ${p.rejectionReason}`);
          console.log("");
        }
      }),
    );

  (skills.command("show") as ArgumentChainable)
    .description("Show a single proposal card and draft content")
    .argument("<id>", "Proposal id")
    .option("--json", "Print JSON")
    .action(
      withExit(async (id: string, opts: { json?: boolean }) => {
        const store = requireStore(ctx);
        const proposal = store.getById(id);
        if (!proposal) {
          console.error(`Proposal '${id}' not found`);
          process.exitCode = 1;
          return;
        }

        let card: unknown = null;
        if (proposal.proposalCardJson) {
          try {
            card = JSON.parse(proposal.proposalCardJson);
          } catch {
            card = null;
          }
        }

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, proposal, card }, null, 2));
          return;
        }

        console.log(`[${proposal.status}] ${proposal.skillName}`);
        console.log(`id: ${proposal.id}`);
        console.log(`patternId: ${proposal.patternId}`);
        console.log(`evidenceHash: ${proposal.evidenceHash}`);
        if (proposal.category) console.log(`category: ${proposal.category}`);
        if (proposal.outputPath) console.log(`output: ${proposal.outputPath}`);
        if (proposal.rejectionReason) console.log(`rejection: ${proposal.rejectionReason}`);
        if (card) console.log(`card: ${JSON.stringify(card, null, 2)}`);
        console.log("");
        console.log(proposal.skillContent);
      }),
    );

  (skills.command("validate") as ArgumentChainable)
    .description("Run the static validator against the draft SKILL.md content")
    .argument("<id>", "Proposal id")
    .option("--json", "Print JSON")
    .action(
      withExit(async (id: string, opts: { json?: boolean }) => {
        const store = requireStore(ctx);
        const proposal = store.getById(id);
        if (!proposal) {
          console.error(`Proposal '${id}' not found`);
          process.exitCode = 1;
          return;
        }
        const validator = new SkillValidator();
        const result = validator.validate(proposal.skillContent);
        if (opts.json) {
          console.log(JSON.stringify({ ok: result.valid, proposalId: id, violations: result.violations }, null, 2));
        } else if (result.valid) {
          console.log(`✓ Valid (${id})`);
        } else {
          console.log(`✗ Invalid (${id})`);
          for (const v of result.violations) console.log(`  - ${v}`);
        }
        if (!result.valid) process.exitCode = 2;
      }),
    );

  (skills.command("reject") as ArgumentChainable)
    .description("Reject a crystallization proposal or permanently reject an installed generated skill")
    .argument("<target>", "Proposal id or generated skill name")
    .option("--reason <reason>", "Reason recorded for audit / operator rejection")
    .option("--json", "Print JSON")
    .action(
      withExit(async (target: string, opts?: { reason?: string; json?: boolean }) => {
        const proposal = ctx.crystallizationStore?.getById(target) ?? null;
        if (proposal) {
          const store = requireStore(ctx);
          const proposer = new CrystallizationProposer(null, store, ctx.cfg.crystallization);
          const result = proposer.rejectProposal(target, opts?.reason);
          if (opts?.json) {
            console.log(JSON.stringify({ ok: result.success, ...result }, null, 2));
            if (!result.success) process.exitCode = 1;
            return;
          }
          console.log(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
          if (!result.success) process.exitCode = 1;
          return;
        }

        if (!factsDb) {
          console.error(`error: no proposal or generated skill found for '${target}'`);
          process.exitCode = 1;
          return;
        }
        const lifecycle = new GeneratedSkillLifecycleService(factsDb);
        const current = lifecycle.getSkill(target);
        if (!current) {
          console.error(`error: no proposal or generated skill found for '${target}'`);
          process.exitCode = 1;
          return;
        }
        const reason = opts?.reason?.trim();
        if (!reason) {
          console.error("error: --reason is required when rejecting an installed generated skill");
          process.exitCode = 1;
          return;
        }
        if (current.skillState === "rejected" || current.skillState === "uninstalled") {
          console.error(
            `error: skill '${target}' is in terminal state '${current.skillState}' — only installed, non-terminal skills can be rejected`,
          );
          process.exitCode = 1;
          return;
        }
        const updated = lifecycle.setState(target, "rejected", reason);
        if (!updated) {
          console.error(`error: generated skill not found: ${target}`);
          process.exitCode = 1;
          return;
        }
        if (opts?.json) {
          console.log(JSON.stringify(updated, null, 2));
          return;
        }
        console.log(`Rejected ${target}: ${updated.skillStateReason ?? "manual rejection"}`);
      }),
    );

  (skills.command("install") as ArgumentChainable)
    .description("Approve and install a proposal (writes SKILL.md to the skills directory)")
    .argument("<id>", "Proposal id")
    .option("--name <slug>", "Rename before install")
    .option("--category <category>", "Category override")
    .option("--description <text>", "Override proposal description (frontmatter + card)")
    .option("--recommended-output <type>", "Output type override (currently: 'SKILL.md only')", "SKILL.md only")
    .option("--override-warnings", "Approve proposals with activation warnings (explicit operator override)")
    .option("--json", "Print JSON")
    .action(
      withExit(
        async (
          id: string,
          opts: {
            name?: string;
            category?: string;
            description?: string;
            recommendedOutput?: string;
            overrideWarnings?: boolean;
            json?: boolean;
          },
        ) => {
          const store = requireStore(ctx);
          const proposer = new CrystallizationProposer(null, store, ctx.cfg.crystallization);
          const result = proposer.approveProposal(id, {
            name: opts.name,
            category: opts.category,
            description: opts.description,
            recommendedOutput: opts.recommendedOutput === "SKILL.md only" ? "SKILL.md only" : "SKILL.md only",
            overrideWarnings: opts.overrideWarnings === true,
          });
          if (opts.json) {
            console.log(JSON.stringify({ ok: result.success, ...result }, null, 2));
            if (!result.success) process.exitCode = 1;
            return;
          }
          console.log(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
          if (!result.success) process.exitCode = 1;
        },
      ),
    );
}

function registerGeneratedSkillTelemetryCli(skills: ArgumentChainable, factsDb: FactsDB): void {
  const lifecycle = new GeneratedSkillLifecycleService(factsDb);
  skills
    .command("telemetry [skillName]")
    .description("Report generated skill activation telemetry and lifecycle recommendations")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (skillName?: string, opts?: { json?: boolean }) => {
        const report = lifecycle.buildReport({
          skillName,
          recentActivationLimit: skillName ? 20 : 5,
        });
        if (!report || report.rows.length === 0) {
          if (opts?.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(
            skillName ? `No generated skill found for ${skillName}.` : "No generated skills have been promoted yet.",
          );
          return;
        }
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log("Generated skill telemetry");
        for (const row of report.rows) {
          console.log(
            `- ${row.skillName} state=${row.state} activations/week=${row.metrics.activationCountPerWeek} near-miss=${row.metrics.nearMissCount} false+=${row.metrics.falsePositiveSignals} false-=${row.metrics.falseNegativeSignals} lastUsed=${row.metrics.lastUsedAt ? relativeTime(row.metrics.lastUsedAt * 1000) : "never"} recommendation=${row.recommendation}`,
          );
          console.log(
            `  outcomes: success=${formatRate(row.metrics.successRate)} failure=${formatRate(row.metrics.failureRate)} partial=${formatRate(row.metrics.partialRate)} corrections=${row.metrics.repeatedCorrectionCount} generatedAt=${formatIso(row.generatedAt)}`,
          );
          if (row.stateReason) console.log(`  stateReason: ${row.stateReason}`);
          if (row.flags.overTriggering || row.flags.archiveCandidate || row.flags.revisionCandidate) {
            const flags = [
              row.flags.overTriggering ? "over-triggering" : null,
              row.flags.archiveCandidate ? "archive-candidate" : null,
              row.flags.revisionCandidate ? "revise-trigger" : null,
            ].filter((flag): flag is string => flag != null);
            if (flags.length > 0) console.log(`  flags: ${flags.join(", ")}`);
          }
          if (skillName && row.recentActivations.length > 0) {
            console.log("  recent activations:");
            for (const activation of row.recentActivations) {
              console.log(
                `    ${activation.id} ${activation.decision} outcome=${activation.taskOutcome ?? "unknown"} correction=${activation.userCorrection ? "yes" : "no"} at=${formatIso(activation.createdAt)}${activation.requestSummary ? ` request="${activation.requestSummary}"` : ""}`,
              );
            }
          }
        }
      }),
    );

  skills
    .command("record <skillName>")
    .description("Record a generated skill activation or near-miss decision")
    .option("--decision <decision>", "selected, considered, or skipped", "selected")
    .option("--request-summary <summary>", "Redacted request summary")
    .option("--request-hash <hash>", "Optional request hash override")
    .option("--confidence <value>", "Selection confidence (0-1)")
    .option("--reason <reason>", "Why the skill was selected or skipped")
    .option("--outcome <outcome>", "success, failure, partial, or unknown")
    .option("--false-positive", "Mark this activation as immediately corrected/rejected")
    .option("--false-negative", "Mark this near-miss as a false-negative signal")
    .option("--caused-rework", "Mark this activation as having caused rework")
    .option("--saved-tool-calls <n>", "Estimate tool calls saved")
    .option("--saved-time-ms <n>", "Estimate milliseconds saved")
    .option("--scope <scope>", "global, user, agent, or session")
    .option("--scope-target <id>", "Scope target id")
    .option("--agent-id <id>", "Agent id")
    .option("--session-id <id>", "Session id")
    .option("--procedure-id <id>", "Procedure id to disambiguate skills with same basename")
    .option("--json", "Emit JSON")
    .action(
      withExit(
        async (
          skillName: string,
          opts?: {
            decision?: string;
            requestSummary?: string;
            requestHash?: string;
            confidence?: string;
            reason?: string;
            outcome?: string;
            falsePositive?: boolean;
            falseNegative?: boolean;
            causedRework?: boolean;
            savedToolCalls?: string;
            savedTimeMs?: string;
            scope?: string;
            scopeTarget?: string;
            agentId?: string;
            sessionId?: string;
            procedureId?: string;
            json?: boolean;
          },
        ) => {
          const decision = opts?.decision ?? "selected";
          if (!["selected", "considered", "skipped"].includes(decision)) {
            console.error(`error: invalid --decision: ${decision}`);
            process.exitCode = 1;
            return;
          }
          const outcome = opts?.outcome;
          if (outcome && !["success", "failure", "partial", "unknown"].includes(outcome)) {
            console.error(`error: invalid --outcome: ${outcome}`);
            process.exitCode = 1;
            return;
          }
          if (opts?.scope && !["global", "user", "agent", "session"].includes(opts.scope)) {
            console.error(`error: invalid --scope: ${opts.scope}`);
            process.exitCode = 1;
            return;
          }
          const confidence = opts?.confidence != null ? Number.parseFloat(opts.confidence) : null;
          if (
            opts?.confidence != null &&
            (confidence == null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
          ) {
            console.error("error: --confidence must be a number between 0 and 1");
            process.exitCode = 1;
            return;
          }
          const savedToolCalls = opts?.savedToolCalls != null ? Number.parseInt(opts.savedToolCalls, 10) : null;
          if (
            opts?.savedToolCalls != null &&
            (savedToolCalls == null || !Number.isFinite(savedToolCalls) || savedToolCalls < 0)
          ) {
            console.error("error: --saved-tool-calls must be a non-negative integer");
            process.exitCode = 1;
            return;
          }
          const savedTimeMs = opts?.savedTimeMs != null ? Number.parseInt(opts.savedTimeMs, 10) : null;
          if (opts?.savedTimeMs != null && (savedTimeMs == null || !Number.isFinite(savedTimeMs) || savedTimeMs < 0)) {
            console.error("error: --saved-time-ms must be a non-negative integer");
            process.exitCode = 1;
            return;
          }
          try {
            const activation = lifecycle.recordTelemetry({
              skillName,
              procedureId: opts?.procedureId,
              decision: decision as "selected" | "considered" | "skipped",
              requestSummary: opts?.requestSummary,
              requestHash: opts?.requestHash,
              confidence,
              reason: opts?.reason,
              taskOutcome: outcome as "success" | "failure" | "partial" | "unknown" | undefined,
              userCorrection: opts?.falsePositive,
              correctionReason: opts?.falsePositive ? (opts.reason ?? "user rejected skill") : undefined,
              falseNegativeSignal: opts?.falseNegative,
              causedRework: opts?.causedRework,
              savedToolCalls,
              savedTimeMs,
              scope: opts?.scope as "global" | "user" | "agent" | "session" | undefined,
              scopeTarget: opts?.scopeTarget,
              agentId: opts?.agentId,
              sessionId: opts?.sessionId,
            });
            if (!activation) {
              console.error("error: facts DB is not open");
              process.exitCode = 1;
              return;
            }
            const skill = factsDb.getGeneratedSkillByName(skillName, activation.procedureId);
            if (opts?.json) {
              console.log(JSON.stringify({ activation, skill }, null, 2));
              return;
            }
            console.log(
              `Recorded ${activation.decision} for ${activation.skillName} as ${activation.id} (state=${skill?.skillState ?? "experimental"})`,
            );
          } catch (err) {
            console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
          }
        },
      ),
    );

  skills
    .command("correct <activationId>")
    .description("Mark a specific generated skill activation as a false-positive")
    .requiredOption("--reason <reason>", "Why the user corrected or rejected the skill")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (activationId: string, opts?: { reason?: string; json?: boolean }) => {
        const activation = lifecycle.markFalsePositive(activationId, opts?.reason ?? "user correction");
        if (!activation) {
          console.error(`error: activation not found: ${activationId}`);
          process.exitCode = 1;
          return;
        }
        const skill = factsDb.getGeneratedSkillByName(activation.skillName, activation.procedureId);
        if (opts?.json) {
          console.log(JSON.stringify({ activation, skill }, null, 2));
          return;
        }
        console.log(
          `Marked activation ${activation.id} for ${activation.skillName} as false-positive (state=${skill?.skillState ?? "experimental"})`,
        );
      }),
    );

  skills
    .command("demote <skillName>")
    .description("Demote a generated skill that is over-triggering or otherwise unsafe")
    .requiredOption("--reason <reason>", "Operator reason for demotion")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (skillName: string, opts?: { reason?: string; json?: boolean }) => {
        const updated = lifecycle.setState(skillName, "demoted", opts?.reason ?? "manual demotion");
        if (!updated) {
          console.error(`error: generated skill not found: ${skillName}`);
          process.exitCode = 1;
          return;
        }
        if (opts?.json) {
          console.log(JSON.stringify(updated, null, 2));
          return;
        }
        console.log(`Demoted ${skillName}: ${updated.skillStateReason ?? "manual demotion"}`);
      }),
    );

  skills
    .command("reset <skillName>")
    .description(
      "Reset a demoted or archived skill back to experimental for a second chance.\nUse this when a skill was wrongly demoted or after agent behaviour has changed.",
    )
    .requiredOption("--reason <reason>", "Operator reason for the reset")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (skillName: string, opts?: { reason?: string; json?: boolean }) => {
        const current = lifecycle.getSkill(skillName);
        if (!current) {
          console.error(`error: generated skill not found: ${skillName}`);
          process.exitCode = 1;
          return;
        }
        if (
          current.skillState !== "demoted" &&
          current.skillState !== "archived" &&
          current.skillState !== "uninstalled"
        ) {
          console.error(
            `error: skill '${skillName}' is in state '${current.skillState ?? "experimental"}' — only demoted, archived, or uninstalled skills can be reset`,
          );
          process.exitCode = 1;
          return;
        }
        const updated = lifecycle.setState(skillName, "experimental", opts?.reason ?? "manual reset");
        if (!updated) {
          console.error(`error: generated skill not found: ${skillName}`);
          process.exitCode = 1;
          return;
        }
        if (opts?.json) {
          console.log(JSON.stringify(updated, null, 2));
          return;
        }
        console.log(`Reset ${skillName} to experimental: ${updated.skillStateReason ?? "manual reset"}`);
      }),
    );

  skills
    .command("doctor")
    .description(
      "Scan for generated skills whose SKILL.md no longer exists on disk.\n" +
        "Reports rows with missing files and optionally marks them as uninstalled.",
    )
    .option("--fix", "Mark missing skills as uninstalled in the DB")
    .option("--workspace <path>", "Workspace root used to resolve relative skill paths")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { fix?: boolean; workspace?: string; json?: boolean }) => {
        const report = lifecycle.reconcileDiskState({
          fix: opts?.fix === true,
          workspaceRoot: opts?.workspace,
        });
        if (!report) {
          console.error("error: facts DB is not open");
          process.exitCode = 1;
          return;
        }
        const failedCount = report.failedFixCount;
        if (opts?.fix && failedCount > 0) {
          process.exitCode = 2;
        }
        const outputReport = { ...report, failedCount, exitCode: process.exitCode ?? 0 };
        if (opts?.json) {
          console.log(JSON.stringify(outputReport, null, 2));
          return;
        }
        console.log(`Skills doctor: checked ${report.totalChecked} generated skill(s) at ${report.checkedAt}`);
        if (report.issues.length === 0) {
          console.log("✓ All generated skills found on disk.");
          return;
        }
        console.log(`\n⚠ ${report.issues.length} skill(s) missing on disk:`);
        for (const issue of report.issues) {
          console.log(`  [${issue.state}] ${issue.skillName}`);
          console.log(`    path: ${issue.skillPath}`);
          console.log(`    expected at: ${issue.resolvedAbsolutePath}`);
        }
        if (!opts?.fix) {
          console.log("\nRun with --fix to mark these as uninstalled in the DB.");
        } else {
          console.log(`\nMarked ${report.fixedCount} missing skill(s) as uninstalled.`);
          for (const issue of report.issues.filter((row) => row.fixed)) {
            console.log(`  fixed: ${issue.skillName} (${issue.procedureId})`);
          }
          if (failedCount > 0) {
            console.log(`  failed: ${failedCount} skill(s) could not be marked uninstalled.`);
          }
        }
      }),
    );
}
