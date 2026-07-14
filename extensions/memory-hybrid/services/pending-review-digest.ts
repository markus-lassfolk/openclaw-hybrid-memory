import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { formatTimestampUtc, parseTimestamp } from "../utils/dates.js";
import { pluginLogger } from "../utils/logger.js";
import { summarizeSkillProposalValidation } from "./generated-skill-validation.js";
import { personaRuleRoutingMetrics } from "./persona-rule-router.js";

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
    /**
     * #1742: count of pending entries omitted from `pendingEntries` (by time-window filter or
     * the per-digest cap). When > 0, the digest renders an explicit truncation marker.
     */
    truncated: number;
    pendingEntries: Array<{
      id: string;
      title: string;
      targetFile: string;
      confidence: number;
      createdAt: number;
      /** Days since proposal was created. */
      ageDays: number;
      /** e.g. self-correction when title matches Self-correction: CATEGORY */
      sourceCategory: string | null;
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
    /** #2002: durable-rule router counters since process start. */
    metrics?: {
      routingSuggestions: number;
      dedupHits: number;
      contradictionHits: number;
      contradictionDegraded: number;
    };
    /** #2098: age-bucket hygiene over the FULL pending backlog (not just pendingEntries' cap). */
    ageHygiene: PendingQueueAgeHygiene;
  };
  toolProposals: {
    proposed: number;
    approved: number;
    rejected: number;
    proposedEntries: Array<{
      id: string;
      name: string;
      description: string;
      createdAt: string;
      /** Days since proposal was created (#2098). */
      ageDays: number;
      approveCommand: string;
      declineCommand: string;
    }>;
    ageHygiene: PendingQueueAgeHygiene;
  };
  crystallization: {
    pending: number;
    approved: number;
    rejected: number;
    pendingEntries: Array<{
      id: string;
      skillName: string;
      createdAt: string;
      /** Days since proposal was created (#2098). */
      ageDays: number;
      approveCommand: string;
      declineCommand: string;
      validation: string;
    }>;
    ageHygiene: PendingQueueAgeHygiene;
  };
  verifiedFacts: { pendingReview: number; reviewCommand: string };
  /** #2119: actionable serendipity backlog (present only when a store is supplied and enabled). */
  serendipity?: {
    enabled: boolean;
    actionableBacklog: number;
    byType: Record<string, number>;
    topEntries: Array<{
      id: string;
      title: string;
      findingType: string;
      riskLevel: string;
      ageDays: number;
      reviewCommand: string;
    }>;
  };
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

function withStore<TStore extends { close?: () => void }, T>(
  factory: () => TStore,
  fn: (store: TStore) => T,
  fallback: T,
): T {
  let store: TStore | null = null;
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

/** Age-bucket + oldest/newest + a plain-English triage hint for a pending queue (#2098). */
export type PendingQueueAgeHygiene = {
  ageBuckets: { d0_1: number; d1_7: number; d7_30: number; d30plus: number };
  oldestAgeDays: number | null;
  newestAgeDays: number | null;
  recommendedNextAction: string;
};

/**
 * Bucket a queue's per-item ages into 0-1d / 1-7d / 7-30d / 30d+ and derive a plain-English
 * triage hint. `queueLabel` and `reviewCommand` are folded into the hint so it reads as guidance,
 * not just a number — batch approve/reject/defer tooling is explicitly deferred (#2098), so this
 * stays informational rather than offering an action this digest can't yet perform.
 */
function computeQueueAgeHygiene(
  ageDaysList: number[],
  queueLabel: string,
  reviewCommand: string,
): PendingQueueAgeHygiene {
  const ageBuckets = { d0_1: 0, d1_7: 0, d7_30: 0, d30plus: 0 };
  for (const age of ageDaysList) {
    if (age <= 1) ageBuckets.d0_1++;
    else if (age <= 7) ageBuckets.d1_7++;
    else if (age <= 30) ageBuckets.d7_30++;
    else ageBuckets.d30plus++;
  }
  const total = ageDaysList.length;
  const oldestAgeDays = total > 0 ? Math.max(...ageDaysList) : null;
  const newestAgeDays = total > 0 ? Math.min(...ageDaysList) : null;

  let recommendedNextAction: string;
  if (total === 0) {
    recommendedNextAction = `${queueLabel} backlog is empty — nothing to review.`;
  } else if (ageBuckets.d30plus > 0) {
    recommendedNextAction = `${ageBuckets.d30plus} item(s) in ${queueLabel} are 30d+ old — review or reject the oldest first: ${reviewCommand}`;
  } else if (total > 50) {
    recommendedNextAction = `${queueLabel} backlog is large (${total}) — triage in batches via: ${reviewCommand}`;
  } else if (ageBuckets.d7_30 > 0) {
    recommendedNextAction = `${ageBuckets.d7_30} item(s) in ${queueLabel} are 7-30d old — review before they age further: ${reviewCommand}`;
  } else {
    recommendedNextAction = `${queueLabel} backlog is fresh (${total} pending, all under 7d) — no urgent action needed.`;
  }

  return { ageBuckets, oldestAgeDays, newestAgeDays, recommendedNextAction };
}

function _relativeTime(epochSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
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
  /** #2119: when supplied and serendipity is enabled, adds the actionable backlog section. */
  serendipityStore?: import("../backends/serendipity-store.js").SerendipityStore | null;
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
  const nowSec = Math.floor(now.getTime() / 1000);
  function selfCorrectionCategory(title: string): string | null {
    const m = title.match(/^Self-correction:\s*([A-Z_]+)/);
    return m?.[1] ?? null;
  }
  const personaPendingSorted = [...personaPending].sort((a, b) => {
    const aSc = selfCorrectionCategory(a.title) ? 0 : 1;
    const bSc = selfCorrectionCategory(b.title) ? 0 : 1;
    if (aSc !== bSc) return aSc - bSc;
    return b.createdAt - a.createdAt;
  });
  const personaRecentPending = personaPendingSorted.filter((p) => p.createdAt >= sinceSec);

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
  const crystalPending = crystalAll.filter((p) => p.status === "drafted" || p.status === "validated");
  const pendingReview = {
    persona: personaPending.length,
    procedures: validatedNotPromoted,
    tools: toolProposed.length,
    crystallization: crystalPending.length,
    verified: factsDb.countVerifiedFacts(),
  };

  function ageDaysFromIso(iso: string): number {
    // parseTimestamp (not raw `new Date()`) — same helper services/unified-proposals.ts uses for
    // these exact tool/crystallization createdAt fields, handling timestamp shapes (compact-date
    // digits, numeric epoch strings) a plain Date parse would silently reject as 0-age.
    const createdSec = parseTimestamp(iso);
    if (createdSec === null) return 0;
    return Math.max(0, Math.floor((nowSec - createdSec) / 86400));
  }
  const personaAgeDays = personaPending.map((p) => Math.max(0, Math.floor((nowSec - p.createdAt) / 86400)));
  const toolAgeDays = toolProposed.map((p) => ageDaysFromIso(p.createdAt));
  const crystalAgeDays = crystalPending.map((p) => ageDaysFromIso(p.createdAt));

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
    generatedAt: formatTimestampUtc(nowSec),
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
      expired: personaAll.filter((p) => p.status === "pending" && p.expiresAt != null && p.expiresAt < nowSec).length,
      // #1742: track omitted entries so callers can surface a truncation marker.
      truncated: personaPending.length - personaRecentPending.slice(0, 10).length,
      pendingEntries: personaRecentPending.slice(0, 10).map((p) => ({
        id: p.id,
        title: p.title,
        targetFile: p.targetFile,
        confidence: p.confidence,
        createdAt: p.createdAt,
        ageDays: Math.max(0, Math.floor((nowSec - p.createdAt) / 86400)),
        sourceCategory: selfCorrectionCategory(p.title),
        approveCommand: `openclaw hybrid-mem proposals approve ${p.id}`,
        declineCommand: `openclaw hybrid-mem proposals reject ${p.id}`,
        deferCommand: "openclaw hybrid-mem proposals list --status pending",
        evidence: evidenceForProposal(p.evidenceSessions ?? []),
      })),
      metrics: { ...personaRuleRoutingMetrics },
      ageHygiene: computeQueueAgeHygiene(
        personaAgeDays,
        "persona proposals",
        "openclaw hybrid-mem proposals list --status pending",
      ),
    },
    toolProposals: {
      proposed: toolProposed.length,
      approved: toolAll.filter((p) => p.status === "approved").length,
      rejected: toolAll.filter((p) => p.status === "rejected").length,
      proposedEntries: toolProposed.slice(0, 10).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: p.createdAt,
        ageDays: ageDaysFromIso(p.createdAt),
        approveCommand: `memory_tool_approve id=${p.id}`,
        declineCommand: `memory_tool_reject id=${p.id}`,
      })),
      ageHygiene: computeQueueAgeHygiene(toolAgeDays, "tool proposals", "openclaw hybrid-mem digest pending"),
    },
    crystallization: {
      pending: crystalPending.length,
      approved: crystalAll.filter((p) => p.status === "approved" || p.status === "installed").length,
      rejected: crystalAll.filter((p) => p.status === "rejected").length,
      pendingEntries: crystalPending.slice(0, 10).map((p) => ({
        id: p.id,
        skillName: p.skillName,
        createdAt: p.createdAt,
        ageDays: ageDaysFromIso(p.createdAt),
        approveCommand: `memory_crystallize_approve id=${p.id}`,
        declineCommand: `memory_crystallize_reject id=${p.id}`,
        validation: summarizeSkillProposalValidation(p.validationResult),
      })),
      ageHygiene: computeQueueAgeHygiene(
        crystalAgeDays,
        "crystallization proposals",
        "openclaw hybrid-mem skills queue",
      ),
    },
    verifiedFacts: {
      pendingReview: pendingReview.verified,
      reviewCommand: "openclaw hybrid-mem verified list",
    },
    ...(buildSerendipitySection(opts.serendipityStore, cfg, now) ?? {}),
  };
}

function buildSerendipitySection(
  store: import("../backends/serendipity-store.js").SerendipityStore | null | undefined,
  cfg: HybridMemoryConfig,
  now: Date,
): Pick<PendingReviewDigestReport, "serendipity"> | undefined {
  if (!store || !cfg.serendipityProtocol.enabled) return undefined;
  const actionable = store.listActionableDeferred({ level: 4 });
  const byType: Record<string, number> = {};
  for (const f of actionable) byType[f.findingType] = (byType[f.findingType] ?? 0) + 1;
  const nowMs = now.getTime();
  const topEntries = actionable.slice(0, 5).map((f) => ({
    id: f.id,
    title: f.title,
    findingType: f.findingType,
    riskLevel: f.riskLevel,
    ageDays: Math.max(0, Math.floor((nowMs - (parseTimestamp(f.createdAt) ?? 0) * 1000) / 86_400_000)),
    reviewCommand: `openclaw hybrid-mem serendipity show ${f.id.slice(0, 8)}`,
  }));
  return { serendipity: { enabled: true, actionableBacklog: actionable.length, byType, topEntries } };
}

/** Render one queue's age-bucket hygiene as a compact line + recommended action (#2098). */
function formatAgeHygieneLines(hygiene: PendingQueueAgeHygiene): string[] {
  const b = hygiene.ageBuckets;
  const lines = [`- Age: 0-1d=${b.d0_1}, 1-7d=${b.d1_7}, 7-30d=${b.d7_30}, 30d+=${b.d30plus}`];
  if (hygiene.oldestAgeDays != null) {
    lines.push(`- Oldest: ${hygiene.oldestAgeDays}d, newest: ${hygiene.newestAgeDays}d`);
  }
  lines.push(`- Next: ${hygiene.recommendedNextAction}`);
  return lines;
}

export function renderPendingReviewDigestMarkdown(report: PendingReviewDigestReport): string {
  const generated = report.generatedAt.slice(0, 10);
  const lines = [
    `# Hybrid-memory pending digest (${generated}, last ${report.sinceDays}d)`,
    "",
    `Pending review (proposals/procedures/tools/crystal/verified): ${report.pendingReview.persona}/${report.pendingReview.procedures}/${report.pendingReview.tools}/${report.pendingReview.crystallization}/${report.pendingReview.verified}`,
    "",
    `## Persona proposals (${report.personaProposals.pending})`,
    ...formatAgeHygieneLines(report.personaProposals.ageHygiene),
  ];
  if (report.personaProposals.pendingEntries.length === 0)
    lines.push("No recent pending persona proposals in this window.");
  report.personaProposals.pendingEntries.forEach((p, i) => {
    const categoryHint = p.sourceCategory ? ` [${p.sourceCategory}]` : "";
    lines.push(
      `${i + 1}. [pending ${p.ageDays}d${categoryHint}] ${p.title} (${p.targetFile}, confidence ${p.confidence.toFixed(2)})`,
    );
    lines.push(`   - Approve: ${p.approveCommand}`);
    lines.push(`   - Decline: ${p.declineCommand}`);
    lines.push(`   - Defer: ${p.deferCommand}`);
    if (p.evidence.facts > 0) {
      const sample = p.evidence.topFactIds.length > 0 ? ` (sample: ${p.evidence.topFactIds.join(", ")})` : "";
      lines.push(`   - Evidence: ${p.evidence.facts} fact(s)${sample}`);
    }
  });
  // #1742: when entries were omitted (time-window or cap), surface an explicit marker so
  // operators know the list is incomplete and how to see the full backlog.
  if (report.personaProposals.truncated > 0) {
    const shown = report.personaProposals.pendingEntries.length;
    const total = report.personaProposals.pending;
    lines.push(
      `_(Showing ${shown} of ${total} pending persona proposals; ${report.personaProposals.truncated} omitted — run \`openclaw hybrid-mem proposals list --status pending\` to list all.)_`,
    );
  }
  lines.push(
    "",
    `## Procedure promotions (${report.procedures.validatedNotPromoted} backlog, ${report.procedures.newThisWeek} new this week)`,
    "- Review: openclaw hybrid-mem procedures triage --not-promoted",
    "- Approve/promote: openclaw hybrid-mem generate-auto-skills",
    "- Defer: leave validated procedures unpromoted",
    "",
  );
  lines.push(
    `## Tool proposals (${report.toolProposals.proposed})`,
    ...formatAgeHygieneLines(report.toolProposals.ageHygiene),
  );
  if (report.toolProposals.proposedEntries.length === 0) lines.push("No pending tool proposals.");
  report.toolProposals.proposedEntries.forEach((p, i) => {
    lines.push(`${i + 1}. [pending ${p.ageDays}d] ${p.name} — ${p.description}`);
    lines.push(`   - Approve: ${p.approveCommand}`);
    lines.push(`   - Decline: ${p.declineCommand}`);
    lines.push("   - Defer: leave as proposed");
  });
  lines.push(
    "",
    `## Crystallization proposals (${report.crystallization.pending})`,
    ...formatAgeHygieneLines(report.crystallization.ageHygiene),
  );
  if (report.crystallization.pendingEntries.length === 0) lines.push("No pending crystallization proposals.");
  report.crystallization.pendingEntries.forEach((p, i) => {
    lines.push(`${i + 1}. [pending ${p.ageDays}d] ${p.skillName}`);
    lines.push(`   - Validation: ${p.validation}`);
    lines.push(`   - Approve: ${p.approveCommand}`);
    lines.push(`   - Decline: ${p.declineCommand}`);
    lines.push("   - Defer: leave pending");
  });
  lines.push(
    "",
    `## Verified-fact reviews (${report.verifiedFacts.pendingReview})`,
    `- Review: ${report.verifiedFacts.reviewCommand}`,
  );
  if (report.serendipity) {
    const byType =
      Object.entries(report.serendipity.byType)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "none";
    lines.push("", `## Serendipity backlog (${report.serendipity.actionableBacklog})`, `- By type: ${byType}`);
    report.serendipity.topEntries.forEach((e, i) => {
      lines.push(`${i + 1}. [${e.riskLevel}, ${e.ageDays}d] ${e.title} (${e.findingType}) — ${e.reviewCommand}`);
    });
  }
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
