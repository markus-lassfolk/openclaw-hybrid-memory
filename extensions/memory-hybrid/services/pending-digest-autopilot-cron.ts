import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HybridMemoryConfig } from "../config.js";
import { validateMaintenanceExecution } from "./cron-exit-validator.js";
import { getGuardFilePath, readGuardTimestampMs } from "./cron-guard.js";
import { canonicalJson, redactAutopilotValue } from "./pending-autopilot/index.js";
import type { PendingDigestAutopilotResult, PendingDigestFactsDb } from "./pending-digest-autopilot.js";
import { runPendingDigestAutopilot } from "./pending-digest-autopilot.js";
import { formatDateUtc, formatTimestampUtc, formatTimestampUtcFromMs, nowIso } from "../utils/dates.js";

export const PENDING_DIGEST_AUTOPILOT_CRON_JOB = "weekly-pending-digest-autopilot";
const PENDING_DIGEST_JOB = "weekly-pending-digest";
const REQUIRED_STEPS = [
  "guard-check",
  "config-load",
  "latest-digest-check",
  "digest-autopilot",
  "persona-triage",
  "procedure-promotion",
  "verified-triage",
  "tool-proposals",
  "crystallization-proposals",
  "summary-write",
  "validate-cron-exit",
  "notification-policy",
] as const;

type CronStepStatus = "ok" | "failed" | "skipped";
type CronStatus = "ok" | "failed" | "skipped" | "partial";

type CronStepName = (typeof REQUIRED_STEPS)[number];

export interface PendingDigestAutopilotCronArtifacts {
  hmLog: string;
  hmExit: string;
  summaryJson: string;
  summaryText: string;
  notificationJson?: string;
}

export interface PendingDigestAutopilotCronSummary {
  runId: string;
  mode: "dry-run" | "apply";
  status: CronStatus;
  skipReason?: string;
  latestDigest: {
    found: boolean;
    path?: string;
    timestamp?: string;
    status?: "success" | "failed";
  };
  policies: {
    persona: string;
    procedure: string;
    verified: string;
    tool: string;
    crystallization: string;
  };
  counts: {
    inspected: number;
    applied: number;
    deferredForHuman: number;
    rejected: number;
    failed: number;
    skipped: number;
  };
  humanReviewRequired: boolean;
  notificationSent: boolean;
  artifacts: PendingDigestAutopilotCronArtifacts;
}

export interface PendingDigestAutopilotCronResult {
  summary: PendingDigestAutopilotCronSummary;
  humanSummary: string;
  autopilotResult?: PendingDigestAutopilotResult;
}

export interface RunPendingDigestAutopilotCronOptions {
  cfg: HybridMemoryConfig;
  factsDb: PendingDigestFactsDb;
  now?: Date;
  openclawHome?: string;
  runId?: string;
  /**
   * Optional progress sink. Every line normally written only to the private `hmLog`
   * artifact file (including step-transition lines from `markStep`) is also passed
   * here. Wire this to `console.log`/`process.stdout.write` (e.g. behind a CLI
   * `--verbose` flag) so an operator watching the cron's tee'd stdout sees internal
   * progress live instead of only the final summary line once the whole run resolves.
   */
  onProgress?: (line: string) => void;
}

type StepRow = {
  name: CronStepName;
  exit: number;
  status: CronStepStatus;
  reason: string;
  durationMs: number;
};

export async function runPendingDigestAutopilotCron(
  opts: RunPendingDigestAutopilotCronOptions,
): Promise<PendingDigestAutopilotCronResult> {
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const nowIsoUtc = formatTimestampUtc(nowSec);
  const runId = opts.runId ?? `${PENDING_DIGEST_AUTOPILOT_CRON_JOB}-${nowIsoUtc}`;
  const openclawHome = resolveOpenclawHome(opts.openclawHome);
  const cronLogRoot = resolveWritableCronHybridMemRoot(openclawHome);
  const artifactDir = join(cronLogRoot, formatDateUtc(nowSec).replace(/-/g, ""));
  mkdirSync(artifactDir, { recursive: true });
  const runToken = nowIsoUtc.replace(/[:.]/g, "-");
  const hmLog = process.env.HM_LOG?.trim() || join(artifactDir, `${PENDING_DIGEST_AUTOPILOT_CRON_JOB}-${runToken}.log`);
  const hmExit =
    process.env.HM_EXIT?.trim() || join(artifactDir, `${PENDING_DIGEST_AUTOPILOT_CRON_JOB}-${runToken}.exit.txt`);
  const summaryJson = join(artifactDir, `${PENDING_DIGEST_AUTOPILOT_CRON_JOB}-${runToken}.summary.json`);
  const summaryText = join(artifactDir, `${PENDING_DIGEST_AUTOPILOT_CRON_JOB}-${runToken}.summary.txt`);
  ensureFile(hmLog);
  ensureFile(hmExit);

  const artifacts: PendingDigestAutopilotCronArtifacts = { hmLog, hmExit, summaryJson, summaryText };
  const stepRows = new Map<CronStepName, StepRow>();
  const autopilotCfg = opts.cfg.digest.autopilot;
  const guardPath = getGuardFilePath(PENDING_DIGEST_AUTOPILOT_CRON_JOB, openclawHome);
  const lockPath = join(openclawHome, "cron", "locks", `${PENDING_DIGEST_AUTOPILOT_CRON_JOB}.lock.json`);
  let acquiredLock = false;
  let status: CronStatus = "ok";
  let skipReason: string | undefined;
  let autopilotResult: PendingDigestAutopilotResult | undefined;
  let notificationSent = false;
  let latestDigest: PendingDigestAutopilotCronSummary["latestDigest"] = { found: false };

  const emitProgress = (line: string): void => {
    logLine(hmLog, line);
    opts.onProgress?.(line);
  };

  const markStep = (name: CronStepName, row: Omit<StepRow, "name">): void => {
    const entry = { name, ...row };
    stepRows.set(name, entry);
    appendStepLine(hmExit, entry);
    emitProgress(`step=${name} status=${row.status} reason=${row.reason} exit=${row.exit} duration_ms=${row.durationMs}`);
  };

  const skipRemaining = (reason: string): void => {
    skipReason = skipReason ?? reason;
    for (const step of REQUIRED_STEPS) {
      if (stepRows.has(step)) continue;
      markStep(step, { exit: 0, status: "skipped", reason, durationMs: 0 });
    }
  };
  const markMissingAsSkipped = (reason: string): void => {
    for (const step of REQUIRED_STEPS) {
      if (step === "summary-write" || step === "validate-cron-exit" || step === "notification-policy") continue;
      if (stepRows.has(step)) continue;
      markStep(step, { exit: 0, status: "skipped", reason, durationMs: 0 });
    }
  };

  emitProgress(`run.start run_id=${runId} job=${PENDING_DIGEST_AUTOPILOT_CRON_JOB}`);
  emitProgress(`run.guard_path ${guardPath}`);
  emitProgress(`run.lock_path ${lockPath}`);
  emitProgress(`run.config ${canonicalJson(redactAutopilotValue(autopilotCfg))}`);

  const guardStartedAt = Date.now();
  try {
    const guardTs = readGuardTimestampMs(PENDING_DIGEST_AUTOPILOT_CRON_JOB, openclawHome);
    const guardWindowMs = autopilotCfg.guardWindowHours * 60 * 60 * 1000;
    if (guardTs && now.getTime() - guardTs < guardWindowMs) {
      status = "skipped";
      skipReason = "guard_window_active";
      markStep("guard-check", {
        exit: 0,
        status: "skipped",
        reason: "guard_window_active",
        durationMs: Date.now() - guardStartedAt,
      });
    } else {
      markStep("guard-check", { exit: 0, status: "ok", reason: "ok", durationMs: Date.now() - guardStartedAt });
    }
  } catch (err) {
    status = "failed";
    markStep("guard-check", {
      exit: 1,
      status: "failed",
      reason: "guard_check_failed",
      durationMs: Date.now() - guardStartedAt,
    });
    emitProgress(`error.guard-check ${stringifyError(err)}`);
  }

  if (status !== "failed" && status !== "skipped") {
    const configStartedAt = Date.now();
    if (!autopilotCfg.enabled) {
      status = "skipped";
      skipReason = "autopilot_disabled";
      markStep("config-load", {
        exit: 0,
        status: "skipped",
        reason: "autopilot_disabled",
        durationMs: Date.now() - configStartedAt,
      });
    } else {
      markStep("config-load", { exit: 0, status: "ok", reason: "ok", durationMs: Date.now() - configStartedAt });
    }
  }

  if (status !== "failed" && status !== "skipped") {
    const latestStartedAt = Date.now();
    latestDigest = findLatestWeeklyPendingDigestArtifact(cronLogRoot);
    emitProgress(
      `run.latest_digest found=${String(latestDigest.found)} status=${latestDigest.status ?? "unknown"} path=${latestDigest.path ?? "none"}`,
    );
    if (!latestDigest.found) {
      status = "skipped";
      skipReason = latestDigest.status === "failed" ? "latest_digest_failed" : "latest_digest_missing";
      markStep("latest-digest-check", {
        exit: 0,
        status: "skipped",
        reason: skipReason,
        durationMs: Date.now() - latestStartedAt,
      });
    } else {
      markStep("latest-digest-check", {
        exit: 0,
        status: "ok",
        reason: "ok",
        durationMs: Date.now() - latestStartedAt,
      });
    }
  }

  if (status !== "failed" && status !== "skipped" && autopilotCfg.mode === "apply") {
    const lockStartedAt = Date.now();
    const lock = tryAcquireAutopilotLock(lockPath, runId, autopilotCfg.lockTtlMinutes, now.getTime());
    emitProgress(`run.lock status=${lock.reason}`);
    if (!lock.acquired) {
      status = "skipped";
      skipReason = lock.reason;
      markStep("digest-autopilot", {
        exit: 0,
        status: "skipped",
        reason: lock.reason,
        durationMs: Date.now() - lockStartedAt,
      });
      emitProgress(`run.lock_skip ${lock.reason}`);
    } else {
      acquiredLock = true;
    }
  }

  let summary!: PendingDigestAutopilotCronSummary;
  let humanSummary = "";

  try {
    if (status !== "failed" && status !== "skipped" && !stepRows.has("digest-autopilot")) {
      const startedAt = Date.now();
      try {
        emitProgress(
          `run.command openclaw hybrid-mem digest autopilot --${autopilotCfg.mode} --max-persona ${autopilotCfg.maxPersona} --max-procedures ${autopilotCfg.maxProcedures} --max-verified ${autopilotCfg.maxVerified} --max-tools ${autopilotCfg.maxTools} --max-crystallization ${autopilotCfg.maxCrystallization}`,
        );
        autopilotResult = await runPendingDigestAutopilot({
          cfg: opts.cfg,
          factsDb: opts.factsDb,
          mode: autopilotCfg.mode,
          runId,
          jobId: `hybrid-mem:${PENDING_DIGEST_AUTOPILOT_CRON_JOB}`,
          now,
          stateDbPath: join(dirname(opts.cfg.sqlitePath), "pending-autopilot.db"),
          policies: {
            persona: autopilotCfg.personaPolicy,
            procedures: autopilotCfg.procedurePolicy,
            verified: autopilotCfg.verifiedPolicy,
            tools: autopilotCfg.toolPolicy,
            crystallization: autopilotCfg.crystallizationPolicy,
          },
          max: {
            persona: autopilotCfg.maxPersona,
            procedures: autopilotCfg.maxProcedures,
            verified: autopilotCfg.maxVerified,
            tools: autopilotCfg.maxTools,
            crystallization: autopilotCfg.maxCrystallization,
          },
        });
        markStep("digest-autopilot", { exit: 0, status: "ok", reason: "ok", durationMs: Date.now() - startedAt });
      } catch (err) {
        status = "failed";
        markStep("digest-autopilot", {
          exit: 1,
          status: "failed",
          reason: "inner_command_failed",
          durationMs: Date.now() - startedAt,
        });
        emitProgress(`error.digest-autopilot ${stringifyError(err)}`);
      }
    }

    const queueMap: Array<[CronStepName, keyof NonNullable<typeof autopilotResult>["queues"]]> = [
      ["persona-triage", "persona"],
      ["procedure-promotion", "procedures"],
      ["verified-triage", "verified"],
      ["tool-proposals", "tools"],
      ["crystallization-proposals", "crystallization"],
    ];
    for (const [stepName, queueName] of queueMap) {
      if (stepRows.has(stepName)) continue;
      if (!autopilotResult) {
        markStep(stepName, {
          exit: 0,
          status: "skipped",
          reason: skipReason ?? "digest_autopilot_not_run",
          durationMs: 0,
        });
        continue;
      }
      const queue = autopilotResult.queues[queueName];
      if (queue.skipped) {
        markStep(stepName, { exit: 0, status: "skipped", reason: queue.skipReason ?? "queue_skipped", durationMs: 0 });
      } else if (queue.decisions.length === 0) {
        markStep(stepName, { exit: 0, status: "skipped", reason: "policy_report_only_no_actions", durationMs: 0 });
      } else {
        markStep(stepName, { exit: 0, status: "ok", reason: "ok", durationMs: 0 });
      }
    }

    if (status === "skipped") {
      markMissingAsSkipped(skipReason ?? "skipped");
    } else if (status === "failed") {
      markMissingAsSkipped("blocked_by_failure");
    }

    summary = buildCronSummary({
      runId,
      status,
      skipReason,
      mode: autopilotCfg.mode,
      latestDigest,
      autopilotResult,
      artifacts,
      notificationSent,
      autopilotCfg,
    });

    const validateStartedAt = Date.now();
    const requiredBeforeValidate = REQUIRED_STEPS.filter(
      (s) => s !== "validate-cron-exit" && s !== "notification-policy" && s !== "summary-write",
    );
    const validation = validateMaintenanceExecution(hmExit, hmLog, [...requiredBeforeValidate], true);
    if (validation.maintenanceStatus === "failed" || validation.maintenanceStatus === "partial") {
      status = "failed";
      summary.status = "failed";
      markStep("validate-cron-exit", {
        exit: 1,
        status: "failed",
        reason: "validate_cron_exit_failed",
        durationMs: Date.now() - validateStartedAt,
      });
      emitProgress(`error.validate-cron-exit ${validation.error ?? "validation_failed"}`);
    } else {
      markStep("validate-cron-exit", {
        exit: 0,
        status: "ok",
        reason: "ok",
        durationMs: Date.now() - validateStartedAt,
      });
    }

    const notifyStartedAt = Date.now();
    try {
      const shouldNotify = shouldNotifyRun(summary, autopilotCfg);
      if (shouldNotify) {
        const payloadPath = join(artifactDir, `${PENDING_DIGEST_AUTOPILOT_CRON_JOB}-${runToken}.notification.json`);
        const payload = {
          runId: summary.runId,
          status: summary.status,
          counts: summary.counts,
          humanReviewRequired: summary.humanReviewRequired,
          skipReason: summary.skipReason,
          artifacts: summary.artifacts,
        };
        writeFileSync(payloadPath, `${canonicalJson(redactAutopilotValue(payload))}\n`, "utf-8");
        artifacts.notificationJson = payloadPath;
        notificationSent = true;
        summary.notificationSent = true;
        markStep("notification-policy", {
          exit: 0,
          status: "ok",
          reason: "notification_sent",
          durationMs: Date.now() - notifyStartedAt,
        });
        emitProgress(`run.notification payload=${payloadPath}`);
      } else {
        markStep("notification-policy", {
          exit: 0,
          status: "skipped",
          reason: "notification_not_required",
          durationMs: Date.now() - notifyStartedAt,
        });
      }
    } catch (err) {
      if (status === "ok" || status === "skipped") status = "partial";
      summary.status = status;
      markStep("notification-policy", {
        exit: 1,
        status: "failed",
        reason: "notification_failed",
        durationMs: Date.now() - notifyStartedAt,
      });
      emitProgress(`error.notification-policy ${stringifyError(err)}`);
    }

    summary.status = status;
    summary.skipReason = status === "skipped" ? skipReason : undefined;
    summary.notificationSent = notificationSent;

    const summaryStartedAt = Date.now();
    humanSummary = renderCronHumanSummary(summary);
    try {
      writeFileSync(summaryJson, `${canonicalJson(redactAutopilotValue(summary))}\n`, "utf-8");
      writeFileSync(summaryText, `${humanSummary}\n`, "utf-8");
      markStep("summary-write", { exit: 0, status: "ok", reason: "ok", durationMs: Date.now() - summaryStartedAt });
    } catch (err) {
      status = "failed";
      summary.status = "failed";
      markStep("summary-write", {
        exit: 1,
        status: "failed",
        reason: "artifact_write_failed",
        durationMs: Date.now() - summaryStartedAt,
      });
      emitProgress(`error.summary-write ${stringifyError(err)}`);
    }
  } finally {
    // Write the guard timestamp BEFORE releasing the lock: the guard window is meant to stop a
    // second cron invocation from running a duplicate apply pass, but that only works if the
    // updated timestamp is visible before the lock frees up. Writing it after release left a
    // window where a concurrent invocation could read the stale (pre-run) guard timestamp, pass
    // its own guard-check, then acquire the just-released lock and run a full duplicate pass.
    // SECURITY: wrap the guard write in its own try/catch so an unwritable guard path
    // (permissions, read-only home, disk-full, ENOSPC) cannot throw out of `finally` and skip
    // the lock release below. A throw from this block would leave the cron lock held until its
    // TTL and cause every subsequent autopilot-cron run to skip as locked, even after the run
    // that "succeeded" finishes. Mark the run `failed` instead so the operator notices and the
    // next guarded run still re-acquires the lock cleanly.
    if (status === "ok" && !skipReason) {
      try {
        mkdirSync(dirname(guardPath), { recursive: true });
        writeFileSync(guardPath, `${Date.now()}`, "utf-8");
      } catch (err) {
        // Use emitProgress (not markStep) so the failure surfaces in the per-run log but is
        // not added to REQUIRED_STEPS — adding it would conflate this post-flight guard write
        // with the pre-flight step validator.
        status = "failed";
        summary.status = "failed";
        summary.skipReason = undefined;
        emitProgress(`error.guard-write ${stringifyError(err)}`);
      }
    }
    if (acquiredLock) releaseAutopilotLock(lockPath, runId);
  }

  emitProgress(`run.finish status=${summary.status} skip_reason=${summary.skipReason ?? "none"}`);
  if (status === "skipped") skipRemaining(skipReason ?? "skipped");

  return { summary, humanSummary, autopilotResult };
}

function resolveOpenclawHome(openclawHome?: string): string {
  if (typeof openclawHome === "string" && openclawHome.trim().length > 0) return openclawHome;
  if (typeof process.env.OPENCLAW_HOME === "string" && process.env.OPENCLAW_HOME.trim().length > 0) {
    return process.env.OPENCLAW_HOME.trim();
  }
  return join(homedir(), ".openclaw");
}

/** Match hybrid-mem cron bash harness: prefer ~/.openclaw/logs/cron-hybrid-mem, fall back to /tmp when not writable. */
function resolveWritableCronHybridMemRoot(openclawHome: string): string {
  const primary = join(openclawHome, "logs", "cron-hybrid-mem");
  try {
    mkdirSync(primary, { recursive: true });
    const probe = join(primary, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok", "utf-8");
    unlinkSync(probe);
    return primary;
  } catch {
    const user = process.env.USER || process.env.USERNAME || "user";
    const fallback =
      process.platform === "win32"
        ? join(tmpdir(), `openclaw-cron-hybrid-mem-${user}`)
        : join("/tmp", `openclaw-cron-hybrid-mem-${user}`);
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function spinWaitMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* tight spin for short lock-acquisition backoff */
  }
}

function ensureFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "", "utf-8");
}

function appendStepLine(path: string, row: StepRow): void {
  const ts = nowIso().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    path,
    `${ts} step=${row.name} exit=${row.exit} status=${row.status} reason=${row.reason} duration_ms=${row.durationMs}\n`,
    {
      encoding: "utf-8",
      flag: "a",
    },
  );
}

function logLine(path: string, line: string): void {
  writeFileSync(path, `${nowIso()} ${line}\n`, { encoding: "utf-8", flag: "a" });
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function findLatestWeeklyPendingDigestArtifact(root: string): PendingDigestAutopilotCronSummary["latestDigest"] {
  if (!existsSync(root)) return { found: false };
  const stack = [root];
  const candidates: Array<{ path: string; mtimeMs: number; success: boolean }> = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of safeReadDir(dir)) {
      const fullPath = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.startsWith(`${PENDING_DIGEST_JOB}-`) || !entry.endsWith(".exit.txt")) continue;
      if (entry.startsWith(`${PENDING_DIGEST_AUTOPILOT_CRON_JOB}-`)) continue;
      const content = readSafe(fullPath);
      const success =
        /\bstep=digest-pending\b.*\bexit=0\b/.test(content) || /\bdigest-pending\b.*\bexit=0\b/.test(content);
      candidates.push({ path: fullPath, mtimeMs: st.mtimeMs, success });
    }
  }
  if (candidates.length === 0) return { found: false };
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates[0];
  if (!newest) return { found: false };
  if (newest.success) {
    return {
      found: true,
      path: newest.path,
      timestamp: formatTimestampUtcFromMs(newest.mtimeMs),
      status: "success",
    };
  }
  return {
    found: false,
    path: newest.path,
    timestamp: formatTimestampUtcFromMs(newest.mtimeMs),
    status: "failed",
  };
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function buildCronSummary(input: {
  runId: string;
  mode: "dry-run" | "apply";
  status: CronStatus;
  skipReason?: string;
  latestDigest: PendingDigestAutopilotCronSummary["latestDigest"];
  autopilotResult?: PendingDigestAutopilotResult;
  notificationSent: boolean;
  artifacts: PendingDigestAutopilotCronArtifacts;
  autopilotCfg: HybridMemoryConfig["digest"]["autopilot"];
}): PendingDigestAutopilotCronSummary {
  return {
    runId: input.runId,
    mode: input.mode,
    status: input.status,
    skipReason: input.skipReason,
    latestDigest: input.latestDigest,
    policies: {
      persona: input.autopilotCfg.personaPolicy,
      procedure: input.autopilotCfg.procedurePolicy,
      verified: input.autopilotCfg.verifiedPolicy,
      tool: input.autopilotCfg.toolPolicy,
      crystallization: input.autopilotCfg.crystallizationPolicy,
    },
    counts: {
      inspected: input.autopilotResult?.counts.inspected ?? 0,
      applied: input.autopilotResult?.counts.applied ?? 0,
      deferredForHuman: input.autopilotResult?.counts.deferred ?? 0,
      rejected: input.autopilotResult?.counts.rejected ?? 0,
      failed: input.autopilotResult?.counts.failedValidation ?? 0,
      skipped: input.autopilotResult?.counts.skipped ?? 0,
    },
    humanReviewRequired: (input.autopilotResult?.counts.humanReviewRequired ?? 0) > 0,
    notificationSent: input.notificationSent,
    artifacts: input.artifacts,
  };
}

function renderCronHumanSummary(summary: PendingDigestAutopilotCronSummary): string {
  return [
    `Pending digest autopilot cron ${summary.runId}`,
    `Status: ${summary.status}${summary.skipReason ? ` (${summary.skipReason})` : ""}`,
    `Mode: ${summary.mode}`,
    `Latest digest: ${summary.latestDigest.found ? `${summary.latestDigest.path ?? "found"} (${summary.latestDigest.timestamp ?? "unknown"})` : "not found"}`,
    `Counts: inspected=${summary.counts.inspected}, applied=${summary.counts.applied}, deferredForHuman=${summary.counts.deferredForHuman}, rejected=${summary.counts.rejected}, failed=${summary.counts.failed}, skipped=${summary.counts.skipped}`,
    `Human review required: ${summary.humanReviewRequired ? "yes" : "no"}`,
    `Artifacts: HM_LOG=${summary.artifacts.hmLog}, HM_EXIT=${summary.artifacts.hmExit}, summaryJson=${summary.artifacts.summaryJson}`,
    summary.notificationSent ? "Notification payload generated." : "Notification not required by policy.",
  ].join("\n");
}

function shouldNotifyRun(
  summary: PendingDigestAutopilotCronSummary,
  cfg: HybridMemoryConfig["digest"]["autopilot"],
): boolean {
  if (summary.status === "failed") return cfg.notifyOnFailure;
  if (summary.status === "partial") return cfg.notifyOnFailure;
  if (summary.humanReviewRequired) return cfg.notifyOnHumanReviewRequired;
  if (summary.mode === "apply" && summary.counts.applied > 0) return cfg.notifyOnApplyActions;
  if (summary.mode === "dry-run" && summary.counts.inspected > 0 && summary.counts.applied === 0) {
    return cfg.notifyOnDryRunActions;
  }
  if (summary.counts.inspected === 0 && summary.counts.applied === 0) return cfg.notifyOnNoop;
  return false;
}

function tryAcquireAutopilotLock(
  lockPath: string,
  runId: string,
  ttlMinutes: number,
  nowMs: number,
): { acquired: boolean; reason: "lock_already_held" | "lock_stale_recovered" | "lock_acquired" } {
  mkdirSync(dirname(lockPath), { recursive: true });
  const expiresAt = nowMs + ttlMinutes * 60 * 1000;
  const payload = { runId, acquiredAt: nowMs, expiresAt };
  const tryWriteExclusive = (): boolean => {
    try {
      writeFileSync(lockPath, `${canonicalJson(payload)}\n`, { encoding: "utf-8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  const recoverStaleOrCorruptLock = (): { acquired: boolean; reason: "lock_stale_recovered" | "lock_already_held" } => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const snapshot = readSafe(lockPath);
        const existing = parseLock(snapshot);
        if (existing && existing.expiresAt > nowMs) return { acquired: false, reason: "lock_already_held" };
        if (existing && existing.expiresAt <= nowMs) {
          rmSync(lockPath, { force: true });
        } else if (!existing) {
          rmSync(lockPath, { force: true });
        }
        spinWaitMs(2 + attempt * 5);
        if (tryWriteExclusive()) return { acquired: true, reason: "lock_stale_recovered" };
      } catch {
        spinWaitMs(2 + attempt * 5);
      }
    }
    return { acquired: false, reason: "lock_already_held" };
  };

  try {
    if (tryWriteExclusive()) return { acquired: true, reason: "lock_acquired" };
    const existing = parseLock(readSafe(lockPath));
    if (!existing) return recoverStaleOrCorruptLock();
    if (existing.expiresAt > nowMs) return { acquired: false, reason: "lock_already_held" };
    return recoverStaleOrCorruptLock();
  } catch {
    return { acquired: false, reason: "lock_already_held" };
  }
}

function releaseAutopilotLock(lockPath: string, runId: string): void {
  const existing = parseLock(readSafe(lockPath));
  if (!existing || existing.runId !== runId) return;
  rmSync(lockPath, { force: true });
}

function parseLock(raw: string): { runId: string; expiresAt: number } | null {
  try {
    const parsed = JSON.parse(raw) as { runId?: unknown; expiresAt?: unknown };
    if (typeof parsed.runId !== "string") return null;
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return null;
    return { runId: parsed.runId, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}
