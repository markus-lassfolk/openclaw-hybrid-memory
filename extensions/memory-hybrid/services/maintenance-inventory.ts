import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { relativeTime } from "../cli/shared.js";
import { formatTimestampUtcFromMs, nowIso } from "../utils/dates.js";
import { execSync } from "../utils/process-runner.js";
import { readExitLedger, validateMaintenanceExecution } from "./cron-exit-validator.js";
import { getGuardFilePath, readGuardTimestampMs } from "./cron-guard.js";
import { HYBRID_MEM_CRON_DEFAULT_JOB_STEPS } from "./hybrid-mem-cron-default-job-steps.js";
import { isCanonicalMaintenanceLog, isUnderAuxiliaryDir } from "./maintenance-log-analyzer.js";
import { describeCronStoreLocation, readOpenClawCronStore } from "./openclaw-cron-store.js";

const HYBRID_MEM_PLUGIN_JOB_ID_PREFIX = "hybrid-mem:";
const GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID = "goal-stewardship-heartbeat";

type SchedulerKind = "gateway-cron" | "host-cron";
type CrontabStatus = "empty" | "present" | "unavailable";
type CronStoreStatus = "missing" | "present" | "invalid";

export interface MaintenanceInventoryJob {
  inventoryId: string;
  jobKey: string;
  name: string;
  pluginJobId?: string;
  scheduler: SchedulerKind;
  schedulerOwner: SchedulerKind;
  enabled: boolean;
  schedule: string | null;
  scheduleKind: "cron" | "every" | "macro" | "unknown";
  timezone: string | null;
  command?: string;
  prompt?: string;
  sourceRef: string;
  guardPath?: string;
  lastRunAt?: string;
  lastRunSource?: "artifact" | "gateway-state" | "guard";
  lastExitAt?: string;
  lastStatus?: string;
  lastLogPath?: string;
  lastExitPath?: string;
  logRoot?: string;
  collisionGroups: string[];
  lockKey?: string;
  /** Count of additional raw cron-store registrations that collapsed into this same job (set only
   * when > 0) — a genuine duplicate registration (not an alias/canonical pair, which intentionally
   * collapses), previously dropped with no signal anywhere in the report. */
  duplicateRawRegistrations?: number;
  mutates: {
    sqlite: boolean;
    lancedb: boolean;
    github: boolean;
    memoryFacts: boolean;
  };
}

export interface MaintenanceInventoryCollisionGroup {
  group: string;
  jobKeys: string[];
  inventoryIds: string[];
}

export interface MaintenanceInventoryReport {
  schemaVersion: 1;
  generatedAt: string;
  openclawDir: string;
  cronStorePath: string;
  logRoot: string;
  crontabStatus: CrontabStatus;
  crontabError?: string;
  cronStoreStatus: CronStoreStatus;
  cronStoreError?: string;
  /** Count of readdir/stat failures during the artifact scan (set only when > 0) — distinguishes
   * a genuine mid-scan IO/permission error from "this job has no logs," which otherwise look
   * identical downstream. */
  artifactScanErrors?: number;
  jobs: MaintenanceInventoryJob[];
  collisionGroups: MaintenanceInventoryCollisionGroup[];
}

interface MaintenanceJobCatalogEntry {
  jobKey: string;
  name: string;
  pluginJobId?: string;
  aliases: string[];
  lockKey?: string;
  collisionGroups: string[];
  mutates: MaintenanceInventoryJob["mutates"];
}

interface MaintenanceArtifacts {
  latestLogPath?: string;
  latestLogMtimeMs?: number;
  latestExitPath?: string;
  latestExitMtimeMs?: number;
}

interface MaintenanceInventoryOptions {
  crontabText?: string;
  crontabError?: string;
  cronStoreText?: string;
}

/**
 * Canonical inventory catalog keyed by human-facing maintenance job names.
 *
 * `pluginJobId` intentionally differs for some entries (for example
 * `nightly-memory-sweep` vs `hybrid-mem:nightly-distill`) because the gateway
 * cron store already uses those historical stable IDs. The inventory normalizes
 * back to the operator-facing job name while still exposing the stored ID.
 */
const MAINTENANCE_JOB_CATALOG: MaintenanceJobCatalogEntry[] = [
  {
    jobKey: "maintenance-nightly",
    name: "maintenance-nightly",
    pluginJobId: "hybrid-mem:maintenance-nightly",
    aliases: [],
    lockKey: "sqlite+lancedb",
    collisionGroups: ["sqlite-writer", "lancedb-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: true, github: false, memoryFacts: true },
  },
  {
    jobKey: "nightly-memory-sweep",
    name: "nightly-memory-sweep",
    pluginJobId: "hybrid-mem:nightly-distill",
    aliases: ["hybrid-mem:nightly-memory-sweep"],
    lockKey: "sqlite+lancedb",
    collisionGroups: ["sqlite-writer", "lancedb-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: true, github: false, memoryFacts: true },
  },
  {
    jobKey: "self-correction-analysis",
    name: "self-correction-analysis",
    pluginJobId: "hybrid-mem:self-correction-analysis",
    aliases: [],
    lockKey: "sqlite",
    collisionGroups: ["sqlite-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: true },
  },
  {
    jobKey: "weekly-reflection",
    name: "weekly-reflection",
    pluginJobId: "hybrid-mem:weekly-reflection",
    aliases: [],
    lockKey: "sqlite",
    collisionGroups: ["sqlite-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: true },
  },
  {
    jobKey: "weekly-extract-procedures",
    name: "weekly-extract-procedures",
    pluginJobId: "hybrid-mem:weekly-extract-procedures",
    aliases: [],
    lockKey: "sqlite",
    collisionGroups: ["sqlite-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: true },
  },
  {
    jobKey: "weekly-crystallization-skills-rescan",
    name: "weekly-crystallization-skills-rescan",
    pluginJobId: "hybrid-mem:weekly-crystallization-skills-rescan",
    aliases: [],
    // `openclaw hybrid-mem skills rescan` -> CrystallizationProposer.rescanInstalledSkills()
    // writes to the same CrystallizationStore sqlite file (crystallization_proposals table) that
    // weekly-persona-proposals' runCrystallizationProposalCycle() also writes to — a real
    // concurrent-write collision risk distinct from (and narrower than) the main facts.db.
    lockKey: "crystallization-sqlite",
    collisionGroups: ["crystallization-store-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: false },
  },
  {
    jobKey: "weekly-deep-maintenance",
    name: "weekly-deep-maintenance",
    pluginJobId: "hybrid-mem:weekly-deep-maintenance",
    aliases: [],
    lockKey: "sqlite+lancedb",
    collisionGroups: ["sqlite-writer", "lancedb-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: true, github: false, memoryFacts: true },
  },
  {
    jobKey: "weekly-persona-proposals",
    name: "weekly-persona-proposals",
    pluginJobId: "hybrid-mem:weekly-persona-proposals",
    aliases: [],
    lockKey: "sqlite",
    // Also shares the CrystallizationStore sqlite file with weekly-crystallization-skills-rescan
    // (see that entry's comment) — flagged separately from the main facts.db collision group.
    collisionGroups: ["sqlite-writer", "memory-facts-writer", "crystallization-store-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: true },
  },
  {
    jobKey: "monthly-consolidation",
    name: "monthly-consolidation",
    pluginJobId: "hybrid-mem:monthly-consolidation",
    aliases: [],
    lockKey: "sqlite",
    collisionGroups: ["sqlite-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: true },
  },
  {
    jobKey: "nightly-dream-cycle",
    name: "nightly-dream-cycle",
    pluginJobId: "hybrid-mem:nightly-dream-cycle",
    aliases: [],
    lockKey: "sqlite+lancedb",
    collisionGroups: ["sqlite-writer", "lancedb-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: true, github: false, memoryFacts: true },
  },
  {
    jobKey: "sensor-sweep",
    name: "sensor-sweep",
    pluginJobId: "hybrid-mem:sensor-sweep",
    aliases: ["hybrid-mem:weekly-sensor-sweep"],
    lockKey: "sqlite+lancedb",
    collisionGroups: ["sqlite-writer", "lancedb-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: true, github: false, memoryFacts: true },
  },
  {
    jobKey: "daily-lifecycle-sync",
    name: "daily-lifecycle-sync",
    pluginJobId: "hybrid-mem:daily-lifecycle-sync",
    aliases: [],
    lockKey: "sqlite",
    collisionGroups: ["sqlite-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: true },
  },
  {
    jobKey: "daily-storage-growth-sample",
    name: "daily-storage-growth-sample",
    pluginJobId: "hybrid-mem:daily-storage-growth-sample",
    aliases: [],
    lockKey: "sqlite",
    collisionGroups: ["sqlite-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: false },
  },
  {
    jobKey: "weekly-implicit-feedback-collapse",
    name: "weekly-implicit-feedback-collapse",
    pluginJobId: "hybrid-mem:weekly-implicit-feedback-collapse",
    aliases: [],
    lockKey: "sqlite",
    collisionGroups: ["sqlite-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: false, github: false, memoryFacts: true },
  },
  {
    jobKey: "weekly-vectordb-optimize-sunday",
    name: "weekly-vectordb-optimize-sunday",
    pluginJobId: "hybrid-mem:weekly-vectordb-optimize-sunday",
    aliases: [],
    lockKey: "lancedb",
    collisionGroups: ["lancedb-writer"],
    mutates: { sqlite: false, lancedb: true, github: false, memoryFacts: false },
  },
  {
    jobKey: "weekly-audit-health",
    name: "weekly-audit-health",
    pluginJobId: "hybrid-mem:weekly-audit-health",
    aliases: [],
    lockKey: undefined,
    collisionGroups: [],
    mutates: { sqlite: false, lancedb: false, github: false, memoryFacts: false },
  },
  {
    jobKey: "weekly-pending-digest",
    name: "weekly-pending-digest",
    pluginJobId: "hybrid-mem:weekly-pending-digest",
    aliases: [],
    lockKey: undefined,
    collisionGroups: [],
    mutates: { sqlite: false, lancedb: false, github: false, memoryFacts: false },
  },
  {
    jobKey: "weekly-pending-digest-autopilot",
    name: "weekly-pending-digest-autopilot",
    pluginJobId: "hybrid-mem:weekly-pending-digest-autopilot",
    aliases: [],
    lockKey: undefined,
    collisionGroups: [],
    mutates: { sqlite: false, lancedb: false, github: false, memoryFacts: false },
  },
  {
    jobKey: "workshop-approval-reminder",
    name: "workshop-approval-reminder",
    pluginJobId: "hybrid-mem:workshop-approval-reminder",
    aliases: [],
    lockKey: undefined,
    collisionGroups: [],
    mutates: { sqlite: false, lancedb: false, github: false, memoryFacts: false },
  },
  {
    jobKey: "maintenance-log-analyzer",
    name: "maintenance-log-analyzer",
    pluginJobId: "hybrid-mem:maintenance-log-analyzer",
    aliases: [],
    lockKey: undefined,
    collisionGroups: [],
    mutates: { sqlite: false, lancedb: false, github: false, memoryFacts: false },
  },
  {
    jobKey: "nightly-doctor-repair",
    name: "nightly-doctor-repair",
    pluginJobId: "hybrid-mem:nightly-doctor-repair",
    aliases: [],
    lockKey: "sqlite+lancedb",
    collisionGroups: ["sqlite-writer", "lancedb-writer", "memory-facts-writer"],
    mutates: { sqlite: true, lancedb: true, github: false, memoryFacts: true },
  },
  {
    jobKey: GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID,
    name: GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID,
    pluginJobId: GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID,
    aliases: [],
    lockKey: undefined,
    collisionGroups: [],
    mutates: { sqlite: false, lancedb: false, github: true, memoryFacts: false },
  },
];

const JOB_CATALOG_INDEX = new Map<string, MaintenanceJobCatalogEntry>();
for (const entry of MAINTENANCE_JOB_CATALOG) {
  JOB_CATALOG_INDEX.set(entry.jobKey, entry);
  JOB_CATALOG_INDEX.set(entry.name, entry);
  if (entry.pluginJobId) JOB_CATALOG_INDEX.set(entry.pluginJobId, entry);
  for (const alias of entry.aliases) JOB_CATALOG_INDEX.set(alias, entry);
}

function readExecErrorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return "";
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : String(stderr ?? "");
}

function readUserCrontab(): { text: string; status: CrontabStatus; error?: string } {
  try {
    const text = execSync("crontab -l", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const trimmed = text.trim();
    return { text, status: trimmed.length > 0 ? "present" : "empty" };
  } catch (error) {
    const stderr = readExecErrorStderr(error);
    if (/no crontab for/i.test(stderr)) {
      return { text: "", status: "empty" };
    }
    return {
      text: "",
      status: "unavailable",
      error: stderr.trim() || (error instanceof Error ? error.message : String(error)),
    };
  }
}

function extractMaintenanceJobName(file: string): string {
  const withoutExitSuffix = file.replace(/\.exit\.txt$/, "");
  const withoutLogSuffix = withoutExitSuffix.replace(/\.log$/, "");
  return withoutLogSuffix
    .replace(/-\d{8}T\d{6}Z-\d+$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/, "")
    .replace(/-\d{8}\.cron$/, "")
    .replace(/\.cron$/, "");
}

function extractRunIdFromFilename(file: string): string | null {
  const exitMatch = file.match(/^(.+)-(\d{8}T\d{6}Z-\d+)\.exit\.txt$/);
  if (exitMatch) return exitMatch[2];
  const logMatch = file.match(/^(.+)-(\d{8}T\d{6}Z-\d+)\.log$/);
  if (logMatch) return logMatch[2];
  const isoExitMatch = file.match(/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.exit\.txt$/);
  if (isoExitMatch) return isoExitMatch[2];
  const isoLogMatch = file.match(/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.log$/);
  if (isoLogMatch) return isoLogMatch[2];
  // Aggregate cron logs (<job>-YYYYMMDD.cron.log, or a single dateless <job>.cron.log) never carry
  // a per-run id in their filename — the file itself IS the run history (or one day's worth of
  // it), and extractMaintenanceJobName already strips this exact suffix pattern. Without a
  // matching branch here, every such file returned null and was silently dropped, so a job whose
  // only artifact format is .cron.log always showed as "never run" (QA follow-up).
  const dailyCronMatch = file.match(/^(.+)-(\d{8})\.cron\.log$/);
  if (dailyCronMatch) return `cron-${dailyCronMatch[2]}`;
  if (/\.cron\.log$/.test(file)) return "cron-aggregate";
  return null;
}

function scanLatestMaintenanceArtifacts(logRoot: string): {
  artifacts: Map<string, MaintenanceArtifacts>;
  scanErrors: number;
} {
  const artifacts = new Map<string, MaintenanceArtifacts>();
  if (!existsSync(logRoot)) {
    return { artifacts, scanErrors: 0 };
  }

  const runPairs = new Map<
    string,
    Map<string, { exitPath?: string; exitMtime?: number; logPath?: string; logMtime?: number }>
  >();

  let scanErrors = 0;
  const stack = [logRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      // Silent by design where the directory simply doesn't exist yet, but an IO/permission error
      // partway through the scan looks identical to "this job has no logs" downstream — track it
      // so the report can distinguish the two instead of always reading as healthy (QA follow-up).
      scanErrors++;
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        scanErrors++;
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (isUnderAuxiliaryDir(path, logRoot)) continue;

      const isExit = entry.endsWith(".exit.txt");
      const isLog = isCanonicalMaintenanceLog(path);
      if (!isExit && !isLog) continue;

      const jobName = extractMaintenanceJobName(basename(path));
      if (!jobName) continue;

      const runId = extractRunIdFromFilename(entry);
      if (!runId) continue;

      if (!runPairs.has(jobName)) {
        runPairs.set(jobName, new Map());
      }
      const jobRuns = runPairs.get(jobName);
      if (!jobRuns) continue;
      const currentRun = jobRuns.get(runId) ?? {};

      if (isExit) {
        currentRun.exitPath = path;
        currentRun.exitMtime = stat.mtimeMs;
      }
      if (isLog) {
        currentRun.logPath = path;
        currentRun.logMtime = stat.mtimeMs;
      }
      jobRuns.set(runId, currentRun);
    }
  }

  for (const [jobName, jobRuns] of runPairs) {
    // A fully paired run (known exit status) is always preferred over a newer-but-unpaired one —
    // an in-progress or crashed run with no exit code yet is a less useful "last known state" than
    // an older run whose actual outcome is known. Only fall back to the best available unpaired
    // run when the job has NO paired run at all (its very first run is still in progress, or its
    // only artifact format — e.g. an aggregate .cron.log — never produces a sibling .exit.txt) so
    // such a job still surfaces as having run at all, instead of always reading as "never" (QA
    // follow-up).
    let latestPair: MaintenanceArtifacts | undefined;
    let latestPairMtime = -1;
    let latestAny: MaintenanceArtifacts | undefined;
    let latestAnyMtime = -1;

    for (const run of jobRuns.values()) {
      const runMtime = Math.max(run.exitMtime ?? 0, run.logMtime ?? 0);
      if (runMtime > latestAnyMtime) {
        latestAnyMtime = runMtime;
        latestAny = {
          latestExitPath: run.exitPath,
          latestExitMtimeMs: run.exitMtime,
          latestLogPath: run.logPath,
          latestLogMtimeMs: run.logMtime,
        };
      }
      if (run.exitPath && run.logPath && runMtime > latestPairMtime) {
        latestPairMtime = runMtime;
        latestPair = {
          latestExitPath: run.exitPath,
          latestExitMtimeMs: run.exitMtime,
          latestLogPath: run.logPath,
          latestLogMtimeMs: run.logMtime,
        };
      }
    }

    const latest = latestPair ?? latestAny;
    if (latest) {
      artifacts.set(jobName, latest);
    }
  }

  return { artifacts, scanErrors };
}

function resolveCatalogEntry(...candidates: Array<string | undefined>): MaintenanceJobCatalogEntry | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.trim();
    if (!normalized) continue;
    const found = JOB_CATALOG_INDEX.get(normalized);
    if (found) return found;
  }
  return null;
}

/**
 * True when `rawJob` (a raw gateway cron job record, as returned by `readOpenClawCronStore`) is the
 * job identified by canonical id `pluginJobId` (e.g. "hybrid-mem:maintenance-nightly").
 *
 * `readOpenClawCronStore` normalizes SQLite-backed cron rows (2026.6.8+) to `job.id`/`job.name`;
 * it never sets `job.pluginJobId` (that field only appears on the legacy JSON store format). A
 * caller that only checks `job.pluginJobId === pluginJobId` therefore always misses on a modern
 * SQLite-backed install, even though the job is present under `job.id` (#2050). `job.id` is
 * sufficient here — `cron-jobs.ts` sets `id` to the same `pluginJobId` value at creation/normalize
 * time for every plugin-managed job — so this deliberately does NOT fall back to matching on the
 * job's plain `name` (unlike `parseGatewayJobs`'s `resolveCatalogEntry` below, which needs the
 * broader fallback for inventory's full-catalog display): a name-based fallback here would let an
 * unrelated, user-created cron job that merely happens to share a catalog job's `name` (e.g.
 * "maintenance-nightly") be reported as satisfying this health check.
 */
export function jobMatchesPluginJobId(rawJob: Record<string, unknown>, pluginJobId: string): boolean {
  const rawPluginJobId = typeof rawJob.pluginJobId === "string" ? rawJob.pluginJobId : undefined;
  const rawId = typeof rawJob.id === "string" ? rawJob.id : undefined;
  return rawPluginJobId === pluginJobId || rawId === pluginJobId;
}

function describeGatewaySchedule(schedule: unknown): {
  schedule: string | null;
  scheduleKind: MaintenanceInventoryJob["scheduleKind"];
  timezone: string | null;
} {
  if (typeof schedule === "string") {
    return { schedule, scheduleKind: "cron", timezone: "UTC" };
  }
  if (!schedule || typeof schedule !== "object") {
    return { schedule: null, scheduleKind: "unknown", timezone: null };
  }
  const record = schedule as Record<string, unknown>;
  if (record.kind === "cron") {
    return {
      schedule: typeof record.expr === "string" ? record.expr : null,
      scheduleKind: "cron",
      timezone: typeof record.tz === "string" ? record.tz : "UTC",
    };
  }
  if (record.kind === "every") {
    const everyMs = typeof record.everyMs === "number" ? record.everyMs : null;
    return {
      schedule: everyMs != null ? `every ${everyMs}ms` : "every",
      scheduleKind: "every",
      timezone: "interval",
    };
  }
  return { schedule: null, scheduleKind: "unknown", timezone: null };
}

function parseHostSchedule(line: string): {
  schedule: string;
  scheduleKind: MaintenanceInventoryJob["scheduleKind"];
  command: string;
} | null {
  const macroMatch = line.match(/^(@[A-Za-z0-9_-]+)\s+(.+)$/);
  if (macroMatch) {
    return { schedule: macroMatch[1], scheduleKind: "macro", command: macroMatch[2] };
  }
  const cronMatch = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (!cronMatch) return null;
  return { schedule: cronMatch[1], scheduleKind: "cron", command: cronMatch[2] };
}

function inferHostJobKey(command: string): string | null {
  const wrapperMatch = command.match(/hybrid-mem-cli-job\.sh\s+['"]?([a-z0-9-]+)['"]?/i);
  if (wrapperMatch) {
    return wrapperMatch[1].toLowerCase();
  }

  for (const entry of MAINTENANCE_JOB_CATALOG) {
    if (command.includes(`${entry.jobKey}.sh`)) {
      return entry.jobKey;
    }
  }

  return null;
}

function deriveArtifactStatus(
  entry: MaintenanceJobCatalogEntry,
  artifact: MaintenanceArtifacts | undefined,
  actualPluginJobId?: string,
): { lastStatus?: string; lastExitAt?: string } {
  if (!artifact?.latestExitPath) {
    return {};
  }
  const exitAt = artifact.latestExitMtimeMs ? formatTimestampUtcFromMs(artifact.latestExitMtimeMs) : undefined;
  const pluginJobIdForSteps = actualPluginJobId ?? entry.pluginJobId;
  const requiredSteps = pluginJobIdForSteps ? HYBRID_MEM_CRON_DEFAULT_JOB_STEPS[pluginJobIdForSteps] : undefined;
  if (requiredSteps && requiredSteps.length > 0 && artifact.latestLogPath) {
    const validation = validateMaintenanceExecution(
      artifact.latestExitPath,
      artifact.latestLogPath,
      requiredSteps,
      true,
    );
    return { lastStatus: validation.maintenanceStatus, lastExitAt: exitAt };
  }
  const steps = readExitLedger(artifact.latestExitPath);
  if (steps.some((step) => step.exitCode !== 0 || step.status === "failed")) {
    return { lastStatus: "failed", lastExitAt: exitAt };
  }
  if (steps.length > 0) {
    return { lastStatus: "success", lastExitAt: exitAt };
  }
  return { lastStatus: "empty-exit", lastExitAt: exitAt };
}

function pickLastRun(
  gatewayLastRunMs: number | null,
  guardMs: number | null,
  artifact: MaintenanceArtifacts | undefined,
): { lastRunAt?: string; lastRunSource?: MaintenanceInventoryJob["lastRunSource"] } {
  const candidates: Array<{ source: NonNullable<MaintenanceInventoryJob["lastRunSource"]>; ts: number }> = [];
  if (gatewayLastRunMs != null && Number.isFinite(gatewayLastRunMs)) {
    candidates.push({ source: "gateway-state", ts: gatewayLastRunMs });
  }
  if (guardMs != null && Number.isFinite(guardMs)) {
    candidates.push({ source: "guard", ts: guardMs });
  }
  const artifactTs = artifact?.latestExitMtimeMs ?? artifact?.latestLogMtimeMs;
  if (artifactTs != null && Number.isFinite(artifactTs)) {
    candidates.push({ source: "artifact", ts: artifactTs });
  }
  if (candidates.length === 0) {
    return {};
  }
  candidates.sort((a, b) => b.ts - a.ts);
  return {
    lastRunAt: formatTimestampUtcFromMs(candidates[0].ts),
    lastRunSource: candidates[0].source,
  };
}

function parseGatewayJobs(
  openclawDir: string,
  rawJobs: unknown[],
  artifacts: Map<string, MaintenanceArtifacts>,
): MaintenanceInventoryJob[] {
  const cronStoreDisplayPath = describeCronStoreLocation(openclawDir);
  const jobsByInventoryId = new Map<string, MaintenanceInventoryJob>();
  const rawPluginJobIdByInventoryId = new Map<string, string | undefined>();
  const duplicateCountByInventoryId = new Map<string, number>();
  for (const rawJob of rawJobs) {
    if (!rawJob || typeof rawJob !== "object") continue;
    const job = rawJob as Record<string, unknown>;
    const payload = job.payload as Record<string, unknown> | undefined;
    const name = typeof job.name === "string" ? job.name : "";
    const pluginJobId = typeof job.pluginJobId === "string" ? job.pluginJobId : undefined;
    const prompt =
      typeof payload?.message === "string"
        ? payload.message
        : typeof job.message === "string"
          ? job.message
          : undefined;

    const stewardshipHint = isGoalStewardshipHeartbeatJob(name, prompt) ? GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID : undefined;
    const entry = resolveCatalogEntry(pluginJobId, name, stewardshipHint);
    if (!entry) continue;

    const artifact = artifacts.get(entry.name) ?? (entry.pluginJobId ? artifacts.get(entry.pluginJobId) : undefined);
    const guardPath =
      entry.pluginJobId?.startsWith(HYBRID_MEM_PLUGIN_JOB_ID_PREFIX) || entry.jobKey === "nightly-memory-sweep"
        ? getGuardFilePath(entry.name, openclawDir)
        : undefined;
    const guardMs = guardPath ? readGuardTimestampMs(entry.name, openclawDir) : null;
    const schedule = describeGatewaySchedule(job.schedule);
    const state = job.state as { lastRunAtMs?: number; lastStatus?: string } | undefined;
    const lastRun = pickLastRun(typeof state?.lastRunAtMs === "number" ? state.lastRunAtMs : null, guardMs, artifact);
    const status = deriveArtifactStatus(entry, artifact, pluginJobId);

    const inventoryId = `gateway-cron:${entry.jobKey}`;
    const existing = jobsByInventoryId.get(inventoryId);
    if (existing) {
      const existingRawPluginJobId = rawPluginJobIdByInventoryId.get(inventoryId);
      const isCanonical = pluginJobId === entry.pluginJobId;
      const existingIsCanonical = existingRawPluginJobId === entry.pluginJobId;
      const isEnabled = job.enabled !== false;
      const existingIsEnabled = existing.enabled;
      // A tie on BOTH enabled-state and canonical-ness (as opposed to an alias losing to its
      // canonical counterpart, which is intentional) means two raw registrations are genuinely
      // indistinguishable duplicates — track it instead of silently dropping the second one with
      // no signal anywhere in the report (QA follow-up).
      if (isEnabled === existingIsEnabled && isCanonical === existingIsCanonical) {
        duplicateCountByInventoryId.set(inventoryId, (duplicateCountByInventoryId.get(inventoryId) ?? 0) + 1);
      }
      const shouldReplace =
        (isEnabled && !existingIsEnabled) || (isEnabled === existingIsEnabled && isCanonical && !existingIsCanonical);
      if (!shouldReplace) continue;
    }

    rawPluginJobIdByInventoryId.set(inventoryId, pluginJobId);
    const duplicateCount = duplicateCountByInventoryId.get(inventoryId);
    jobsByInventoryId.set(inventoryId, {
      inventoryId,
      jobKey: entry.jobKey,
      name: entry.name,
      pluginJobId: pluginJobId ?? entry.pluginJobId,
      scheduler: "gateway-cron",
      schedulerOwner: "gateway-cron",
      enabled: job.enabled !== false,
      schedule: schedule.schedule,
      scheduleKind: schedule.scheduleKind,
      timezone: schedule.timezone,
      prompt,
      sourceRef: cronStoreDisplayPath,
      guardPath,
      lastRunAt: lastRun.lastRunAt,
      lastRunSource: lastRun.lastRunSource,
      lastExitAt: status.lastExitAt,
      lastStatus: status.lastStatus ?? state?.lastStatus,
      lastLogPath: artifact?.latestLogPath,
      lastExitPath: artifact?.latestExitPath,
      logRoot: join(openclawDir, "logs", "cron-hybrid-mem"),
      collisionGroups: [...entry.collisionGroups],
      lockKey: entry.lockKey,
      duplicateRawRegistrations: duplicateCount && duplicateCount > 0 ? duplicateCount : undefined,
      mutates: { ...entry.mutates },
    });
  }

  function isGoalStewardshipHeartbeatJob(name: string, prompt?: string): boolean {
    if (name === GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID) {
      return true;
    }
    if (/^openclaw-hybrid-memory-.*stewardship/i.test(name)) {
      return true;
    }
    return typeof prompt === "string" && /\bgoal-stewardship-heartbeat\b/i.test(prompt);
  }
  return [...jobsByInventoryId.values()];
}

function parseHostCrontab(
  openclawDir: string,
  crontabText: string,
  artifacts: Map<string, MaintenanceArtifacts>,
): MaintenanceInventoryJob[] {
  const jobsByInventoryId = new Map<string, MaintenanceInventoryJob>();
  let currentTimezone = "system";
  for (const rawLine of crontabText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const envMatch = line.match(/^(?:CRON_TZ|TZ)\s*=\s*(.+)$/);
    if (envMatch) {
      currentTimezone = envMatch[1].trim();
      continue;
    }
    const parsed = parseHostSchedule(line);
    if (!parsed) continue;

    const inferredJobKey = inferHostJobKey(parsed.command);
    if (!inferredJobKey) continue;
    const entry = resolveCatalogEntry(inferredJobKey);
    if (!entry) continue;

    let inventoryId = `host-cron:${entry.jobKey}`;
    let duplicateSuffix = 1;
    while (jobsByInventoryId.has(inventoryId)) {
      duplicateSuffix++;
      inventoryId = `host-cron:${entry.jobKey}#${duplicateSuffix}`;
    }

    const artifact = artifacts.get(entry.name) ?? (entry.pluginJobId ? artifacts.get(entry.pluginJobId) : undefined);
    const guardPath = getGuardFilePath(entry.name, openclawDir);
    const guardMs = readGuardTimestampMs(entry.name, openclawDir);
    const lastRun = pickLastRun(null, guardMs, artifact);
    const status = deriveArtifactStatus(entry, artifact);

    jobsByInventoryId.set(inventoryId, {
      inventoryId,
      jobKey: entry.jobKey,
      name: entry.name,
      pluginJobId: entry.pluginJobId,
      scheduler: "host-cron",
      schedulerOwner: "host-cron",
      enabled: true,
      schedule: parsed.schedule,
      scheduleKind: parsed.scheduleKind,
      timezone: currentTimezone,
      command: parsed.command,
      sourceRef: "crontab -l",
      guardPath,
      lastRunAt: lastRun.lastRunAt,
      lastRunSource: lastRun.lastRunSource,
      lastExitAt: status.lastExitAt,
      lastStatus: status.lastStatus,
      lastLogPath: artifact?.latestLogPath,
      lastExitPath: artifact?.latestExitPath,
      logRoot: join(openclawDir, "logs", "cron-hybrid-mem"),
      collisionGroups: [...entry.collisionGroups],
      lockKey: entry.lockKey,
      mutates: { ...entry.mutates },
    });
  }
  return [...jobsByInventoryId.values()];
}

function buildCollisionGroups(jobs: MaintenanceInventoryJob[]): MaintenanceInventoryCollisionGroup[] {
  const grouped = new Map<string, MaintenanceInventoryCollisionGroup>();
  for (const job of jobs) {
    for (const group of job.collisionGroups) {
      const current = grouped.get(group) ?? { group, jobKeys: [], inventoryIds: [] };
      if (!current.jobKeys.includes(job.jobKey)) current.jobKeys.push(job.jobKey);
      if (!current.inventoryIds.includes(job.inventoryId)) current.inventoryIds.push(job.inventoryId);
      grouped.set(group, current);
    }
  }
  return [...grouped.values()].sort((a, b) => a.group.localeCompare(b.group));
}

export function collectMaintenanceInventory(
  openclawDir: string,
  options: MaintenanceInventoryOptions = {},
): MaintenanceInventoryReport {
  const cronStorePath = describeCronStoreLocation(openclawDir);
  const logRoot = join(openclawDir, "logs", "cron-hybrid-mem");
  const crontab =
    options.crontabText !== undefined || options.crontabError !== undefined
      ? {
          text: options.crontabText ?? "",
          status: options.crontabError
            ? ("unavailable" as const)
            : options.crontabText?.trim()
              ? ("present" as const)
              : ("empty" as const),
          error: options.crontabError,
        }
      : readUserCrontab();

  let cronStoreStatus: CronStoreStatus = "missing";
  let cronStoreError: string | undefined;
  let cronStoreJobs: unknown[] = [];
  if (options.cronStoreText != null) {
    try {
      const parsed = JSON.parse(options.cronStoreText) as { jobs?: unknown[] };
      cronStoreJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      cronStoreStatus = "present";
    } catch (error) {
      cronStoreStatus = "invalid";
      cronStoreError = error instanceof Error ? error.message : String(error);
    }
  } else {
    try {
      const snapshot = readOpenClawCronStore(openclawDir);
      cronStoreJobs = Array.isArray(snapshot.store.jobs) ? snapshot.store.jobs : [];
      cronStoreStatus = cronStoreJobs.length > 0 || snapshot.backend === "sqlite" ? "present" : "missing";
    } catch (error) {
      cronStoreStatus = "invalid";
      cronStoreError = error instanceof Error ? error.message : String(error);
    }
  }

  const { artifacts, scanErrors } = scanLatestMaintenanceArtifacts(logRoot);
  const hostJobs = crontab.status === "present" ? parseHostCrontab(openclawDir, crontab.text, artifacts) : [];
  const gatewayJobs = parseGatewayJobs(openclawDir, cronStoreJobs, artifacts);
  const jobs = [...hostJobs, ...gatewayJobs].sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.scheduler.localeCompare(b.scheduler);
  });

  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    openclawDir,
    cronStorePath,
    logRoot,
    crontabStatus: crontab.status,
    crontabError: crontab.error,
    cronStoreStatus,
    cronStoreError,
    artifactScanErrors: scanErrors > 0 ? scanErrors : undefined,
    jobs,
    collisionGroups: buildCollisionGroups(jobs),
  };
}

export function renderMaintenanceInventoryMarkdown(report: MaintenanceInventoryReport): string {
  const lines = [
    "# Hybrid-memory maintenance inventory",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Cron store: ${report.cronStorePath} (${report.cronStoreStatus})`,
    `- Host crontab: ${report.crontabStatus}${report.crontabError ? ` — ${report.crontabError}` : ""}`,
    "",
    "| Scheduler | Job | Enabled | Schedule | TZ | Last run | Last status | Guard | Last log | Collision groups |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const job of report.jobs) {
    lines.push(
      `| ${job.scheduler} | ${job.name} | ${job.enabled ? "yes" : "no"} | ${job.schedule ?? "—"} | ${job.timezone ?? "—"} | ${
        job.lastRunAt ?? "never"
      } | ${job.lastStatus ?? "unknown"} | ${job.guardPath ?? "—"} | ${job.lastLogPath ?? "—"} | ${
        job.collisionGroups.join(", ") || "—"
      } |`,
    );
  }
  if (report.collisionGroups.length > 0) {
    lines.push("", "## Collision groups", "");
    for (const group of report.collisionGroups) {
      lines.push(`- \`${group.group}\`: ${group.jobKeys.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function renderMaintenanceInventoryText(report: MaintenanceInventoryReport): string {
  const lines = [
    "Hybrid-memory maintenance inventory",
    "==================================",
    `Generated: ${report.generatedAt}`,
    `Cron store: ${report.cronStorePath} (${report.cronStoreStatus})`,
    `Host crontab: ${report.crontabStatus}${report.crontabError ? ` — ${report.crontabError}` : ""}`,
    "",
  ];
  for (const job of report.jobs) {
    const lastRun = job.lastRunAt ? `${job.lastRunAt} (${relativeTime(new Date(job.lastRunAt).getTime())})` : "never";
    lines.push(
      `- [${job.scheduler}] ${job.name} :: ${job.enabled ? "enabled" : "disabled"} :: ${job.schedule ?? "unscheduled"} :: tz ${
        job.timezone ?? "n/a"
      }`,
    );
    lines.push(`    last run: ${lastRun}${job.lastRunSource ? ` via ${job.lastRunSource}` : ""}`);
    lines.push(`    last status: ${job.lastStatus ?? "unknown"}${job.lastExitAt ? ` (exit ${job.lastExitAt})` : ""}`);
    lines.push(`    guard: ${job.guardPath ?? "n/a"}`);
    lines.push(`    log: ${job.lastLogPath ?? `${report.logRoot} (no matching log yet)`}`);
    if (job.command) lines.push(`    command: ${job.command}`);
    if (job.prompt) lines.push(`    prompt: ${job.prompt.split("\n")[0]}`);
    if (job.collisionGroups.length > 0) {
      lines.push(
        `    collision groups: ${job.collisionGroups.join(", ")}${job.lockKey ? ` (lock ${job.lockKey})` : ""}`,
      );
    }
  }
  if (report.collisionGroups.length > 0) {
    lines.push("", "Collision groups", "----------------");
    for (const group of report.collisionGroups) {
      lines.push(`- ${group.group}: ${group.jobKeys.join(", ")}`);
    }
  }
  return lines.join("\n");
}
