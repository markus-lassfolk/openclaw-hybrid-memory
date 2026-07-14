/**
 * Serendipity digest (Issue #2119) — a compact, low-noise summary of findings
 * and the actionable deferred backlog. On-demand; not a dashboard to babysit.
 *
 * Report shape + render/write mirror services/pending-review-digest.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { SerendipityStore } from "../backends/serendipity-store.js";
import type {
  SerendipityFinding,
  SerendipityFindingType,
  SerendipityRiskLevel,
  SerendipityStatus,
} from "../types/serendipity-types.js";
import { nowIso, nowSec, parseTimestamp } from "../utils/dates.js";
import { pluginLogger } from "../utils/logger.js";

export interface SerendipityBacklogEntry {
  id: string;
  title: string;
  findingType: SerendipityFindingType;
  riskLevel: SerendipityRiskLevel;
  adjacency: string;
  suggestedAction: string;
  ageDays: number;
  repo?: string;
  resolveCommand: string;
}

export interface SerendipityDigestReport {
  schemaVersion: 1;
  generatedAt: string;
  sinceDays: number;
  totals: {
    total: number;
    byStatus: Partial<Record<SerendipityStatus, number>>;
    byType: Partial<Record<SerendipityFindingType, number>>;
    byRisk: Partial<Record<SerendipityRiskLevel, number>>;
  };
  backlog: {
    actionable: number;
    /** Age hygiene buckets for backlog items (days since created). */
    ageHygiene: { fresh0to1: number; recent1to7: number; aging7to30: number; stale30plus: number };
    recommendedNextAction: string;
    top: SerendipityBacklogEntry[];
  };
}

function ageDays(createdAtIso: string, referenceMs: number): number {
  const created = parseTimestamp(createdAtIso);
  if (created == null) return 0;
  return Math.max(0, Math.floor((referenceMs - created * 1000) / 86_400_000));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function buildSerendipityDigestReport(opts: {
  store: SerendipityStore;
  sinceDays: number;
  /** Level used to gate which backlog items are considered actionable (default 4 = show all). */
  level?: number;
  topLimit?: number;
}): SerendipityDigestReport {
  const { store, sinceDays } = opts;
  const level = opts.level ?? 4;
  const topLimit = opts.topLimit ?? 10;
  const generatedMs = nowSec() * 1000;
  const cutoffMs = generatedMs - sinceDays * 86_400_000;

  const all = store.list();
  const recent = sinceDays > 0 ? all.filter((f) => (parseTimestamp(f.createdAt) ?? 0) * 1000 >= cutoffMs) : all;

  const byStatus: Partial<Record<SerendipityStatus, number>> = {};
  const byType: Partial<Record<SerendipityFindingType, number>> = {};
  const byRisk: Partial<Record<SerendipityRiskLevel, number>> = {};
  for (const f of recent) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    byType[f.findingType] = (byType[f.findingType] ?? 0) + 1;
    byRisk[f.riskLevel] = (byRisk[f.riskLevel] ?? 0) + 1;
  }

  const actionable = store.listActionableDeferred({ level });
  const ageHygiene = { fresh0to1: 0, recent1to7: 0, aging7to30: 0, stale30plus: 0 };
  for (const f of actionable) {
    const d = ageDays(f.createdAt, generatedMs);
    if (d <= 1) ageHygiene.fresh0to1++;
    else if (d <= 7) ageHygiene.recent1to7++;
    else if (d <= 30) ageHygiene.aging7to30++;
    else ageHygiene.stale30plus++;
  }

  const recommendedNextAction =
    actionable.length === 0
      ? "Backlog is empty — nothing to revisit."
      : ageHygiene.stale30plus > 0
        ? `${ageHygiene.stale30plus} finding(s) have aged past 30 days — resolve or dismiss them.`
        : `${actionable.length} actionable finding(s) waiting — review the top items below.`;

  const top: SerendipityBacklogEntry[] = actionable.slice(0, topLimit).map((f: SerendipityFinding) => ({
    id: f.id,
    title: f.title,
    findingType: f.findingType,
    riskLevel: f.riskLevel,
    adjacency: f.adjacency,
    suggestedAction: f.suggestedAction,
    ageDays: ageDays(f.createdAt, generatedMs),
    repo: f.repo,
    resolveCommand: `openclaw hybrid-mem serendipity resolve ${shortId(f.id)} --status <fixed|filed|dismissed|deferred>`,
  }));

  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    sinceDays,
    totals: { total: recent.length, byStatus, byType, byRisk },
    backlog: { actionable: actionable.length, ageHygiene, recommendedNextAction, top },
  };
}

function countMap(map: Partial<Record<string, number>>): string {
  const entries = Object.entries(map).filter(([, v]) => (v ?? 0) > 0);
  if (entries.length === 0) return "none";
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

export function renderSerendipityDigestMarkdown(report: SerendipityDigestReport): string {
  const lines: string[] = [];
  lines.push(`# Serendipity digest`);
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Window: last ${report.sinceDays} day(s)`);
  lines.push(`- Findings in window: ${report.totals.total}`);
  lines.push("");
  lines.push(`## Totals`);
  lines.push(`- By status: ${countMap(report.totals.byStatus)}`);
  lines.push(`- By type: ${countMap(report.totals.byType)}`);
  lines.push(`- By risk: ${countMap(report.totals.byRisk)}`);
  lines.push("");
  lines.push(`## Actionable backlog (${report.backlog.actionable})`);
  const h = report.backlog.ageHygiene;
  lines.push(`- Age: 0–1d ${h.fresh0to1}, 1–7d ${h.recent1to7}, 7–30d ${h.aging7to30}, 30d+ ${h.stale30plus}`);
  lines.push(`- Next: ${report.backlog.recommendedNextAction}`);
  if (report.backlog.top.length > 0) {
    lines.push("");
    for (const e of report.backlog.top) {
      const repo = e.repo ? ` [${e.repo}]` : "";
      lines.push(`- **${e.title}**${repo} — ${e.findingType}, risk ${e.riskLevel}, ${e.adjacency}, ${e.ageDays}d old`);
      lines.push(`  - suggested: ${e.suggestedAction}; \`${e.resolveCommand}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function writeSerendipityDigestOutput(opts: {
  report: SerendipityDigestReport;
  format: "md" | "json";
  outPath: string;
}): void {
  const output =
    opts.format === "json" ? JSON.stringify(opts.report, null, 2) : renderSerendipityDigestMarkdown(opts.report);
  if (opts.outPath === "-") {
    process.stdout.write(`${output}\n`);
    return;
  }
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, output, "utf-8");
  pluginLogger.info(`Written: ${opts.outPath}`);
}
