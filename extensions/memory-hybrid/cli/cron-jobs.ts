/**
 * Cron job definitions for memory-hybrid plugin.
 * These jobs are created during install and can be restored via verify --fix.
 */

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
    command: "hybrid-mem distill --days 3",
    featureGate: null, // always runs
  },
  {
    pluginJobId: "hybrid-mem:weekly-deep-maintenance",
    name: "Weekly Deep Maintenance",
    schedule: { kind: "cron", expr: "0 4 * * 6" }, // Saturday 04:00
    command: "hybrid-mem extract-procedures && hybrid-mem extract-directives && hybrid-mem extract-reinforcement && hybrid-mem self-correction-run && hybrid-mem scope && hybrid-mem compact",
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
    command: "hybrid-mem consolidate && hybrid-mem build-languages && hybrid-mem backfill-decay",
    featureGate: null,
  },
];
