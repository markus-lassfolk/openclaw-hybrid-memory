import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import {
  type HybridMemoryConfig,
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
} from "../config.js";
import type { EpisodeOutcome, ScopeFilter } from "../types/memory.js";
import { parseDuration } from "../utils/duration.js";
import { getEnv } from "../utils/env-manager.js";
import { renderActiveTaskMarkdownFile, upsertProjectTaskKey } from "./task-ledger-facts.js";
import type { EmbeddingProvider } from "./embeddings.js";

const ACTIVE_TASK_WAKE_JOB_PREFIX = "hybrid-mem:active-task-wake:";
const ACTIVE_TASK_WAKE_GUARD_YEARS = 10;

export interface ActiveTaskCheckpointInput {
  entity?: string;
  status?: string;
  owner?: string;
  next?: string;
  relatedSession?: string;
  title?: string;
  resumeAt?: string;
  state?: Record<string, unknown>;
  scheduleWake?: boolean;
  refreshProjection?: boolean;
  recordEpisode?: boolean;
}

export interface ActiveTaskCheckpointDeps {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  cfg: HybridMemoryConfig;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
  openclawDir?: string;
  workspaceRoot?: string;
  now?: () => Date;
  episodeScopeFilter?: ScopeFilter | null;
  scheduleWakeFn?: (args: ActiveTaskWakeScheduleInput) => Promise<ActiveTaskWakeScheduleResult>;
  refreshProjectionFn?: (args: ActiveTaskProjectionRefreshInput) => Promise<ActiveTaskProjectionRefreshResult>;
}

interface NormalizedCheckpointInput {
  entity: string;
  status: string;
  owner: string;
  next: string;
  relatedSession: string;
  title?: string;
  resumeAtIso?: string;
  resumeAtDate?: Date;
  state?: Record<string, unknown>;
  scheduleWake: boolean;
  refreshProjection: boolean;
  recordEpisode: boolean;
}

export type ActiveTaskCheckpointStep = "validation" | "facts" | "episode" | "schedule" | "projection";

export interface ActiveTaskCheckpointError {
  step: ActiveTaskCheckpointStep;
  message: string;
}

export interface ActiveTaskWakeScheduleInput {
  cfg: HybridMemoryConfig;
  entity: string;
  status: string;
  owner?: string;
  next?: string;
  relatedSession?: string;
  title?: string;
  resumeAt: Date;
  state?: Record<string, unknown>;
  openclawDir?: string;
}

export interface ActiveTaskWakeScheduleResult {
  scheduled: boolean;
  jobId: string;
  cronExpr: string;
  jobsPath: string;
  disabledPreviousJobs: number;
}

export interface ActiveTaskProjectionRefreshInput {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  workspaceRoot?: string;
}

export interface ActiveTaskProjectionRefreshResult {
  attempted: boolean;
  refreshed: boolean;
  path?: string;
  reason?: string;
}

export interface ActiveTaskCheckpointResult {
  ok: boolean;
  partial: boolean;
  message: string;
  checkpoint?: {
    entity: string;
    status: string;
    owner: string;
    next: string;
    relatedSession: string;
    title?: string;
    resumeAt?: string;
    taskUpdated: string;
    state?: Record<string, unknown>;
  };
  steps: {
    facts: {
      ok: boolean;
      updatedKeys: string[];
      failedKeys: string[];
      titleSource?: "provided" | "existing" | "defaulted";
    };
    episode: {
      attempted: boolean;
      ok: boolean;
      episodeId?: string;
      skippedReason?: string;
    };
    schedule: {
      attempted: boolean;
      scheduled: boolean;
      jobId?: string;
      cronExpr?: string;
      jobsPath?: string;
      disabledPreviousJobs?: number;
      skippedReason?: string;
    };
    projection: ActiveTaskProjectionRefreshResult;
  };
  errors: ActiveTaskCheckpointError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimToString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStatus(raw?: string): string | null {
  if (!raw?.trim()) return "in_progress";
  const value = raw.trim().toLowerCase();
  if (value === "open" || value === "in_progress" || value === "in progress" || value === "working") {
    return "in_progress";
  }
  if (value === "blocked" || value === "stalled") return "blocked";
  if (value === "waiting" || value === "on_hold" || value === "on hold") return "waiting";
  if (
    value === "done" ||
    value === "completed" ||
    value === "closed" ||
    value === "cancelled" ||
    value === "canceled" ||
    value === "abandoned"
  ) {
    return "done";
  }
  if (value === "failed" || value === "error") return "failed";
  return null;
}

function normalizeCheckpointInput(input: ActiveTaskCheckpointInput, now: Date): {
  normalized?: NormalizedCheckpointInput;
  errors: ActiveTaskCheckpointError[];
} {
  const errors: ActiveTaskCheckpointError[] = [];

  const entity = trimToString(input.entity);
  if (!entity) {
    errors.push({ step: "validation", message: "entity is required" });
  }

  const status = normalizeStatus(input.status);
  if (!status) {
    errors.push({
      step: "validation",
      message:
        "status must be one of: open, in_progress, blocked, waiting, done/completed/closed/cancelled/abandoned, failed",
    });
  }

  const title = trimToString(input.title);
  const owner = trimToString(input.owner) ?? "";
  const next = trimToString(input.next) ?? "";
  const relatedSession = trimToString(input.relatedSession) ?? "";

  let resumeAtIso: string | undefined;
  let resumeAtDate: Date | undefined;
  if (input.resumeAt !== undefined) {
    const rawResumeAt = trimToString(input.resumeAt);
    if (!rawResumeAt) {
      errors.push({ step: "validation", message: "resumeAt must be a non-empty ISO timestamp" });
    } else {
      const parsed = new Date(rawResumeAt);
      if (Number.isNaN(parsed.getTime())) {
        errors.push({ step: "validation", message: "resumeAt must be a valid ISO timestamp" });
      } else if (parsed.getTime() <= now.getTime()) {
        errors.push({ step: "validation", message: "resumeAt must be in the future" });
      } else {
        resumeAtDate = parsed;
        resumeAtIso = parsed.toISOString();
      }
    }
  }

  if (input.state !== undefined && !isRecord(input.state)) {
    errors.push({ step: "validation", message: "state must be an object when provided" });
  }

  if (errors.length > 0 || !entity || !status) {
    return { errors };
  }

  return {
    normalized: {
      entity,
      status,
      owner,
      next,
      relatedSession,
      title,
      resumeAtIso,
      resumeAtDate,
      state: input.state,
      scheduleWake: input.scheduleWake !== false,
      refreshProjection: input.refreshProjection === true,
      recordEpisode: input.recordEpisode !== false,
    },
    errors,
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function resolveOpenclawDir(override?: string): string {
  if (override?.trim()) return override.trim();
  const env = getEnv("OPENCLAW_HOME")?.trim();
  if (env) return env;
  return join(homedir(), ".openclaw");
}

function resolveWorkspaceRoot(cfg: HybridMemoryConfig, override?: string): string {
  if (override?.trim()) return override.trim();
  const env = getEnv("OPENCLAW_WORKSPACE")?.trim();
  if (env) return env;
  return join(resolveOpenclawDir(), "workspace");
}

function scheduleToCronExpr(resumeAt: Date): string {
  return `${resumeAt.getUTCMinutes()} ${resumeAt.getUTCHours()} ${resumeAt.getUTCDate()} ${resumeAt.getUTCMonth() + 1} *`;
}

function resolveCronModel(cfg: HybridMemoryConfig): string {
  const cronCfg = getCronModelConfig(cfg);
  const pref = getLLMModelPreference(cronCfg, "nano");
  return pref[0] ?? getDefaultCronModel(cronCfg, "nano");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{\"error\":\"unserializable\"}";
  }
}

function buildWakeMessage(args: {
  entity: string;
  status: string;
  owner?: string;
  next?: string;
  relatedSession?: string;
  title?: string;
  resumeAtIso: string;
  state?: Record<string, unknown>;
  guardYears: number;
}): string {
  const lines: string[] = [
    `Active-task wake reminder for \"${args.entity}\".`,
    `Scheduled resume time (UTC): ${args.resumeAtIso}`,
    `Status: ${args.status}`,
  ];

  if (args.title) lines.push(`Title: ${args.title}`);
  if (args.owner) lines.push(`Owner: ${args.owner}`);
  if (args.relatedSession) lines.push(`Related session: ${args.relatedSession}`);
  if (args.next) lines.push(`Next: ${args.next}`);
  if (args.state) {
    const json = safeJson(args.state);
    lines.push(`Checkpoint state JSON: ${json.length > 1500 ? `${json.slice(0, 1500)}...` : json}`);
  }

  lines.push(
    `This reminder is guarded to avoid duplicate reruns for approximately ${args.guardYears} year(s).`,
    "If work is still relevant, continue execution and update task state with active_task_checkpoint.",
  );

  return lines.join("\n");
}

export async function scheduleActiveTaskWakeReminder(
  input: ActiveTaskWakeScheduleInput,
): Promise<ActiveTaskWakeScheduleResult> {
  const openclawDir = resolveOpenclawDir(input.openclawDir);
  const cronDir = join(openclawDir, "cron");
  const jobsPath = join(cronDir, "jobs.json");
  mkdirSync(cronDir, { recursive: true });

  let store: { jobs?: unknown[] } = {};
  if (existsSync(jobsPath)) {
    try {
      store = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs?: unknown[] };
    } catch (err) {
      throw new Error(`failed to parse ${jobsPath}: ${String(err)}`);
    }
  }

  if (!Array.isArray(store.jobs)) {
    store.jobs = [];
  }

  const jobs = store.jobs as Array<Record<string, unknown>>;
  const entitySlug = slugify(input.entity) || "task";
  const resumeAtIso = input.resumeAt.toISOString();
  const resumeEpochSec = Math.floor(input.resumeAt.getTime() / 1000);
  const jobId = `${ACTIVE_TASK_WAKE_JOB_PREFIX}${entitySlug}:${resumeEpochSec}`;

  let disabledPreviousJobs = 0;
  const entityPrefix = `${ACTIVE_TASK_WAKE_JOB_PREFIX}${entitySlug}:`;
  for (const row of jobs) {
    const pluginJobId = typeof row.pluginJobId === "string" ? row.pluginJobId : undefined;
    if (!pluginJobId || pluginJobId === jobId) continue;
    if (!pluginJobId.startsWith(entityPrefix)) continue;
    if (row.enabled !== false) {
      row.enabled = false;
      disabledPreviousJobs += 1;
    }
  }

  const cronExpr = scheduleToCronExpr(input.resumeAt);
  const model = resolveCronModel(input.cfg);
  const minIntervalMs = ACTIVE_TASK_WAKE_GUARD_YEARS * 365 * 24 * 60 * 60 * 1000;
  const guardFile = join(openclawDir, "cron", "guard", `active-task-wake-${entitySlug}.ms`);
  const guardPrefix = [
    `GUARD CHECK: Before continuing, read \"${guardFile}\" if it exists.`,
    `If current epoch ms minus the stored value is less than ${minIntervalMs}, reply only \"Skipped: active-task wake already delivered recently\" and stop.`,
    `After a successful reminder, write the current epoch ms back to \"${guardFile}\".`,
    "",
  ].join("\n");

  const job: Record<string, unknown> = {
    id: jobId,
    pluginJobId: jobId,
    name: `active-task-wake-${entitySlug}`,
    sessionTarget: "isolated",
    schedule: { kind: "cron", expr: cronExpr },
    channel: "system",
    message:
      guardPrefix +
      buildWakeMessage({
        entity: input.entity,
        status: input.status,
        owner: input.owner,
        next: input.next,
        relatedSession: input.relatedSession,
        title: input.title,
        resumeAtIso,
        state: input.state,
        guardYears: ACTIVE_TASK_WAKE_GUARD_YEARS,
      }),
    model,
    delivery: { mode: "announce" },
    enabled: true,
    metadata: {
      source: "active_task_checkpoint",
      entity: input.entity,
      resumeAt: resumeAtIso,
      createdAt: new Date().toISOString(),
    },
  };

  const existingIdx = jobs.findIndex((row) => {
    const pluginJobId = typeof row.pluginJobId === "string" ? row.pluginJobId : "";
    const id = typeof row.id === "string" ? row.id : "";
    return pluginJobId === jobId || id === jobId;
  });

  if (existingIdx >= 0) {
    jobs[existingIdx] = { ...(jobs[existingIdx] ?? {}), ...job };
  } else {
    jobs.push(job);
  }

  const payload = JSON.stringify(store, null, 2);
  const tmpPath = `${jobsPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, jobsPath);

  return {
    scheduled: true,
    jobId,
    cronExpr,
    jobsPath,
    disabledPreviousJobs,
  };
}

export async function refreshActiveTaskProjectionFromFacts(
  input: ActiveTaskProjectionRefreshInput,
): Promise<ActiveTaskProjectionRefreshResult> {
  if (!input.cfg.activeTask.enabled) {
    return { attempted: true, refreshed: false, reason: "active_task_disabled" };
  }
  if (input.cfg.activeTask.ledger !== "facts") {
    return { attempted: true, refreshed: false, reason: "active_task_ledger_not_facts" };
  }

  const workspaceRoot = resolveWorkspaceRoot(input.cfg, input.workspaceRoot);
  const activeTaskPath = isAbsolute(input.cfg.activeTask.filePath)
    ? input.cfg.activeTask.filePath
    : join(workspaceRoot, input.cfg.activeTask.filePath);
  const staleMinutes = parseDuration(input.cfg.activeTask.staleThreshold);

  await renderActiveTaskMarkdownFile(input.factsDb, staleMinutes, activeTaskPath, input.cfg.activeTask.projection);
  return { attempted: true, refreshed: true, path: activeTaskPath };
}

function stepError(step: ActiveTaskCheckpointStep, err: unknown): ActiveTaskCheckpointError {
  return { step, message: err instanceof Error ? err.message : String(err) };
}

function outcomeFromStatus(status: string): EpisodeOutcome {
  if (status === "done") return "success";
  if (status === "failed") return "failure";
  if (status === "blocked" || status === "waiting") return "partial";
  return "unknown";
}

function scopeFromFilter(filter?: ScopeFilter | null): {
  scope: "global" | "user" | "agent" | "session";
  scopeTarget: string | null;
  agentId?: string;
  userId?: string;
  sessionId?: string;
} {
  if (filter?.sessionId?.trim()) {
    return {
      scope: "session",
      scopeTarget: filter.sessionId,
      agentId: filter.agentId ?? undefined,
      userId: filter.userId ?? undefined,
      sessionId: filter.sessionId,
    };
  }
  if (filter?.userId?.trim()) {
    return {
      scope: "user",
      scopeTarget: filter.userId,
      agentId: filter.agentId ?? undefined,
      userId: filter.userId,
      sessionId: filter.sessionId ?? undefined,
    };
  }
  if (filter?.agentId?.trim()) {
    return {
      scope: "agent",
      scopeTarget: filter.agentId,
      agentId: filter.agentId,
      userId: filter.userId ?? undefined,
      sessionId: filter.sessionId ?? undefined,
    };
  }
  return {
    scope: "global",
    scopeTarget: null,
    agentId: filter?.agentId ?? undefined,
    userId: filter?.userId ?? undefined,
    sessionId: filter?.sessionId ?? undefined,
  };
}

export async function runActiveTaskCheckpoint(
  deps: ActiveTaskCheckpointDeps,
  input: ActiveTaskCheckpointInput,
): Promise<ActiveTaskCheckpointResult> {
  const now = deps.now?.() ?? new Date();
  const validation = normalizeCheckpointInput(input, now);
  if (!validation.normalized) {
    return {
      ok: false,
      partial: false,
      message: `active_task_checkpoint validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
      steps: {
        facts: { ok: false, updatedKeys: [], failedKeys: [] },
        episode: { attempted: false, ok: false, skippedReason: "validation_failed" },
        schedule: { attempted: false, scheduled: false, skippedReason: "validation_failed" },
        projection: { attempted: false, refreshed: false, reason: "validation_failed" },
      },
      errors: validation.errors,
    };
  }

  const checkpoint = validation.normalized;
  const taskUpdated = now.toISOString();
  const errors: ActiveTaskCheckpointError[] = [];
  const updatedKeys: string[] = [];
  const failedKeys: string[] = [];

  let titleSource: "provided" | "existing" | "defaulted" | undefined;
  let effectiveTitle = checkpoint.title;

  try {
    if (effectiveTitle) {
      titleSource = "provided";
    } else {
      const existingTitleHit = deps.factsDb.lookup(checkpoint.entity, "title", undefined, {
        includeSuperseded: false,
        limit: 1,
      })[0];
      const existingTitle =
        trimToString(existingTitleHit?.entry?.value) ?? trimToString(existingTitleHit?.entry?.text) ?? undefined;
      if (existingTitle) {
        effectiveTitle = existingTitle;
        titleSource = "existing";
      } else {
        effectiveTitle = "Project task";
        titleSource = "defaulted";
      }
    }
  } catch (err) {
    deps.logger?.warn?.(`memory-hybrid: active-task checkpoint title lookup failed: ${String(err)}`);
    effectiveTitle = checkpoint.title ?? "Project task";
    titleSource = checkpoint.title ? "provided" : "defaulted";
  }

  const updates: Array<{ key: string; value: string }> = [
    { key: "status", value: checkpoint.status },
    { key: "next", value: checkpoint.next },
    { key: "owner", value: checkpoint.owner },
    { key: "related_session", value: checkpoint.relatedSession },
    { key: "task_updated", value: taskUpdated },
  ];

  if (effectiveTitle) {
    updates.push({ key: "title", value: effectiveTitle });
  }

  if (checkpoint.state) {
    updates.push({ key: "checkpoint_state", value: safeJson(checkpoint.state) });
  }

  if (checkpoint.resumeAtIso) {
    updates.push({ key: "resume_at", value: checkpoint.resumeAtIso });
  }

  for (const update of updates) {
    try {
      await upsertProjectTaskKey(
        deps.factsDb,
        deps.vectorDb,
        deps.embeddings,
        checkpoint.entity,
        update.key,
        update.value,
        deps.logger,
      );
      updatedKeys.push(update.key);
    } catch (err) {
      failedKeys.push(update.key);
      errors.push(stepError("facts", new Error(`${update.key}: ${String(err)}`)));
    }
  }

  let episodeId: string | undefined;
  let episodeAttempted = false;
  let episodeOk = false;
  let episodeSkippedReason: string | undefined;

  if (checkpoint.recordEpisode) {
    episodeAttempted = true;
    try {
      const scope = scopeFromFilter(deps.episodeScopeFilter);
      const contextLines: string[] = [
        `entity=${checkpoint.entity}`,
        `status=${checkpoint.status}`,
        `owner=${checkpoint.owner || "n/a"}`,
        `next=${checkpoint.next || "n/a"}`,
        `relatedSession=${checkpoint.relatedSession || "n/a"}`,
        `taskUpdated=${taskUpdated}`,
      ];
      if (checkpoint.resumeAtIso) contextLines.push(`resumeAt=${checkpoint.resumeAtIso}`);
      if (checkpoint.state) contextLines.push(`state=${safeJson(checkpoint.state)}`);

      const ep = deps.factsDb.recordEpisode({
        event: `Active task checkpoint: ${checkpoint.entity}`,
        outcome: outcomeFromStatus(checkpoint.status),
        context: contextLines.join("\n"),
        importance: checkpoint.status === "failed" ? 0.8 : 0.6,
        tags: ["active-task", "checkpoint", slugify(checkpoint.entity)],
        scope: scope.scope,
        scopeTarget: scope.scopeTarget,
        agentId: scope.agentId,
        userId: scope.userId,
        sessionId: scope.sessionId,
      });
      episodeId = ep.id;
      episodeOk = true;
    } catch (err) {
      errors.push(stepError("episode", err));
    }
  } else {
    episodeSkippedReason = "record_episode_disabled";
  }

  let wakeAttempted = false;
  let wakeScheduled = false;
  let wakeSkippedReason: string | undefined;
  let wakeResult: ActiveTaskWakeScheduleResult | undefined;

  if (checkpoint.resumeAtIso && checkpoint.resumeAtDate && checkpoint.scheduleWake) {
    wakeAttempted = true;
    try {
      const scheduleWake = deps.scheduleWakeFn ?? scheduleActiveTaskWakeReminder;
      wakeResult = await scheduleWake({
        cfg: deps.cfg,
        entity: checkpoint.entity,
        status: checkpoint.status,
        owner: checkpoint.owner || undefined,
        next: checkpoint.next || undefined,
        relatedSession: checkpoint.relatedSession || undefined,
        title: effectiveTitle,
        resumeAt: checkpoint.resumeAtDate,
        state: checkpoint.state,
        openclawDir: deps.openclawDir,
      });
      wakeScheduled = wakeResult.scheduled;
    } catch (err) {
      errors.push(stepError("schedule", err));
    }
  } else {
    wakeSkippedReason = checkpoint.resumeAtIso ? "schedule_wake_disabled" : "resumeAt_not_provided";
  }

  let projection = { attempted: false, refreshed: false, reason: "refresh_not_requested" } as ActiveTaskProjectionRefreshResult;
  if (checkpoint.refreshProjection) {
    try {
      const refreshFn = deps.refreshProjectionFn ?? refreshActiveTaskProjectionFromFacts;
      projection = await refreshFn({
        cfg: deps.cfg,
        factsDb: deps.factsDb,
        workspaceRoot: deps.workspaceRoot,
      });
    } catch (err) {
      projection = { attempted: true, refreshed: false, reason: String(err) };
      errors.push(stepError("projection", err));
    }
  }

  const ok = errors.length === 0;
  const partial = !ok && updatedKeys.length > 0;

  const summaryBits: string[] = [
    `entity=${checkpoint.entity}`,
    `status=${checkpoint.status}`,
    `facts=${updatedKeys.length}/${updates.length}`,
    checkpoint.recordEpisode ? `episode=${episodeOk ? "recorded" : "failed"}` : "episode=skipped",
  ];
  if (wakeAttempted) {
    summaryBits.push(`wake=${wakeScheduled ? "scheduled" : "failed"}`);
  } else if (wakeSkippedReason) {
    summaryBits.push(`wake=skipped(${wakeSkippedReason})`);
  }
  if (checkpoint.refreshProjection) {
    summaryBits.push(`projection=${projection.refreshed ? "refreshed" : "not_refreshed"}`);
  }

  const message = ok
    ? `active_task_checkpoint completed (${summaryBits.join(", ")}).`
    : partial
      ? `active_task_checkpoint completed with partial failures (${summaryBits.join(", ")}).`
      : `active_task_checkpoint failed (${summaryBits.join(", ")}).`;

  return {
    ok,
    partial,
    message,
    checkpoint: {
      entity: checkpoint.entity,
      status: checkpoint.status,
      owner: checkpoint.owner,
      next: checkpoint.next,
      relatedSession: checkpoint.relatedSession,
      title: effectiveTitle,
      resumeAt: checkpoint.resumeAtIso,
      taskUpdated,
      state: checkpoint.state,
    },
    steps: {
      facts: {
        ok: failedKeys.length === 0,
        updatedKeys,
        failedKeys,
        titleSource,
      },
      episode: {
        attempted: episodeAttempted,
        ok: episodeOk,
        episodeId,
        skippedReason: episodeSkippedReason,
      },
      schedule: {
        attempted: wakeAttempted,
        scheduled: wakeScheduled,
        jobId: wakeResult?.jobId,
        cronExpr: wakeResult?.cronExpr,
        jobsPath: wakeResult?.jobsPath,
        disabledPreviousJobs: wakeResult?.disabledPreviousJobs,
        skippedReason: wakeSkippedReason,
      },
      projection,
    },
    errors,
  };
}
