/**
 * CLI: skill proposal queue (crystallization lifecycle).
 *
 * Commands:
 * - openclaw hybrid-mem skills queue
 * - openclaw hybrid-mem skills show <id>
 * - openclaw hybrid-mem skills validate <id>
 * - openclaw hybrid-mem skills install <id>
 */

import type { CrystallizationStatus } from "../backends/crystallization-store.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";
import { SkillValidator } from "../services/skill-validator.js";
import type { Chainable } from "./shared.js";
import { withExit } from "./shared.js";

type SkillsCliContext = {
  crystallizationStore?: CrystallizationStore | null;
  cfg: HybridMemoryConfig;
};

function requireStore(ctx: SkillsCliContext): CrystallizationStore {
  const store = ctx.crystallizationStore;
  if (!store) {
    throw new Error("Crystallization store is not available (plugin not fully initialized?)");
  }
  return store;
}

export function registerSkillsCommands(mem: Chainable, ctx: SkillsCliContext): void {
  const skills = mem.command("skills").description("Generated skill proposals (crystallization queue)");

  skills
    .command("queue")
    .description("List proposal cards in the approval queue")
    .option("--status <status>", "Filter by status (pending/drafted/validated/approved/installed/rejected/superseded)")
    .option("--limit <n>", "Limit results (default: 20)")
    .option("--json", "Print JSON")
    .action(
      withExit(async (opts: { status?: string; limit?: string; json?: boolean }) => {
        const store = requireStore(ctx);
        const limit = opts.limit ? Math.max(1, Math.min(100, Number(opts.limit))) : 20;
        const status = (opts.status as CrystallizationStatus | "pending" | "approved" | "rejected" | undefined) ?? undefined;
        const proposals = store.list({ status, limit });

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
          console.log(`[${p.status}] ${p.skillName}${observed}`);
          console.log(`  id: ${p.id}`);
          if (p.category) console.log(`  category: ${p.category}`);
          if (p.outputPath) console.log(`  output: ${p.outputPath}`);
          if (p.rejectionReason) console.log(`  rejected: ${p.rejectionReason}`);
          console.log("");
        }
      }),
    );

  skills!
    .command("show")
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

  skills!
    .command("validate")
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

  skills!
    .command("install")
    .description("Approve and install a proposal (writes SKILL.md to the skills directory)")
    .argument("<id>", "Proposal id")
    .option("--name <slug>", "Rename before install")
    .option("--category <category>", "Category override")
    .option("--recommended-output <type>", "Output type override (currently: 'SKILL.md only')", "SKILL.md only")
    .option("--json", "Print JSON")
    .action(
      withExit(async (id: string, opts: { name?: string; category?: string; recommendedOutput?: string; json?: boolean }) => {
        const store = requireStore(ctx);
        const proposer = new CrystallizationProposer(null, store, ctx.cfg.crystallization);
        const result = proposer.approveProposal(id, {
          name: opts.name,
          category: opts.category,
          recommendedOutput: opts.recommendedOutput === "SKILL.md only" ? "SKILL.md only" : "SKILL.md only",
        });
        if (opts.json) {
          console.log(JSON.stringify({ ok: result.success, ...result }, null, 2));
          if (!result.success) process.exitCode = 1;
          return;
        }
        console.log(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
        if (!result.success) process.exitCode = 1;
      }),
    );
}

