import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DigestWeeklyDeliveryConfig } from "../../config.js";
import { type CronModelConfig, getDefaultCronModel } from "../../config.js";
import { buildGuardPrefix } from "../../services/cron-guard.js";
import {
  HYBRID_MEM_CRON_ENV_SANITIZER_MARKER,
  buildHybridMemCronTaskMessage,
  hybridMemCronEnvSanitizerBashLines,
} from "../../services/cron-job-bash-harness.js";
import { findDeprecatedHybridMemCronTokens } from "../../services/deprecated-cron-commands.js";
import { capturePluginError } from "../../services/error-reporter.js";
import {
  extractCronStoreJobModel,
  readAgentsPrimaryModelFromOpenclawJsonPath,
  setCronStoreJobModelFields,
} from "../../utils/openclaw-agent-defaults.js";
import {
  GOAL_STEWARDSHIP_HEARTBEAT_CRON_EXPR,
  GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID,
  PLUGIN_JOB_ID_PREFIX,
  selectExistingGoalStewardshipHeartbeatMessage,
  selectGoalStewardshipHeartbeatMessage,
} from "./workspace.js";

export function ensureGoalStewardshipHeartbeatCronJob(
  openclawDir: string,
  options: { heartbeatPatterns: string[] },
): { added: boolean; normalized: boolean; skippedReason?: string } {
  const cronDir = join(openclawDir, "cron");
  const cronStorePath = join(cronDir, "jobs.json");
  mkdirSync(cronDir, { recursive: true });
  const store: { jobs?: unknown[] } = existsSync(cronStorePath)
    ? (JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] })
    : {};
  if (!Array.isArray(store.jobs)) store.jobs = [];
  const jobsArr = store.jobs as Array<Record<string, unknown>>;
  const existing = jobsArr.find(
    (j) =>
      j &&
      (j.pluginJobId === GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID ||
        j.id === GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID ||
        j.name === GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID),
  );
  const desiredMessage =
    selectGoalStewardshipHeartbeatMessage(options.heartbeatPatterns) ??
    selectExistingGoalStewardshipHeartbeatMessage(existing, options.heartbeatPatterns);
  if (!desiredMessage) {
    return {
      added: false,
      normalized: false,
      skippedReason: "could not synthesize a 'cron heartbeat …' message that matches goalStewardship.heartbeatPatterns",
    };
  }

  if (!existing) {
    jobsArr.push({
      pluginJobId: GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID,
      id: GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID,
      name: GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID,
      schedule: { kind: "cron", expr: GOAL_STEWARDSHIP_HEARTBEAT_CRON_EXPR },
      enabled: true,
      sessionTarget: "main",
      delivery: { mode: "none" },
      payload: {
        kind: "systemEvent",
        text: desiredMessage,
      },
    });
    const payload = JSON.stringify(store, null, 2);
    const tmpPath = `${cronStorePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, payload, "utf-8");
    renameSync(tmpPath, cronStorePath);
    return { added: true, normalized: false };
  }

  let changed = false;
  if (existing.pluginJobId !== GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID) {
    existing.pluginJobId = GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID;
    changed = true;
  }
  if (existing.id !== GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID) {
    existing.id = GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID;
    changed = true;
  }
  if (existing.name !== GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID) {
    existing.name = GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID;
    changed = true;
  }
  const currentSchedule = existing.schedule as { kind?: unknown; expr?: unknown } | undefined;
  if (
    typeof currentSchedule !== "object" ||
    currentSchedule === null ||
    currentSchedule.kind !== "cron" ||
    currentSchedule.expr !== GOAL_STEWARDSHIP_HEARTBEAT_CRON_EXPR
  ) {
    existing.schedule = { kind: "cron", expr: GOAL_STEWARDSHIP_HEARTBEAT_CRON_EXPR };
    changed = true;
  }
  if (existing.enabled !== true) {
    existing.enabled = true;
    changed = true;
  }
  if (existing.sessionTarget !== "main") {
    existing.sessionTarget = "main";
    changed = true;
  }
  if (existing.isolated !== undefined) {
    existing.isolated = undefined;
    changed = true;
  }
  const currentDelivery = existing.delivery as { mode?: unknown } | undefined;
  if (typeof currentDelivery !== "object" || currentDelivery === null || currentDelivery.mode !== "none") {
    existing.delivery = { mode: "none" };
    changed = true;
  }
  const payload =
    typeof existing.payload === "object" && existing.payload !== null && !Array.isArray(existing.payload)
      ? (existing.payload as Record<string, unknown>)
      : {};
  if (existing.payload !== payload) {
    existing.payload = payload;
    changed = true;
  }
  if (payload.kind !== "systemEvent") {
    payload.kind = "systemEvent";
    changed = true;
  }
  if (payload.sessionTarget !== undefined) {
    payload.sessionTarget = undefined;
    changed = true;
  }
  if (payload.isolated !== undefined) {
    payload.isolated = undefined;
    changed = true;
  }
  if (payload.message !== undefined) {
    payload.message = undefined;
    changed = true;
  }
  if (payload.text !== desiredMessage) {
    payload.text = desiredMessage;
    changed = true;
  }

  if (!changed) return { added: false, normalized: false };

  const nextPayload = JSON.stringify(store, null, 2);
  const tmpPath = `${cronStorePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, nextPayload, "utf-8");
  renameSync(tmpPath, cronStorePath);
  return { added: false, normalized: true };
}

/**
 * Minimum run interval guard (in milliseconds) for each job frequency tier.
 * When the cron runner triggers a job (e.g. on gateway restart), the agent-level
 * guard in the message prefix causes it to skip if it already ran within this interval.
 * Guard files are stored persistently in ~/.openclaw/cron/guard/ (issue #305).
 */
const MIN_INTERVAL_MS: Record<string, number> = {
  daily: 20 * 60 * 60 * 1000, // 20 hours (daily jobs)
  weekly: 5 * 24 * 60 * 60 * 1000, // 5 days (weekly jobs)
  monthly: 25 * 24 * 60 * 60 * 1000, // 25 days (monthly jobs)
};

function ensureHybridMemCronMessageHasEnvSanitizer(message: string): string | null {
  if (message.includes(HYBRID_MEM_CRON_ENV_SANITIZER_MARKER)) return null;
  if (!/openclaw\s+hybrid-mem\b/.test(message) && !/\bhm_step\b/.test(message)) return null;

  const fenceRe = /```bash\n([\s\S]*?)\n```/m;
  const m = fenceRe.exec(message);
  if (!m) return null;

  const bash = m[1] ?? "";
  if (bash.includes(HYBRID_MEM_CRON_ENV_SANITIZER_MARKER)) return null;
  if (/\bopenclaw\(\)\s*\{/.test(bash)) return null;

  const lines = bash.split("\n");
  let insertAt = lines.findIndex((l) => l.trim() === "set -x");
  if (insertAt >= 0) insertAt += 1;
  else {
    insertAt = lines.findIndex((l) => l.trim() === "set -euo pipefail");
    insertAt = insertAt >= 0 ? insertAt + 1 : 0;
  }
  lines.splice(insertAt, 0, ...hybridMemCronEnvSanitizerBashLines());
  const nextBash = lines.join("\n");
  const next = `${message.slice(0, m.index)}\`\`\`bash\n${nextBash}\n\`\`\`${message.slice(m.index + m[0].length)}`;
  return next === message ? null : next;
}

// buildGuardPrefix is imported from services/cron-guard.ts (issue #305).

// Each entry uses pluginJobId as stable identity; resolveCronJob also sets `id` to that value for gateway `cron.run` / UI parity.
const MAINTENANCE_CRON_JOBS: Array<
  Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number; featureGate?: string }
> = [
  // Daily 02:00 | nightly-memory-sweep | prune → distill → extract-daily → resolve-contradictions → enrich
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}nightly-distill`,
    sessionTarget: "isolated",
    name: "nightly-memory-sweep",
    schedule: { kind: "cron", expr: "0 2 * * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("nightly-memory-sweep", {
      preamble:
        "Nightly memory maintenance (5 steps). CONFIG: If distill.enabled is false, replace the distill and extract-daily hm_step lines with no-ops, e.g. hm_step \"distill-skipped\" bash -c 'echo distill disabled; exit 0' and hm_step \"extract-daily-skipped\" bash -c 'echo extract-daily skipped; exit 0'. If graph.enabled is false, replace enrich-entities with hm_step \"enrich-skipped\" bash -c 'echo graph disabled; exit 0'. Report counts in your reply.",
      steps: [
        { name: "prune", cmd: "openclaw hybrid-mem prune --verbose" },
        { name: "distill", cmd: "openclaw hybrid-mem distill --days 1 --verbose" },
        { name: "extract-daily", cmd: "openclaw hybrid-mem extract-daily --days 7 --verbose" },
        { name: "resolve-contradictions", cmd: "openclaw hybrid-mem resolve-contradictions --auto --verbose" },
        { name: "enrich-entities", cmd: "openclaw hybrid-mem enrich-entities --limit 200 --verbose" },
      ],
    }),
    isolated: true,
    modelTier: "default",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
  },
  // Daily 02:30 | self-correction-analysis | self-correction-run
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}self-correction-analysis`,
    sessionTarget: "isolated",
    name: "self-correction-analysis",
    schedule: { kind: "cron", expr: "30 2 * * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("self-correction-analysis", {
      preamble:
        "Self-correction analysis. If selfCorrection is disabled in hybrid-memory config, reply that the job was skipped and do not update the guard file.",
      steps: [{ name: "self-correction-run", cmd: "openclaw hybrid-mem self-correction-run --verbose" }],
    }),
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
  },
  // Sunday 03:00 | weekly-reflection | reflect --verbose → reflect-rules → reflect-meta
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-reflection`,
    sessionTarget: "isolated",
    name: "weekly-reflection",
    schedule: { kind: "cron", expr: "0 3 * * 0" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-reflection", {
      preamble:
        "Weekly reflection pipeline. If reflection.enabled is false, skip the script and reply disabled; do not update the guard file.",
      steps: [
        { name: "reflect", cmd: "openclaw hybrid-mem reflect --verbose" },
        { name: "reflect-rules", cmd: "openclaw hybrid-mem reflect-rules --verbose" },
        { name: "reflect-meta", cmd: "openclaw hybrid-mem reflect-meta --verbose" },
      ],
    }),
    isolated: true,
    modelTier: "default",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // Sunday 04:00 | weekly-extract-procedures (nano = background model, avoids locking main AI)
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-extract-procedures`,
    sessionTarget: "isolated",
    name: "weekly-extract-procedures",
    schedule: { kind: "cron", expr: "0 4 * * 0" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-extract-procedures", {
      preamble:
        "Weekly extraction pipeline. If a feature is disabled in config, replace that hm_step with a no-op that logs the skip and exits 0.",
      steps: [
        { name: "extract-procedures", cmd: "openclaw hybrid-mem extract-procedures --days 7 --verbose" },
        { name: "extract-directives", cmd: "openclaw hybrid-mem extract-directives --days 7 --verbose" },
        { name: "extract-reinforcement", cmd: "openclaw hybrid-mem extract-reinforcement --days 7 --verbose" },
        { name: "generate-auto-skills", cmd: "openclaw hybrid-mem generate-auto-skills --verbose" },
      ],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },

  // Daily 04:05 | daily-storage-growth-sample | record-storage-sample (7d deltas in audit-health)
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}daily-storage-growth-sample`,
    sessionTarget: "isolated",
    name: "daily-storage-growth-sample",
    schedule: { kind: "cron", expr: "5 4 * * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("daily-storage-growth-sample", {
      preamble:
        "Daily hybrid-memory storage sample. Idempotent per UTC day; ensures audit-health can compute 7d growth deltas.",
      steps: [{ name: "record-storage-sample", cmd: "openclaw hybrid-mem record-storage-sample" }],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
  },
  // Sunday 04:30 | weekly-implicit-feedback-collapse | reflect-meta collapse (before audit-health)
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-implicit-feedback-collapse`,
    sessionTarget: "isolated",
    name: "weekly-implicit-feedback-collapse",
    schedule: { kind: "cron", expr: "30 4 * * 0" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-implicit-feedback-collapse", {
      preamble:
        "Collapse near-duplicate implicit-feedback patterns. Omit dry-run — this job applies mutations. Log scanned/collapsed counts.",
      steps: [
        {
          name: "reflect-meta-collapse",
          cmd: "openclaw hybrid-mem reflect-meta --collapse-implicit-feedback --include-legacy --threshold 0.8 --limit 1000",
        },
      ],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // Sunday 04:45 | weekly-vectordb-optimize-sunday | Lance compact + prune (before audit-health)
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-vectordb-optimize-sunday`,
    sessionTarget: "isolated",
    name: "weekly-vectordb-optimize-sunday",
    schedule: { kind: "cron", expr: "45 4 * * 0" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-vectordb-optimize-sunday", {
      preamble: "Weekly LanceDB optimize (Sunday). Report compacted fragments and bytes freed.",
      steps: [{ name: "vectordb-optimize", cmd: "openclaw hybrid-mem vectordb-optimize --older-than-days 7" }],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },

  // Sunday 05:00 | weekly-audit-health | audit health --strict --json
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-audit-health`,
    sessionTarget: "isolated",
    name: "weekly-audit-health",
    schedule: { kind: "cron", expr: "0 5 * * 0" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-audit-health", {
      preamble:
        "Weekly operator health audit. Run in strict mode, summarize warnings/remediation, and alert the user if the command exits non-zero.",
      steps: [{ name: "audit-health", cmd: "openclaw hybrid-mem audit health --strict --json" }],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },

  // Daily 03:30 | maintenance-log-analyzer | analyze maintenance logs after nightly chain
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}maintenance-log-analyzer`,
    sessionTarget: "isolated",
    name: "maintenance-log-analyzer",
    schedule: { kind: "cron", expr: "30 3 * * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("maintenance-log-analyzer", {
      preamble:
        "Analyze hybrid-memory maintenance logs from the last 24h, report plugin/orchestration failures to GlitchTip if configured, and render a digest for the operator.",
      steps: [
        {
          name: "analyze-maintenance-logs",
          cmd: "openclaw hybrid-mem analyze-maintenance-logs --since 24h --auto-fix --glitchtip --digest md",
        },
      ],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
  },

  // Monday 08:00 | weekly-pending-digest | digest pending --since 7d --format md
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-pending-digest`,
    sessionTarget: "isolated",
    name: "weekly-pending-digest",
    schedule: { kind: "cron", expr: "0 8 * * 1" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-pending-digest", {
      preamble:
        "Weekly pending-review digest. Render the digest and summarize any pending approve/decline/defer actions for the operator.",
      steps: [{ name: "digest-pending", cmd: "openclaw hybrid-mem digest pending --since 7d --format md" }],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },

  // Monday 08:20 | weekly-pending-digest-autopilot | guarded pending digest autopilot cron wrapper
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-pending-digest-autopilot`,
    sessionTarget: "isolated",
    name: "weekly-pending-digest-autopilot",
    schedule: { kind: "cron", expr: "20 8 * * 1" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-pending-digest-autopilot", {
      preamble:
        "Weekly pending-digest autopilot wrapper. Respect digest.autopilot config defaults (disabled + dry-run), keep durable HM_LOG/HM_EXIT artifacts, and fail on inner-step failures.",
      steps: [{ name: "digest-autopilot-cron", cmd: "openclaw hybrid-mem digest autopilot-cron --json" }],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },

  // Saturday 04:00 | weekly-deep-maintenance | compact → vectordb-optimize → scope promote
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-deep-maintenance`,
    sessionTarget: "isolated",
    name: "weekly-deep-maintenance",
    schedule: { kind: "cron", expr: "0 4 * * 6" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-deep-maintenance", {
      preamble: "Weekly deep maintenance. Report counts for each step in your reply.",
      steps: [
        { name: "compact", cmd: "openclaw hybrid-mem compact" },
        { name: "vectordb-optimize", cmd: "openclaw hybrid-mem vectordb-optimize" },
        { name: "scope-promote", cmd: "openclaw hybrid-mem scope promote" },
      ],
    }),
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // Sunday 10:00 | weekly-persona-proposals | generate-proposals → notify if pending
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}weekly-persona-proposals`,
    sessionTarget: "isolated",
    name: "weekly-persona-proposals",
    schedule: { kind: "cron", expr: "0 10 * * 0" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("weekly-persona-proposals", {
      preamble:
        "Generate persona proposals from recent reflection. If personaProposals is disabled, skip and do not update the guard file. If there are pending proposals after a successful run, notify the user in this system channel with a concise summary.",
      steps: [{ name: "generate-proposals", cmd: "openclaw hybrid-mem generate-proposals --verbose" }],
    }),
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.weekly,
  },
  // 1st of month 05:00 | monthly-consolidation | consolidate → build-languages → backfill-decay → reembed-vectorless
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}monthly-consolidation`,
    sessionTarget: "isolated",
    name: "monthly-consolidation",
    schedule: { kind: "cron", expr: "0 5 1 * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("monthly-consolidation", {
      preamble:
        "Monthly consolidation. If graph.enabled is false, replace enrich-entities with a no-op hm_step that logs graph disabled and exits 0.",
      steps: [
        { name: "consolidate", cmd: "openclaw hybrid-mem consolidate --threshold 0.92" },
        { name: "build-languages", cmd: "openclaw hybrid-mem build-languages" },
        { name: "backfill-decay", cmd: "openclaw hybrid-mem backfill-decay" },
        { name: "reembed-vectorless", cmd: "openclaw hybrid-mem reembed-vectorless --limit 1000 --apply" },
        { name: "enrich-entities", cmd: 'openclaw hybrid-mem enrich-entities --limit "${HYBRID_MEM_CLI_JOB_ENRICH_LIMIT:-25}" --verbose' },
      ],
    }),
    isolated: true,
    modelTier: "heavy",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.monthly,
  },
  // Daily 02:45 | nightly-dream-cycle | dream-cycle (prune → consolidate → reflect)
  // Phase 2.7: Only install when nightlyCycle.enabled; off by default (Phase 1).
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`,
    sessionTarget: "isolated",
    name: "nightly-dream-cycle",
    schedule: { kind: "cron", expr: "45 2 * * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("nightly-dream-cycle", {
      preamble:
        "Nightly dream cycle (single CLI). If nightlyCycle.enabled is false, skip and do not update the guard file. Report counts: facts pruned, events consolidated, patterns found, rules generated.",
      steps: [{ name: "dream-cycle", cmd: "openclaw hybrid-mem dream-cycle --verbose" }],
    }),
    isolated: true,
    modelTier: "default",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS.daily,
    featureGate: "nightlyCycle.enabled",
  },
  // Every 4h | sensor-sweep | tier-1 + tier-2 data collection (no LLM, Issue #236)
  // Default schedule; overridden by cfg.sensorSweep.schedule during install/verify/upgrade.
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}sensor-sweep`,
    sessionTarget: "isolated",
    name: "sensor-sweep",
    schedule: { kind: "cron", expr: "0 */4 * * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("sensor-sweep", {
      preamble:
        "Sensor sweep (no LLM). If sensorSweep.enabled is false, skip and do not update the guard file. Report events written and skipped per sensor.",
      steps: [
        { name: "sensor-sweep-tier-1", cmd: "openclaw hybrid-mem sensor-sweep --tier 1" },
        { name: "sensor-sweep-tier-2", cmd: "openclaw hybrid-mem sensor-sweep --tier 2" },
      ],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: true,
    minIntervalMs: 3 * 60 * 60 * 1000,
    featureGate: "sensorSweep.enabled",
  },
  // Daily 04:00 | daily-lifecycle-sync — GitHub lifecycle adapter Phase 2 (#1196).
  // Cron job is installed disabled by default; enable when `lifecycle.adapters.github.enabled` is true.
  {
    pluginJobId: `${PLUGIN_JOB_ID_PREFIX}daily-lifecycle-sync`,
    sessionTarget: "isolated",
    name: "daily-lifecycle-sync",
    schedule: { kind: "cron", expr: "0 4 * * *" },
    channel: "system",
    message: buildHybridMemCronTaskMessage("daily-lifecycle-sync", {
      preamble:
        "GitHub lifecycle sync (#1196). Reads lifecycle.adapters.github.{repos,onMerged,onClosed,onOpen} and updates expires_at/decay_class on facts whose entity matches PR #N or Issue #N.",
      steps: [
        {
          name: "lifecycle-sync-github",
          cmd: "openclaw hybrid-mem lifecycle sync github",
        },
      ],
    }),
    isolated: true,
    modelTier: "nano",
    enabled: false,
    minIntervalMs: MIN_INTERVAL_MS.daily,
    featureGate: "lifecycle.adapters.github.enabled",
  },
];

/**
 * When `agents.defaults.model.primary` is set, use it for maintenance cron `model` so agent-bound
 * runs match `resolveLiveSessionModelSelection` (OpenClaw #963 / hybrid-memory #963). Otherwise
 * use tier defaults from plugin LLM config.
 */
function resolveCronJobModel(
  tier: "nano" | "default" | "heavy",
  pluginConfig: CronModelConfig | undefined,
  agentPrimary: string | undefined,
): string {
  const trimmed = agentPrimary?.trim();
  if (trimmed) return trimmed;
  return getDefaultCronModel(pluginConfig, tier);
}

/** Resolve model for a cron job def and return a job record suitable for the store (has model, no modelTier).
 * Strips the top-level `channel` field (maintenance jobs don't need user delivery) and sets delivery.mode = "none"
 * so the job runner never tries to send a WhatsApp/channel notification for plugin-internal jobs.
 * If the def has minIntervalMs, prepends a guard prefix to the message to prevent re-runs on gateway restart (#304). */
function resolveWeeklyPendingDigestDelivery(del?: DigestWeeklyDeliveryConfig): Record<string, unknown> {
  const mode = del?.mode ?? "system";
  if (mode === "none") return { mode: "none" };
  if (mode === "telegram") {
    const chatId = del?.chatId?.trim();
    if (!chatId) return { mode: "announce" };
    return { mode: "announce", channel: "telegram", chatId };
  }
  return { mode: "announce" };
}

function resolveCronJob(
  def: Record<string, unknown> & { modelTier?: "nano" | "default" | "heavy"; minIntervalMs?: number },
  pluginConfig: CronModelConfig | undefined,
  agentPrimary: string | undefined,
  digestWeeklyDelivery?: DigestWeeklyDeliveryConfig,
): Record<string, unknown> {
  const { modelTier, channel: _channel, minIntervalMs, featureGate: _featureGate, ...rest } = def;
  const tier = modelTier ?? "default";
  const model = resolveCronJobModel(tier, pluginConfig, agentPrimary);
  // Prepend guard prefix to message if minIntervalMs is set (issue #304)
  if (minIntervalMs && typeof rest.message === "string") {
    const jobName = (typeof rest.name === "string" ? rest.name : "unknown").replace(/\s+/g, "-");
    rest.message = buildGuardPrefix(jobName, minIntervalMs) + rest.message;
  }
  const pluginJobId = rest.pluginJobId;
  const stableId = typeof pluginJobId === "string" && pluginJobId.trim().length > 0 ? pluginJobId.trim() : undefined;
  const delivery =
    stableId === `${PLUGIN_JOB_ID_PREFIX}weekly-pending-digest`
      ? resolveWeeklyPendingDigestDelivery(digestWeeklyDelivery)
      : stableId === `${PLUGIN_JOB_ID_PREFIX}maintenance-log-analyzer`
        ? { mode: "announce" as const }
        : { mode: "none" as const };
  return { ...rest, ...(stableId ? { id: stableId } : {}), model, delivery };
}

function hasIsolatedCronSessionTarget(job: Record<string, unknown>): boolean {
  if (job.sessionTarget === "isolated" || job.isolated === true) return true;
  const payload = job.payload as Record<string, unknown> | undefined;
  if (!payload) return false;
  return payload.sessionTarget === "isolated" || payload.isolated === true;
}

const LEGACY_JOB_MATCHERS: Record<string, (j: Record<string, unknown>) => boolean> = {
  [`${PLUGIN_JOB_ID_PREFIX}nightly-distill`]: (j) =>
    String(j.name ?? "")
      .toLowerCase()
      .includes("nightly-memory-sweep"),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-reflection`]: (j) =>
    /weekly-reflection|memory reflection|pattern synthesis/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-extract-procedures`]: (j) =>
    /extract-procedures|weekly-extract-procedures|procedural memory/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}self-correction-analysis`]: (j) =>
    /self-correction-analysis|self-correction\b/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-deep-maintenance`]: (j) =>
    /weekly-deep-maintenance|deep maintenance/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-audit-health`]: (j) => /weekly-audit-health|audit health/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-pending-digest-autopilot`]: (j) =>
    /weekly-pending-digest-autopilot|pending digest autopilot/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-pending-digest`]: (j) => {
    const name = String(j.name ?? "");
    if (/weekly-pending-digest-autopilot|pending digest autopilot/i.test(name)) return false;
    return /weekly-pending-digest|pending digest/i.test(name);
  },
  [`${PLUGIN_JOB_ID_PREFIX}maintenance-log-analyzer`]: (j) =>
    /maintenance-log-analyzer|analyze-maintenance-logs/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}weekly-persona-proposals`]: (j) =>
    /weekly-persona-proposals|persona proposals/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}monthly-consolidation`]: (j) => /monthly-consolidation/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`]: (j) => /nightly-dream-cycle|dream.cycle/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}sensor-sweep`]: (j) => /sensor-sweep|sensor sweep/i.test(String(j.name ?? "")),
  [`${PLUGIN_JOB_ID_PREFIX}daily-lifecycle-sync`]: (j) =>
    /daily-lifecycle-sync|lifecycle sync/i.test(String(j.name ?? "")),
};

/**
 * Ensure maintenance cron jobs exist in ~/.openclaw/cron/jobs.json. Add any missing jobs; optionally normalize existing (schedule, pluginJobId).
 * Never re-enables jobs the user has disabled unless reEnableDisabled is true (callers should pass false to honor disabled jobs).
 * scheduleOverrides: optional map pluginJobId -> cron expr.
 * messageOverrides: optional map pluginJobId -> cron job message string.
 * digestWeeklyDelivery: optional parsed digest.weekly.delivery for the weekly-pending-digest job (#1197).
 */
export function ensureMaintenanceCronJobs(
  openclawDir: string,
  pluginConfig: CronModelConfig | undefined,
  options: {
    normalizeExisting?: boolean;
    reEnableDisabled?: boolean;
    scheduleOverrides?: Record<string, string>;
    messageOverrides?: Record<string, string>;
    featureGates?: Record<string, boolean>;
    digestWeeklyDelivery?: DigestWeeklyDeliveryConfig;
  } = {},
): { added: string[]; normalized: string[] } {
  const {
    normalizeExisting = false,
    reEnableDisabled = false,
    scheduleOverrides,
    messageOverrides,
    featureGates,
    digestWeeklyDelivery,
  } = options;
  const added: string[] = [];
  const normalized: string[] = [];
  const openclawConfigPath = join(openclawDir, "openclaw.json");
  const agentPrimary = readAgentsPrimaryModelFromOpenclawJsonPath(openclawConfigPath);
  const cronDir = join(openclawDir, "cron");
  const cronStorePath = join(cronDir, "jobs.json");
  mkdirSync(cronDir, { recursive: true });
  try {
    mkdirSync(join(openclawDir, "logs", "cron-hybrid-mem"), { recursive: true });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "ensureMaintenanceCronJobs:mkdir-cron-logs",
      severity: "info",
    });
  }
  const store: { jobs?: unknown[] } = existsSync(cronStorePath)
    ? (JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] })
    : {};
  if (!Array.isArray(store.jobs)) store.jobs = [];
  const jobsArr = store.jobs as Array<Record<string, unknown>>;
  let jobsChanged = false;
  for (const def of MAINTENANCE_CRON_JOBS) {
    const id = def.pluginJobId as string;
    const name = def.name as string;
    const scheduleExpr = scheduleOverrides?.[id];
    const existing = jobsArr.find((j) => j && (j.pluginJobId === id || LEGACY_JOB_MATCHERS[id]?.(j)));
    // If feature gate is explicitly disabled, disable existing job (if any) and mark it as
    // feature-gate-disabled so we can re-enable it later when the gate turns back on.
    // This distinguishes system-controlled disable from user-controlled disable.
    if (def.featureGate && featureGates && featureGates[def.featureGate] !== true) {
      if (existing && existing.enabled !== false) {
        existing.enabled = false;
        existing.featureGateDisabled = true;
        jobsChanged = true;
      }
      continue;
    }
    // Feature gate evaluates to true: re-enable the job ONLY if it was previously disabled by the
    // feature gate (featureGateDisabled === true). Never re-enable jobs the user disabled manually.
    if (
      def.featureGate &&
      featureGates &&
      featureGates[def.featureGate] === true &&
      existing &&
      existing.enabled === false &&
      existing.featureGateDisabled === true
    ) {
      existing.enabled = true;
      existing.featureGateDisabled = undefined;
      jobsChanged = true;
    }
    if (!existing) {
      const job = resolveCronJob(def, pluginConfig, agentPrimary, digestWeeklyDelivery) as Record<string, unknown>;
      if (scheduleExpr) job.schedule = { kind: "cron", expr: scheduleExpr };
      if (messageOverrides?.[id]) job.message = messageOverrides[id];
      jobsArr.push(job);
      jobsChanged = true;
      added.push(name);
    } else {
      if (digestWeeklyDelivery && id === `${PLUGIN_JOB_ID_PREFIX}weekly-pending-digest`) {
        const desired = resolveWeeklyPendingDigestDelivery(digestWeeklyDelivery);
        const cur = JSON.stringify(existing.delivery ?? {});
        const next = JSON.stringify(desired);
        if (cur !== next) {
          existing.delivery = desired;
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
      }
      if (normalizeExisting) {
        // If the stored job message contains a deprecated command token (e.g., old runbook step),
        // refresh it to the current template so managed runs don't fail early on unknown commands.
        const existingPayload = existing.payload as { message?: string; kind?: string } | undefined;
        const currentMsg =
          existingPayload && typeof existingPayload.message === "string"
            ? existingPayload.message
            : typeof existing.message === "string"
              ? existing.message
              : "";
        const deprecated = findDeprecatedHybridMemCronTokens(currentMsg);
        if (deprecated.length > 0 && !messageOverrides?.[id]) {
          const desiredJob = resolveCronJob(def, pluginConfig, agentPrimary, digestWeeklyDelivery);
          const desiredMsg = typeof desiredJob.message === "string" ? desiredJob.message : "";
          if (desiredMsg) {
            if (existingPayload && typeof existingPayload.message === "string") {
              existingPayload.message = desiredMsg;
            } else {
              existing.message = desiredMsg;
            }
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        }
        if (typeof existing.schedule === "string") {
          existing.schedule = { kind: "cron", expr: scheduleExpr ?? existing.schedule };
          jobsChanged = true;
          normalized.push(name);
        } else if (scheduleExpr) {
          const currentExpr = (existing.schedule as { expr?: string })?.expr;
          if (currentExpr !== scheduleExpr) {
            existing.schedule = { kind: "cron", expr: scheduleExpr };
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        }
        if (messageOverrides?.[id]) {
          const payOv = existing.payload as { message?: string } | undefined;
          if (payOv && typeof payOv.message === "string") {
            if (payOv.message !== messageOverrides[id]) {
              payOv.message = messageOverrides[id];
              jobsChanged = true;
              if (!normalized.includes(name)) normalized.push(name);
            }
          } else if (typeof existing.message === "string" && existing.message !== messageOverrides[id]) {
            existing.message = messageOverrides[id];
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        }
        if (!existing.pluginJobId) {
          existing.pluginJobId = id;
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        if (!existing.id && typeof existing.pluginJobId === "string" && existing.pluginJobId.length > 0) {
          existing.id = existing.pluginJobId;
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        if (
          id.startsWith(PLUGIN_JOB_ID_PREFIX) &&
          hasIsolatedCronSessionTarget(existing) &&
          existing.sessionTarget !== "isolated"
        ) {
          existing.sessionTarget = "isolated";
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        if (
          id.startsWith(PLUGIN_JOB_ID_PREFIX) &&
          hasIsolatedCronSessionTarget(existing) &&
          Object.hasOwn(existing, "sessionKey")
        ) {
          // Issue #977: plugin maintenance jobs must not pin an interactive session.
          // Omit sessionKey so OpenClaw uses isolated default session key: cron:<jobId>.
          existing.sessionKey = undefined;
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        // Fix delivery: "announce" + channel "system" or "last" requires WhatsApp target (E.164); maintenance jobs don't need delivery.
        const d = existing.delivery as { mode?: string; channel?: string } | undefined;
        if (
          id !== `${PLUGIN_JOB_ID_PREFIX}weekly-pending-digest` &&
          id !== `${PLUGIN_JOB_ID_PREFIX}maintenance-log-analyzer` &&
          d &&
          d.mode === "announce" &&
          (d.channel === "system" || d.channel === "last")
        ) {
          existing.delivery = { mode: "none" };
          jobsChanged = true;
          if (!normalized.includes(name)) normalized.push(name);
        }
        // Issue #304: Add guard prefix to existing job messages to prevent re-runs on gateway restart.
        // Issue #304: Add guard prefix if missing.
        // Issue #305: Also migrate old /tmp/ guard paths to persistent ~/.openclaw/cron/guard/ paths.
        // The on-disk format uses payload.message (agentTurn jobs), but older entries may use top-level message.
        if (def.minIntervalMs) {
          const jobSlug = name.replace(/\s+/g, "-");
          const guard = buildGuardPrefix(jobSlug, def.minIntervalMs as number);
          const oldTmpPath = `/tmp/hybrid-mem-guard-${jobSlug}`;
          const payload = existing.payload as { message?: string; kind?: string } | undefined;
          if (payload && typeof payload.message === "string") {
            if (!payload.message.includes("GUARD CHECK")) {
              // Add guard prefix if missing (issue #304)
              payload.message = guard + payload.message;
              jobsChanged = true;
              if (!normalized.includes(name)) normalized.push(name);
            } else if (payload.message.includes(oldTmpPath)) {
              // Migrate old /tmp/ guard path to persistent path (issue #305)
              const doubleLf = payload.message.indexOf("\n\n");
              if (doubleLf >= 0) {
                payload.message = guard + payload.message.slice(doubleLf + 2);
                jobsChanged = true;
                if (!normalized.includes(name)) normalized.push(name);
              }
            }
          } else if (typeof existing.message === "string") {
            if (!existing.message.includes("GUARD CHECK")) {
              existing.message = guard + existing.message;
              jobsChanged = true;
              if (!normalized.includes(name)) normalized.push(name);
            } else if (existing.message.includes(oldTmpPath)) {
              const doubleLf = existing.message.indexOf("\n\n");
              if (doubleLf >= 0) {
                existing.message = guard + existing.message.slice(doubleLf + 2);
                jobsChanged = true;
                if (!normalized.includes(name)) normalized.push(name);
              }
            }
          }
        }

        // Issue #1205: cron/service environments can leak OPENCLAW_HOME / service marker vars,
        // breaking plugin CLI metadata discovery and causing "Unknown command: openclaw hybrid-mem".
        // Normalize existing job messages by injecting an env-sanitized `openclaw()` wrapper inside
        // the bash block, preserving user edits outside the code fence.
        const cronPayload = existing.payload as { message?: string } | undefined;
        if (cronPayload && typeof cronPayload.message === "string") {
          const next = ensureHybridMemCronMessageHasEnvSanitizer(cronPayload.message);
          if (next) {
            cronPayload.message = next;
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        } else if (typeof existing.message === "string") {
          const next = ensureHybridMemCronMessageHasEnvSanitizer(existing.message);
          if (next) {
            existing.message = next;
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        }

        // Issue #963: keep stored job model aligned with agents.defaults.model.primary when set,
        // so agentTurn + agentId sessions do not throw LiveSessionModelSwitchError.
        if (agentPrimary?.trim()) {
          const tier = (def.modelTier ?? "default") as "nano" | "default" | "heavy";
          const desired = resolveCronJobModel(tier, pluginConfig, agentPrimary);
          const current = extractCronStoreJobModel(existing);
          if (current !== desired) {
            setCronStoreJobModelFields(existing, desired);
            jobsChanged = true;
            if (!normalized.includes(name)) normalized.push(name);
          }
        }
        // Fix: Update message to match current definition to remove obsolete command references.
        // Skip when the caller supplied messageOverrides for this job — those must win over canonical text.
        if (!messageOverrides?.[id]) {
          const currentDef = resolveCronJob(def, pluginConfig, agentPrimary, digestWeeklyDelivery);
          const defMessage = currentDef.message as string | undefined;
          const payload = existing.payload as { message?: string; kind?: string } | undefined;
          if (defMessage && payload && typeof payload.message === "string") {
            // Extract the guard prefix from existing message (if present) and body from new definition
            const guardPrefixMatch = payload.message.match(/^(GUARD CHECK.*?\n\n)/s);
            const guardPrefix = guardPrefixMatch ? guardPrefixMatch[1] : "";
            const defBody = defMessage.includes("GUARD CHECK")
              ? defMessage.replace(/^GUARD CHECK.*?\n\n/s, "")
              : defMessage;
            const expectedMessage = guardPrefix + defBody;
            if (payload.message !== expectedMessage) {
              payload.message = expectedMessage;
              jobsChanged = true;
              if (!normalized.includes(name)) normalized.push(name);
            }
          } else if (defMessage && typeof existing.message === "string") {
            const guardPrefixMatch = existing.message.match(/^(GUARD CHECK.*?\n\n)/s);
            const guardPrefix = guardPrefixMatch ? guardPrefixMatch[1] : "";
            const defBody = defMessage.includes("GUARD CHECK")
              ? defMessage.replace(/^GUARD CHECK.*?\n\n/s, "")
              : defMessage;
            const expectedMessage = guardPrefix + defBody;
            if (existing.message !== expectedMessage) {
              existing.message = expectedMessage;
              jobsChanged = true;
              if (!normalized.includes(name)) normalized.push(name);
            }
          }
        }
      }
      if (reEnableDisabled && existing.enabled === false) {
        existing.enabled = true;
        jobsChanged = true;
      }
    }
  }
  if (jobsChanged) {
    const payload = JSON.stringify(store, null, 2);
    const tmpPath = `${cronStorePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, payload, "utf-8");
    renameSync(tmpPath, cronStorePath);
  }
  return { added, normalized };
}

// Helper function for progress reporting
