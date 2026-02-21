/**
 * Cron job definitions for memory-hybrid plugin.
 * These jobs are created during install and can be restored via verify --fix.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type CronSchedule = { kind: "cron"; expr: string };

export interface PluginCronJob {
  /** Unique identifier for this job (used for matching existing jobs). */
  pluginJobId: string;
  /** Human-readable name for the job. */
  name: string;
  /** Cron schedule expression. */
  schedule: CronSchedule;
  /** Shell command to execute. */
  command: string;
  /** Optional feature gate config key (e.g. "reflection.enabled"). If set, job only runs if feature is enabled. */
  featureGate: string | null;
}

export const PLUGIN_CRON_JOBS: PluginCronJob[] = [
  {
    pluginJobId: "hybrid-mem:nightly-distill",
    name: "Nightly Distillation",
    schedule: { kind: "cron", expr: "0 2 * * *" },
    command: "hybrid-mem distill --days 3 && hybrid-mem record-distill",
    featureGate: null, // always runs
  },
  {
    pluginJobId: "hybrid-mem:weekly-deep-maintenance",
    name: "Weekly Deep Maintenance",
    schedule: { kind: "cron", expr: "0 4 * * 6" }, // Saturday 04:00
    command: "hybrid-mem extract-procedures && hybrid-mem extract-directives && hybrid-mem extract-reinforcement && hybrid-mem self-correction-run && hybrid-mem compact",
    featureGate: null,
  },
  {
    pluginJobId: "hybrid-mem:weekly-reflection",
    name: "Weekly Reflection",
    schedule: { kind: "cron", expr: "0 3 * * 0" }, // Sunday 03:00
    command: "hybrid-mem reflect && hybrid-mem reflect-rules && hybrid-mem reflect-meta",
    featureGate: "reflection.enabled",
  },
  {
    pluginJobId: "hybrid-mem:monthly-consolidation",
    name: "Monthly Consolidation",
    schedule: { kind: "cron", expr: "0 5 1 * *" }, // 1st of month 05:00
    command: "hybrid-mem consolidate && hybrid-mem build-languages && hybrid-mem generate-auto-skills && hybrid-mem backfill-decay",
    featureGate: null,
  },
];

function getCronJobsPath(): string {
  return join(homedir(), ".openclaw", "cron", "jobs.json");
}

interface CronJobEntry {
  pluginJobId?: string;
  name?: string;
  schedule?: CronSchedule;
  command?: string;
  enabled?: boolean;
  featureGate?: string | null;
  [key: string]: unknown;
}

function readCronJobs(): CronJobEntry[] {
  const path = getCronJobsPath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeCronJobs(jobs: CronJobEntry[]): void {
  const path = getCronJobsPath();
  const dir = join(homedir(), ".openclaw", "cron");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(jobs, null, 2) + "\n");
}

function findExisting(jobs: CronJobEntry[], pluginJob: PluginCronJob): CronJobEntry | undefined {
  return jobs.find(j =>
    j.pluginJobId === pluginJob.pluginJobId ||
    j.name === pluginJob.name
  );
}

/**
 * Ensure plugin cron jobs exist.
 * mode "install": create missing jobs (skip existing even if disabled — respect user choice)
 * mode "fix": create missing jobs AND re-enable disabled plugin jobs
 */
export function ensureCronJobs(mode: "install" | "fix"): { created: string[]; reEnabled: string[] } {
  const jobs = readCronJobs();
  const created: string[] = [];
  const reEnabled: string[] = [];

  for (const pluginJob of PLUGIN_CRON_JOBS) {
    const existing = findExisting(jobs, pluginJob);
    if (!existing) {
      jobs.push({
        pluginJobId: pluginJob.pluginJobId,
        name: pluginJob.name,
        schedule: pluginJob.schedule,
        command: pluginJob.command,
        enabled: true,
        featureGate: pluginJob.featureGate,
      });
      created.push(pluginJob.name);
    } else if (mode === "fix" && existing.enabled === false && existing.pluginJobId?.startsWith("hybrid-mem:")) {
      existing.enabled = true;
      reEnabled.push(pluginJob.name);
    }
  }

  if (created.length > 0 || reEnabled.length > 0) {
    writeCronJobs(jobs);
  }

  return { created, reEnabled };
}
