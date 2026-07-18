/**
 * Loom dashboard/report for human review (Issue #2157). Redacted by default (evidence
 * capsules are already redacted at write time; this report never renders raw fact
 * text for lifecycle candidates, only ids + reasons). Each section: counts + top
 * examples, with stable IDs and suggested CLI commands for follow-up.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import { rankAttention } from "./attention-steward.js";
import { listLifecycleCandidates } from "./memory-lifecycle.js";
import { rankProcedureCandidates } from "./procedure-triage.js";

export interface LoomReportSectionCounts {
  attention: number;
  openLoops: number;
  staleOrContradictedBeliefs: number;
  evidenceCapsules: number;
  driftFindings: number;
  procedureCandidates: number;
  serendipityFindings: number;
  lifecycleCandidates: number;
}

export interface LoomReport {
  generatedAt: string;
  counts: LoomReportSectionCounts;
  topAttention: ReturnType<typeof rankAttention>["items"];
  openLoopsByStatus: Record<string, number>;
  openLoops: ReturnType<LoomStore["listOpenLoops"]>;
  staleOrContradictedBeliefs: ReturnType<LoomStore["listClaims"]>;
  recentEvidence: ReturnType<LoomStore["listEvidenceCapsules"]>;
  driftFindings: ReturnType<LoomStore["listDriftFindings"]>;
  procedureCandidates: ReturnType<typeof rankProcedureCandidates>["recommendedBatch"];
  serendipityHighlights: Array<{ id: string; title: string; status: string; riskLevel: string }>;
  lifecycleCandidates: ReturnType<typeof listLifecycleCandidates>["candidates"];
}

export interface LoomReportDeps {
  factsDb: FactsDB;
  loomStore: LoomStore;
  serendipityStore?: SerendipityStore | null;
}

export function buildLoomReport(deps: LoomReportDeps, opts: { maxItemsPerSection: number }): LoomReport {
  const { factsDb, loomStore, serendipityStore } = deps;
  const n = opts.maxItemsPerSection;
  const db: DatabaseSync = factsDb.getRawDb();

  const attention = rankAttention({ loomStore, serendipityStore }, { limit: n });
  const openLoops = loomStore
    .listOpenLoops({ limit: 500 })
    .filter((l) => l.status !== "closed" && l.status !== "superseded");
  const openLoopsByStatus: Record<string, number> = {};
  for (const l of openLoops) openLoopsByStatus[l.status] = (openLoopsByStatus[l.status] ?? 0) + 1;

  const staleOrContradictedBeliefs = loomStore.listClaims({ status: ["stale", "contradicted"], limit: 500 });
  const recentEvidence = loomStore.listEvidenceCapsules({ limit: n });
  const driftFindings = loomStore.listDriftFindings({ status: ["open", "acknowledged"], limit: 500 });
  const procedureCandidates = rankProcedureCandidates({ db, loomStore }, { batchSize: n }).recommendedBatch;

  const serendipityHighlights = serendipityStore
    ? serendipityStore
        .list({ limit: 500 })
        .filter((f) => f.status === "observed" || f.status === "deferred")
        .slice(0, n)
        .map((f) => ({ id: f.id, title: f.title, status: f.status, riskLevel: f.riskLevel }))
    : [];

  const lifecycleCandidates = listLifecycleCandidates({ factsDb, loomStore }, { limit: 500 }).candidates;

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      attention: attention.totalConsidered,
      openLoops: openLoops.length,
      staleOrContradictedBeliefs: staleOrContradictedBeliefs.length,
      evidenceCapsules: loomStore.listEvidenceCapsules({ limit: 100_000 }).length,
      driftFindings: driftFindings.length,
      procedureCandidates: procedureCandidates.length,
      serendipityFindings: serendipityHighlights.length,
      lifecycleCandidates: lifecycleCandidates.length,
    },
    topAttention: attention.items.slice(0, n),
    openLoopsByStatus,
    openLoops: openLoops.slice(0, n),
    staleOrContradictedBeliefs: staleOrContradictedBeliefs.slice(0, n),
    recentEvidence: recentEvidence.slice(0, n),
    driftFindings: driftFindings.slice(0, n),
    procedureCandidates,
    serendipityHighlights,
    lifecycleCandidates: lifecycleCandidates.slice(0, n),
  };
}

export function renderLoomReportMarkdown(report: LoomReport): string {
  const lines: string[] = ["# Loom report", `_Generated ${report.generatedAt}_`, ""];

  lines.push("## Top attention items", `Total considered: ${report.counts.attention}`, "");
  for (const item of report.topAttention) {
    lines.push(
      `- [${item.category}] ${item.title} (${item.targetKind}, id \`${item.targetId.slice(0, 8)}\`, score ${item.score.toFixed(2)})`,
    );
  }

  lines.push("", `## Open loops (${report.counts.openLoops})`);
  for (const [status, count] of Object.entries(report.openLoopsByStatus)) lines.push(`- ${status}: ${count}`);
  lines.push("");
  for (const l of report.openLoops) {
    lines.push(`- [${l.status}] ${l.title} — \`openclaw hybrid-mem loops close ${l.id.slice(0, 8)}\``);
  }

  lines.push("", `## Stale / contradicted beliefs (${report.counts.staleOrContradictedBeliefs})`);
  for (const c of report.staleOrContradictedBeliefs) {
    lines.push(
      `- [${c.status}] ${c.entity} ${c.predicate} = ${c.value} — \`openclaw hybrid-mem belief explain ${c.id.slice(0, 8)}\``,
    );
  }

  lines.push("", `## Recent evidence capsules (${report.counts.evidenceCapsules})`);
  for (const e of report.recentEvidence) {
    lines.push(`- ${e.title} (${e.createdAt}) — \`openclaw hybrid-mem evidence show ${e.id.slice(0, 8)}\``);
  }

  lines.push("", `## Drift findings (${report.counts.driftFindings})`);
  for (const f of report.driftFindings) {
    lines.push(
      `- [${f.severity}/${f.repairability}] ${f.driftType}: ${f.oldText.slice(0, 100)} (id \`${f.id.slice(0, 8)}\`)`,
    );
  }

  lines.push("", `## Procedure promotion candidates (${report.counts.procedureCandidates})`);
  for (const p of report.procedureCandidates) {
    lines.push(`- [${p.recommendedAction}] ${p.taskPattern.slice(0, 80)} — ${p.why} (cluster \`${p.clusterId}\`)`);
  }

  lines.push("", `## Serendipity inbox highlights (${report.counts.serendipityFindings})`);
  for (const s of report.serendipityHighlights) {
    lines.push(`- [${s.status}] ${s.title} (risk ${s.riskLevel}, id \`${s.id.slice(0, 8)}\`)`);
  }

  lines.push("", `## Lifecycle / demotion candidates (${report.counts.lifecycleCandidates})`);
  for (const c of report.lifecycleCandidates) {
    lines.push(`- [${c.suggestedAction}] ${c.targetId.slice(0, 8)}: ${c.explanation}`);
  }

  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function section(title: string, count: number, rows: string[]): string {
  const body =
    rows.length > 0 ? `<ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>` : "<p><em>Nothing to show.</em></p>";
  return `<section><h2>${escapeHtml(title)} (${count})</h2>${body}</section>`;
}

export function renderLoomReportHtml(report: LoomReport): string {
  const style = `
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
    @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111; } a { color: #7cb7ff; } }
    h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; }
    ul { line-height: 1.6; } code { background: #8882; padding: 0 .3rem; border-radius: 3px; }
  `;
  const body = [
    `<h1>Loom report</h1><p><em>Generated ${escapeHtml(report.generatedAt)}</em></p>`,
    section(
      "Top attention items",
      report.counts.attention,
      report.topAttention.map(
        (i) =>
          `[${escapeHtml(i.category)}] ${escapeHtml(i.title)} (${i.targetKind}, <code>${i.targetId.slice(0, 8)}</code>)`,
      ),
    ),
    section(
      "Open loops",
      report.counts.openLoops,
      report.openLoops.map((l) => `[${l.status}] ${escapeHtml(l.title)}`),
    ),
    section(
      "Stale / contradicted beliefs",
      report.counts.staleOrContradictedBeliefs,
      report.staleOrContradictedBeliefs.map(
        (c) => `[${c.status}] ${escapeHtml(`${c.entity} ${c.predicate} = ${c.value}`)}`,
      ),
    ),
    section(
      "Recent evidence capsules",
      report.counts.evidenceCapsules,
      report.recentEvidence.map((e) => `${escapeHtml(e.title)} (${e.createdAt})`),
    ),
    section(
      "Drift findings",
      report.counts.driftFindings,
      report.driftFindings.map((f) => `[${f.severity}] ${escapeHtml(f.oldText.slice(0, 100))}`),
    ),
    section(
      "Procedure promotion candidates",
      report.counts.procedureCandidates,
      report.procedureCandidates.map(
        (p) => `[${p.recommendedAction}] ${escapeHtml(p.taskPattern.slice(0, 80))} — ${escapeHtml(p.why)}`,
      ),
    ),
    section(
      "Serendipity inbox highlights",
      report.counts.serendipityFindings,
      report.serendipityHighlights.map((s) => `[${s.status}] ${escapeHtml(s.title)}`),
    ),
    section(
      "Lifecycle / demotion candidates",
      report.counts.lifecycleCandidates,
      report.lifecycleCandidates.map((c) => `[${c.suggestedAction}] ${escapeHtml(c.explanation)}`),
    ),
  ].join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Loom report</title><style>${style}</style></head><body>${body}</body></html>`;
}
