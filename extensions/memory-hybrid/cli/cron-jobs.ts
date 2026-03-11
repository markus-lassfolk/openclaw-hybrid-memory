/**
 * Cron job definitions for memory-hybrid plugin (shell-command form).
 *
 * **Canonical source:** The jobs actually created by install and verify --fix
 * are defined in handlers.ts as MAINTENANCE_CRON_JOBS (agent-run with messages).
 * This file provides the same 9 jobs as shell commands for reference or for
 * runners that execute CLI commands directly. See docs/CLI-REFERENCE.md and
 * docs/MAINTENANCE-TASKS-MATRIX.md.
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
    name: "nightly-memory-sweep",
    schedule: { kind: "cron", expr: "0 2 * * *" },
    command: "hybrid-mem prune && hybrid-mem distill --days 3 && hybrid-mem extract-daily && hybrid-mem resolve-contradictions && hybrid-mem record-distill",
    featureGate: null,
  },
  {
    pluginJobId: "hybrid-mem:self-correction-analysis",
    name: "self-correction-analysis",
    schedule: { kind: "cron", expr: "30 2 * * *" },
    command: "hybrid-mem self-correction-run",
    featureGate: null,
  },
  {
    pluginJobId: "hybrid-mem:nightly-memory-to-skills",
    name: "nightly-memory-to-skills",
    schedule: { kind: "cron", expr: "15 2 * * *" },
    command: "hybrid-mem skills-suggest",
    featureGate: "memoryToSkills.enabled",
  },
  {
    pluginJobId: "hybrid-mem:nightly-dream-cycle",
    name: "nightly-dream-cycle",
    schedule: { kind: "cron", expr: "45 2 * * *" },
    command: "hybrid-mem dream-cycle",
    featureGate: "nightlyCycle.enabled",
  },
  {
    pluginJobId: "hybrid-mem:weekly-reflection",
    name: "weekly-reflection",
    schedule: { kind: "cron", expr: "0 3 * * 0" },
    command: "hybrid-mem reflect --verbose && hybrid-mem reflect-rules --verbose && hybrid-mem reflect-meta --verbose",
    featureGate: "reflection.enabled",
  },
  {
    pluginJobId: "hybrid-mem:weekly-extract-procedures",
    name: "weekly-extract-procedures",
    schedule: { kind: "cron", expr: "0 4 * * 0" },
    command: "hybrid-mem extract-procedures --days 7 && hybrid-mem extract-directives --days 7 && hybrid-mem extract-reinforcement --days 7 && hybrid-mem generate-auto-skills",
    featureGate: null,
  },
  {
    pluginJobId: "hybrid-mem:weekly-deep-maintenance",
    name: "weekly-deep-maintenance",
    schedule: { kind: "cron", expr: "0 4 * * 6" },
    command: "hybrid-mem compact && hybrid-mem scope promote",
    featureGate: null,
  },
  {
    pluginJobId: "hybrid-mem:weekly-persona-proposals",
    name: "weekly-persona-proposals",
    schedule: { kind: "cron", expr: "0 10 * * 0" },
    command: "hybrid-mem generate-proposals",
    featureGate: "personaProposals.enabled",
  },
  {
    pluginJobId: "hybrid-mem:monthly-consolidation",
    name: "monthly-consolidation",
    schedule: { kind: "cron", expr: "0 5 1 * *" },
    command: "hybrid-mem consolidate --threshold 0.92 && hybrid-mem build-languages && hybrid-mem backfill-decay",
    featureGate: null,
  },
  {
    pluginJobId: "hybrid-mem:sensor-sweep-tier1",
    name: "sensor-sweep-tier1",
    schedule: { kind: "cron", expr: "0 */4 * * *" },
    command: "hybrid-mem sensor-sweep --tier 1 && hybrid-mem sensor-sweep --tier 2",
    featureGate: "sensorSweep.enabled",
  },
];
