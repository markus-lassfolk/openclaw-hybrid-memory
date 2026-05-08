import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { pluginLogger } from "../utils/logger.js";

type FactsDbForPendingDigest = {
  proceduresCount(): number;
  proceduresValidatedCount(): number;
  proceduresPromotedCount(): number;
  countVerifiedFacts(): number;
  /**
   * Optional: count procedures whose `validated_at` falls within `[sinceSec, nowSec)` (#1197).
   * Used by `procedures.newThisWeek` in the digest. When unsupported, the digest reports 0.
   */
  proceduresValidatedSince?(sinceSec: number): number;
  /**
   * Optional: return the raw SQLite handle so the digest can resolve persona-proposal evidence
   * (#1197 — `evidence: { topFactIds, facts }`). Falls back to empty evidence when unsupported.
   */
  getRawDb?(): DatabaseSync | undefined | null;
};

export type PendingReviewCounts = {
  persona: number;
  procedures: number;
  tools: number;
  crystallization: number;
  verified: number;
};

export type PendingReviewDigestReport = {
  schemaVersion: 1;
  generatedAt: string;
  sinceDays: number;
  pendingReview: PendingReviewCounts;
  procedures: {
    total: number;
    validated: number;
    promoted: number;
    validatedNotPromoted: number;
    /** #1197: procedures whose `validated_at` is within `sinceDays`. */
    newThisWeek: number;
  };
  personaProposals: {
    enabled: boolean;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    pendingEntries: Array<{
      id: string;
      title: string;
      targetFile: string;
      confidence: number;
      createdAt: number;
      approveCommand: string;
      declineCommand: string;
      deferCommand: string;
      /**
       * #1197: top supporting facts derived from the proposal's `evidenceSessions`. Capped at
       * `topFactIds.length <= 5`; `facts` is the total count of supporting facts found across
       * those sessions (not just the truncated head).
       */
      evidence: { topFactIds: string[]; facts: number };
    }>;
  };
  toolProposals: {
    proposed: number;
    approved: number;
    rejected: number;
    proposedEntries: Array<{
      id: string;
      name: string;
      description: string;
      approveCommand: string;
      declineCommand: string;
    }>;
  };
  crystallization: {
    pending: number;
    approved: number;
    rejected: number;
    pendingEntries: Array<{ id: string; skillName: string; approveCommand: string; declineCommand: string }>;
  };
  verifiedFacts: { pendingReview: number; reviewCommand: string };
};

export function parsePendingDigestSinceDays(value?: string): number {
  if (!value) return 7;
  const m = value.trim().match(/^(\d+)([dhw])?$/i);
  if (!m) return 7;
  const n = Number.parseInt(m[1], 10);
  const unit = (m[2] ?? "d").toLowerCase();
  if (unit === "h") return Math.max(1, Math.ceil(n / 24));
  if (unit === "w") return n * 7;
  return Math.max(1, n);
}

export function pendingStorePaths(sqlitePath: string): {
  proposals: string;
  toolProposals: string;
  crystallization: string;
} {
  const base = dirname(sqlitePath);
  return {
    proposals: join(base, "proposals.db"),
    toolProposals: join(base, "tool-proposals.db"),
    crystallization: join(base, "crystallization-proposals.db"),
  };
}

function withStore<T>(factory: () => { close?: () => void }, fn: (store: any) => T, fallback: T): T {
  let store: { close?: () => void } | null = null;
  try {
    store = factory();
    return fn(store);
  } catch {
    return fallback;
  } finally {
    try {
      store?.close?.();
    } catch {
      // ignore close errors in operator digest helpers
    }
  }
}

export function countPendingReviewBacklogs(
  cfg: HybridMemoryConfig,
  factsDb: FactsDbForPendingDigest,
): PendingReviewCounts {
  const paths = pendingStorePaths(cfg.sqlitePath);
  const persona = cfg.personaProposals.enabled
    ? withStore(
        () => new ProposalsDB(paths.proposals),
        (store: ProposalsDB) => store.list({ status: "pending" }).length,
        0,
      )
    : 0;
  const tools = withStore(
    () => new ToolProposalStore(paths.toolProposals),
    (store: ToolProposalStore) => store.count("proposed"),
    0,
  );
  const crystallization = withStore(
    () => new CrystallizationStore(paths.crystallization),
    (store: CrystallizationStore) => store.count("pending"),
    0,
  );
  return {
    persona,
    procedures: Math.max(0, factsDb.proceduresValidatedCount() - factsDb.proceduresPromotedCount()),
    tools,
    crystallization,
    verified: factsDb.countVerifiedFacts(),
  };
}

function relativeTime(epochSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const diffSec = Math.max(0, nowSec - epochSec);
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function buildPendingReviewDigestReport(opts: {
  cfg: HybridMemoryConfig;
  factsDb: FactsDbForPendingDigest;
  since?: string;
  now?: Date;
}): PendingReviewDigestReport {
  const cfg = opts.cfg;
  const factsDb = opts.factsDb;
  const sinceDays = parsePendingDigestSinceDays(opts.since);
  const now = opts.now ?? new Date();
  const sinceSec = Math.floor(now.getTime() / 1000) - sinceDays * 24 * 3600;
  const paths = pendingStorePaths(cfg.sqlitePath);

  const personaAll = cfg.personaProposals.enabled
    ? withStore(
        () => new ProposalsDB(paths.proposals),
        (store: ProposalsDB) => store.list(),
        [],
      )
    : [];
  const personaPending = personaAll.filter((p) => p.status === "pending");
  const personaRecentPending = personaPending.filter((p) => p.createdAt >= sinceSec);

  const toolAll = withStore(
    () => new ToolProposalStore(paths.toolProposals),
    (store: ToolProposalStore) => store.list(),
    [],
  );
  const crystalAll = withStore(
    () => new CrystallizationStore(paths.crystallization),
    (store: CrystallizationStore) => store.list(),
    [],
  );

  const proceduresTotal = factsDb.proceduresCount();
  const proceduresValidated = factsDb.proceduresValidatedCount();
  const proceduresPromoted = factsDb.proceduresPromotedCount();
  const validatedNotPromoted = Math.max(0, proceduresValidated - proceduresPromoted);
  const proceduresNewThisWeek = factsDb.proceduresValidatedSince
    ? Math.max(0, factsDb.proceduresValidatedSince(sinceSec))
    : 0;
  const toolProposed = toolAll.filter((p) => p.status === "proposed");
  const crystalPending = crystalAll.filter((p) => p.status === "pending");
  const pendingReview = {
    persona: personaPending.length,
    procedures: validatedNotPromoted,
    tools: toolProposed.length,
    crystallization: crystalPending.length,
    verified: factsDb.countVerifiedFacts(),
  };

  // #1197: resolve persona-proposal evidence by joining `evidenceSessions` against
  // `facts.provenance_session`. Best-effort — empty when the FactsDB does not expose a raw db.
  const rawDb = factsDb.getRawDb?.();
  function evidenceForProposal(sessions: string[]): { topFactIds: string[]; facts: number } {
    if (!rawDb || sessions.length === 0) return { topFactIds: [], facts: 0 };
    try {
      const placeholders = sessions.map(() => "?").join(",");
      const rows = rawDb
        .prepare(
          `SELECT id FROM facts
           WHERE superseded_at IS NULL
             AND provenance_session IS NOT NULL
             AND provenance_session IN (${placeholders})
           ORDER BY COALESCE(importance, 0) DESC, created_at DESC
           LIMIT 50`,
        )
        .all(...sessions) as Array<{ id: string }>;
      return {
        topFactIds: rows.slice(0, 5).map((r) => r.id),
        facts: rows.length,
      };
    } catch {
      return { topFactIds: [], facts: 0 };
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sinceDays,
    pendingReview,
    procedures: {
      total: proceduresTotal,
      validated: proceduresValidated,
      promoted: proceduresPromoted,
      validatedNotPromoted,
      newThisWeek: proceduresNewThisWeek,
    },
    personaProposals: {
      enabled: cfg.personaProposals.enabled,
      pending: personaPending.length,
      approved: personaAll.filter((p) => p.status === "approved").length,
      rejected: personaAll.filter((p) => p.status === "rejected").length,
      expired: personaAll.filter((p) => p.status === "expired").length,
      pendingEntries: personaRecentPending.slice(0, 10).map((p) => ({
        id: p.id,
        title: p.title,
        targetFile: p.targetFile,
        confidence: p.confidence,
        createdAt: p.createdAt,
        approveCommand: `openclaw hybrid-mem proposals approve ${p.id}`,
        declineCommand: `openclaw hybrid-mem proposals reject ${p.id}`,
        deferCommand: `openclaw hybrid-mem proposals list --status pending`,
        evidence: evidenceForProposal(p.evidenceSessions ?? []),
      })),
    },
    toolProposals: {
      proposed: toolProposed.length,
      approved: toolAll.filter((p) => p.status === "approved").length,
      rejected: toolAll.filter((p) => p.status === "rejected").length,
      proposedEntries: toolProposed.slice(0, 10).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        approveCommand: `memory_tool_approve id=${p.id}`,
        declineCommand: `memory_tool_reject id=${p.id}`,
      })),
    },
    crystallization: {
      pending: crystalPending.length,
      approved: crystalAll.filter((p) => p.status === "approved").length,
      rejected: crystalAll.filter((p) => p.status === "rejected").length,
      pendingEntries: crystalPending.slice(0, 10).map((p) => ({
        id: p.id,
        skillName: p.skillName,
        approveCommand: `memory_crystallize_approve id=${p.id}`,
        declineCommand: `memory_crystallize_reject id=${p.id}`,
      })),
    },
    verifiedFacts: {
      pendingReview: pendingReview.verified,
      reviewCommand: "openclaw hybrid-mem verified list",
    },
  };
}

export function renderPendingReviewDigestMarkdown(report: PendingReviewDigestReport): string {
  const generated = report.generatedAt.slice(0, 10);
  const lines = [
    `# Hybrid-memory pending digest (${generated}, last ${report.sinceDays}d)`,
    "",
    `Pending review (proposals/procedures/tools/crystal/verified): ${report.pendingReview.persona}/${report.pendingReview.procedures}/${report.pendingReview.tools}/${report.pendingReview.crystallization}/${report.pendingReview.verified}`,
    "",
    `## Persona proposals (${report.personaProposals.pending})`,
  ];
  if (report.personaProposals.pendingEntries.length === 0)
    lines.push("No recent pending persona proposals in this window.");
  report.personaProposals.pendingEntries.forEach((p, i) => {
    lines.push(
      `${i + 1}. [proposed ${relativeTime(p.createdAt)}] ${p.title} (${p.targetFile}, confidence ${p.confidence.toFixed(2)})`,
    );
    lines.push(`   - Approve: ${p.approveCommand}`);
    lines.push(`   - Decline: ${p.declineCommand}`);
    lines.push(`   - Defer: ${p.deferCommand}`);
    if (p.evidence.facts > 0) {
      const sample = p.evidence.topFactIds.length > 0 ? ` (sample: ${p.evidence.topFactIds.join(", ")})` : "";
      lines.push(`   - Evidence: ${p.evidence.facts} fact(s)${sample}`);
    }
  });
  lines.push(
    "",
    `## Procedure promotions (${report.procedures.validatedNotPromoted} backlog, ${report.procedures.newThisWeek} new this week)`,
    `- Review: openclaw hybrid-mem procedures triage --not-promoted`,
    `- Approve/promote: openclaw hybrid-mem generate-auto-skills`,
    `- Defer: leave validated procedures unpromoted`,
    "",
  );
  lines.push(`## Tool proposals (${report.toolProposals.proposed})`);
  if (report.toolProposals.proposedEntries.length === 0) lines.push("No pending tool proposals.");
  report.toolProposals.proposedEntries.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name} — ${p.description}`);
    lines.push(`   - Approve: ${p.approveCommand}`);
    lines.push(`   - Decline: ${p.declineCommand}`);
    lines.push("   - Defer: leave as proposed");
  });
  lines.push("", `## Crystallization proposals (${report.crystallization.pending})`);
  if (report.crystallization.pendingEntries.length === 0) lines.push("No pending crystallization proposals.");
  report.crystallization.pendingEntries.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.skillName}`);
    lines.push(`   - Approve: ${p.approveCommand}`);
    lines.push(`   - Decline: ${p.declineCommand}`);
    lines.push("   - Defer: leave pending");
  });
  lines.push(
    "",
    `## Verified-fact reviews (${report.verifiedFacts.pendingReview})`,
    `- Review: ${report.verifiedFacts.reviewCommand}`,
  );
  return lines.join("\n");
}

export function writePendingReviewDigestOutput(opts: {
  report: PendingReviewDigestReport;
  format: "md" | "json";
  outPath: string;
}): void {
  const output =
    opts.format === "json" ? JSON.stringify(opts.report, null, 2) : renderPendingReviewDigestMarkdown(opts.report);
  if (opts.outPath === "-") {
    process.stdout.write(`${output}\n`);
    return;
  }
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, output, "utf-8");
  pluginLogger.info(`Written: ${opts.outPath}`);
}
