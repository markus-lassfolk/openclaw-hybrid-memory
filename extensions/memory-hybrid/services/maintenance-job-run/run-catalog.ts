import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseJobRunEvents } from "./event-log.js";
import { resolveMaintenanceLogRoot } from "./artifact-paths.js";
import type { MaintenanceJobRunRecord, MaintenanceRunRollupSummary, OrchestratorRunSummary } from "./types.js";

export interface ListedMaintenanceRun {
  kind: "orchestrator" | "job";
  id: string;
  path: string;
  startedAt?: string;
  command?: string;
  semanticOutcome?: string;
  exitCode?: number;
}

function parseSinceMs(since: string): number {
  const m = since.match(/^(\d+)(h|d)$/i);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return unit === "h" ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
}

function walkDirs(root: string, out: string[]): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walkDirs(full, out);
      else out.push(full);
    } catch {
      /* skip */
    }
  }
}

export function listMaintenanceRuns(opts?: {
  logRoot?: string;
  openclawDir?: string;
  since?: string;
}): ListedMaintenanceRun[] {
  const logRoot = opts?.logRoot ?? resolveMaintenanceLogRoot(opts?.openclawDir);
  const sinceMs = Date.now() - parseSinceMs(opts?.since ?? "7d");
  const files: string[] = [];
  walkDirs(logRoot, files);
  const runs: ListedMaintenanceRun[] = [];

  for (const file of files) {
    try {
      const st = statSync(file);
      if (st.mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }

    if (file.endsWith(".summary.json") && !file.includes("/job-runs/")) {
      try {
        const summary = JSON.parse(readFileSync(file, "utf-8")) as OrchestratorRunSummary;
        runs.push({
          kind: "orchestrator",
          id: summary.runId,
          path: file,
          startedAt: summary.startedAt,
          exitCode: summary.exitCode,
        });
      } catch {
        /* skip */
      }
      continue;
    }

    if (file.endsWith("summary.json") && file.includes("/job-runs/")) {
      try {
        const record = JSON.parse(readFileSync(file, "utf-8")) as MaintenanceJobRunRecord;
        if (record.schemaVersion !== 1 || !record.jobRunId) continue;
        runs.push({
          kind: "job",
          id: record.jobRunId,
          path: file,
          startedAt: record.startedAt,
          command: record.command,
          semanticOutcome: record.semanticOutcome,
        });
      } catch {
        /* skip */
      }
    }
  }

  return runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export function findMaintenanceRunById(
  id: string,
  opts?: { logRoot?: string; openclawDir?: string; since?: string },
): ListedMaintenanceRun | null {
  const needle = id.toLowerCase();
  const runs = listMaintenanceRuns(opts);
  const exact = runs.find((r) => r.id.toLowerCase() === needle);
  if (exact) return exact;
  const prefixed = runs.filter((r) => r.id.toLowerCase().startsWith(needle));
  if (prefixed.length === 1) return prefixed[0]!;
  return null;
}

export function loadOrchestratorSummary(path: string): OrchestratorRunSummary | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as OrchestratorRunSummary;
  } catch {
    return null;
  }
}

export function loadJobRunSummary(path: string): MaintenanceJobRunRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MaintenanceJobRunRecord;
  } catch {
    return null;
  }
}

export function explainJobRun(record: MaintenanceJobRunRecord, eventsPath: string): {
  diagnosis: string;
  lastEvent?: string;
  resumeHint?: string;
} {
  const events = existsSync(eventsPath) ? parseJobRunEvents(readFileSync(eventsPath, "utf-8")) : [];
  const last = events.at(-1);
  const failedPhase = record.phases.find((p) => p.status === "failed");
  const parts: string[] = [];
  parts.push(`Command ${record.command} ended with semantic outcome ${record.semanticOutcome}.`);
  if (record.semanticReason) parts.push(record.semanticReason);
  if (failedPhase) parts.push(`Failed phase: ${failedPhase.name}${failedPhase.summary ? ` (${failedPhase.summary})` : ""}.`);
  if (record.progress) {
    parts.push(
      `Progress: ${record.progress.completedUnits}/${record.progress.totalUnits} ${record.progress.unitLabel}.`,
    );
  }
  const resumeHint =
    record.semanticOutcome === "partial" && record.resumeCommand
      ? `Resume with: ${record.resumeCommand}`
      : record.semanticOutcome === "partial"
        ? `openclaw hybrid-mem maintenance run resume ${record.jobRunId}`
        : undefined;
  return {
    diagnosis: parts.join(" "),
    lastEvent: last ? JSON.stringify(last) : undefined,
    resumeHint,
  };
}

export function resolveRunArtifacts(listed: ListedMaintenanceRun): Record<string, string | undefined> {
  if (listed.kind === "job") {
    const record = loadJobRunSummary(listed.path);
    if (!record) return { summary: listed.path };
    return {
      summary: record.artifactPaths.summary,
      events: record.artifactPaths.events,
      checkpoint: record.artifactPaths.checkpoint,
      report: record.artifactPaths.report,
    };
  }
  const base = listed.path.replace(/\.summary\.json$/, "");
  return {
    summary: listed.path,
    log: `${base}.log`,
    exit: `${base}.exit.txt`,
    validation: `${base}.validation.json`,
  };
}

export type { MaintenanceRunRollupSummary };
