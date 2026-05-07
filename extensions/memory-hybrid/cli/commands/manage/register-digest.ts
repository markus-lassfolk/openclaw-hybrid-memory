/**
 * CLI registration for `manage digest` command (Issue #1197).
 *
 * Surfaces pending backlogs across all proposal/crystallization/reification stores:
 * persona proposals, tool proposals, crystallization proposals, and procedure backlogs.
 *
 * Format options: --format md|json (default: md).
 * Output options: --out - (stdout, default) or --out <path>.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ProposalsDB } from "../../../backends/proposals-db.js";
import { ToolProposalStore } from "../../../backends/tool-proposal-store.js";
import { CrystallizationStore } from "../../../backends/crystallization-store.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

function relativeTime(epochSec: number): string {
  const diffMs = Date.now() / 1000 - epochSec;
  if (diffMs < 60) return "just now";
  const mins = Math.floor(diffMs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function buildDigestReport(
  b: ManageBindings,
  proposalsDb: ProposalsDB | null,
): {
  md: string;
  json: Record<string, unknown>;
} {
  const { factsDb, cfg } = b;

  // 1. Persona proposals
  const personaPending = proposalsDb?.list({ status: "pending" }) ?? [];
  const personaApproved = proposalsDb?.list({ status: "approved" }) ?? [];
  const personaRejected = proposalsDb?.list({ status: "rejected" }) ?? [];
  const personaExpired = proposalsDb?.list({ status: "expired" }) ?? [];

  // 2. Procedures backlog
  const proceduresTotal = factsDb.proceduresCount();
  const proceduresValidated = factsDb.proceduresValidatedCount();
  const proceduresPromoted = factsDb.proceduresPromotedCount();
  const validatedNotPromoted = Math.max(0, proceduresValidated - proceduresPromoted);

  // 3. Tool proposals
  let toolProposed = 0;
  let toolApproved = 0;
  let toolRejected = 0;
  const toolDbPath = join(dirname(cfg.sqlitePath), "tool-proposals.db");
  let toolStore: ToolProposalStore | null = null;
  try {
    toolStore = new ToolProposalStore(toolDbPath);
    toolProposed = toolStore.count("proposed");
    toolApproved = toolStore.count("approved");
    toolRejected = toolStore.count("rejected");
  } catch {
    // tool-proposals.db may not exist yet
  }

  // 4. Crystallization proposals
  let crystalPending = 0;
  let crystalApproved = 0;
  let crystalRejected = 0;
  const crystalDbPath = join(dirname(cfg.sqlitePath), "crystallization.db");
  let crystalStore: CrystallizationStore | null = null;
  try {
    crystalStore = new CrystallizationStore(crystalDbPath);
    crystalPending = crystalStore.list({ status: "pending" }).length;
    crystalApproved = crystalStore.list({ status: "approved" }).length;
    crystalRejected = crystalStore.list({ status: "rejected" }).length;
  } catch {
    // crystallization.db may not exist yet
  }

  // Build sections
  const sections: Array<{ heading: string; body: string; badge: string }> = [];

  // --- Procedures ---
  sections.push({
    heading: "Procedures",
    badge: validatedNotPromoted > 0 ? `⚠️ ${validatedNotPromoted} need promotion` : "✅ all promoted",
    body: [
      `Total: ${proceduresTotal}`,
      `Validated: ${proceduresValidated}`,
      `Promoted: ${proceduresPromoted}`,
      validatedNotPromoted > 0 ? `⚠️ Validated-not-promoted: ${validatedNotPromoted}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  // --- Persona proposals ---
  if (cfg.personaProposals.enabled && proposalsDb) {
    sections.push({
      heading: "Persona Proposals",
      badge: `${personaPending.length} pending`,
      body: [
        `Enabled: yes`,
        `Pending: ${personaPending.length}`,
        `Approved: ${personaApproved.length}`,
        `Rejected: ${personaRejected.length}`,
        personaExpired.length > 0 ? `Expired: ${personaExpired.length}` : null,
        personaPending.length > 0
          ? [
              "",
              "Pending (newest first):",
              ...personaPending
                .slice(0, 5)
                .map(
                  (p) =>
                    `  • [${p.targetFile}] "${p.title}" — ${relativeTime(p.createdAt)} (confidence ${(p.confidence * 100).toFixed(0)}%)`,
                ),
              personaPending.length > 5 ? `  … and ${personaPending.length - 5} more` : null,
            ].filter(Boolean)
          : null,
      ]
        .flat()
        .filter(Boolean)
        .join("\n"),
    });
  } else {
    sections.push({
      heading: "Persona Proposals",
      badge: "disabled",
      body: "personaProposals.enabled = false",
    });
  }

  // --- Tool proposals ---
  sections.push({
    heading: "Tool Proposals",
    badge: `${toolProposed} pending`,
    body: [
      toolStore ? `DB: ${toolDbPath}` : "DB: not found",
      `Proposed: ${toolProposed}`,
      `Approved: ${toolApproved}`,
      `Rejected: ${toolRejected}`,
    ].join("\n"),
  });

  // --- Crystallization ---
  sections.push({
    heading: "Skill Crystallization",
    badge: `${crystalPending} pending`,
    body: [
      crystalStore ? `DB: ${crystalDbPath}` : "DB: not found",
      `Pending: ${crystalPending}`,
      `Approved: ${crystalApproved}`,
      `Rejected: ${crystalRejected}`,
    ].join("\n"),
  });

  const md = [
    `# Pending Digest — ${new Date().toISOString().split("T")[0]}`,
    "",
    ...sections.flatMap((s) => [`## ${s.heading}`, "", s.body, "", `> ${s.badge}`, ""]),
  ].join("\n");

  const json = {
    generatedAt: new Date().toISOString(),
    procedures: {
      total: proceduresTotal,
      validated: proceduresValidated,
      promoted: proceduresPromoted,
      validatedNotPromoted,
    },
    personaProposals: {
      enabled: cfg.personaProposals.enabled,
      pending: personaPending.length,
      approved: personaApproved.length,
      rejected: personaRejected.length,
      expired: personaExpired.length,
      pendingEntries: personaPending.slice(0, 10).map((p) => ({
        id: p.id,
        title: p.title,
        targetFile: p.targetFile,
        confidence: p.confidence,
        createdAt: p.createdAt,
      })),
    },
    toolProposals: {
      proposed: toolProposed,
      approved: toolApproved,
      rejected: toolRejected,
    },
    crystallization: {
      pending: crystalPending,
      approved: crystalApproved,
      rejected: crystalRejected,
    },
  };

  return { md, json };
}

export function registerManageDigest(mem: Chainable, b: ManageBindings): void {
  const { cfg } = b;

  // proposalsDb may not be in bindings — open directly
  let proposalsDb: ProposalsDB | null = null;
  if (cfg.personaProposals.enabled) {
    try {
      const path = join(dirname(cfg.sqlitePath), "proposals.db");
      proposalsDb = new ProposalsDB(path);
    } catch {
      // not initialised yet
    }
  }

  const digest = mem
    .command("digest")
    .description("Surface pending backlogs across all proposal/crystallization/reification stores (Issue #1197).");

  digest
    .command("pending")
    .description("Show pending backlogs: procedures, persona proposals, tool proposals, crystallization.")
    .option("--format <fmt>", "Output format: md or json (default: md)")
    .option("--out <path>", "Output file path, or '-' for stdout (default: -)")
    .action(
      withExit(async (opts?: { format?: string; out?: string }) => {
        const format = opts?.format ?? "md";
        const outPath = opts?.out ?? "-";

        const { md, json } = buildDigestReport(b, proposalsDb);

        if (format === "json") {
          const output = JSON.stringify(json, null, 2);
          if (outPath === "-") {
            process.stdout.write(output + "\n");
          } else {
            writeFileSync(outPath, output, "utf-8");
            console.log(`Written: ${outPath}`);
          }
        } else {
          // markdown (default)
          if (outPath === "-") {
            process.stdout.write(md + "\n");
          } else {
            writeFileSync(outPath, md, "utf-8");
            console.log(`Written: ${outPath}`);
          }
        }
      }),
    );
}
