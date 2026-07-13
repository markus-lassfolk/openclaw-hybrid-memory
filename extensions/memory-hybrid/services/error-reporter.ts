import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEnv } from "../utils/env-manager.js";
import { compareVersions } from "../utils/version-check.js";
import { shouldDropNoisyError } from "./error-reporter/noisy-errors.js";
import {
  extractVersion,
  sanitizeEvent,
  sanitizePath,
  scrubString,
  shouldDropForResolvedIssue,
} from "./error-reporter/sanitize.js";
import type {
  GlitchTipEvent,
  ReportBreadcrumb,
  ReportExceptionValue,
  ReportFrame,
  ReportStacktrace,
} from "./error-reporter/types.js";

export { shouldDropNoisyError } from "./error-reporter/noisy-errors.js";
export { compareVersions, extractVersion, sanitizeEvent, sanitizePath, scrubString, shouldDropForResolvedIssue };

/**
 * Error Reporter Service for GlitchTip Integration
 *
 * SECURITY REQUIREMENTS (NON-NEGOTIABLE):
 * - consent: true by default — user must explicitly opt OUT
 * - No real user data: no memory text, prompts, conversation content, or user identity
 * - MAX_BREADCRUMBS: 10 — only plugin.* category allowed, message/data stripped
 * - sanitizeEvent() rebuilds event from scratch using allowlist before sending
 * - NEVER include: memory text, prompts, API keys, home paths, IPs, emails
 * - Opt-in bot identity only: user.id/user.username are anonymous bot UUID/name (not real user data)
 * - Rate limiting: 60s dedup window for same error fingerprint
 *
 * Uses native fetch (Node 20+) — no @sentry/node dependency.
 */

const MAX_BREADCRUMBS = 10;
const MAX_PENDING_REPORTS = 200;

/**
 * Default GlitchTip DSN for anonymous crash reporting.
 * This DSN is safe to expose publicly — it only allows ingest (write), not read.
 * Users can opt out by setting errorReporting.consent: false or errorReporting.enabled: false.
 * Privacy: No PII, prompts, API keys, or user data is ever sent. See sanitizeEvent().
 */
export const DEFAULT_GLITCHTIP_DSN = "https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1";

export interface ErrorReporterConfig {
  enabled: boolean;
  /** DSN for self-hosted mode. Community mode uses COMMUNITY_DSN constant. */
  dsn?: string;
  /** "community" (default): use hardcoded community DSN. "self-hosted": require custom DSN from config. */
  mode: "community" | "self-hosted";
  environment?: string; // "production" | "development"
  maxBreadcrumbs: number; // PRIVACY: Hard-coded to MAX_BREADCRUMBS (limited plugin.* breadcrumbs only). Not user-configurable.
  sampleRate: number; // 0.0-1.0, default 1.0
  consent: boolean; // explicit opt-in required
  /**
   * Opt-in: Only sent when explicitly configured. Not sent by default for privacy.
   * Optional UUID for this bot instance; sent as tag so GlitchTip can group errors by bot.
   */
  botId?: string;
  /**
   * Opt-in: Only sent when explicitly configured. Not sent by default for privacy.
   * Optional friendly name for this bot; sent as tag for readable reports.
   */
  botName?: string;
  /**
   * Optional map of error fingerprints to the version that fixed them.
   * Errors matching a fingerprint from an older version are silently dropped (not regressions).
   * Format: { "ErrorType:message prefix (first 100 chars)": "YYYY.M.NNN" }
   * When not configured, behavior is identical to today.
   */
  resolvedIssues?: Record<string, string>;
  /** Optional persistent queue path for pending reports (JSONL). */
  pendingQueuePath?: string;
  /** Optional cap for persistent pending reports. Oldest entries are pruned first. */
  maxPendingReports?: number;
}

/** Hardcoded DSN for community error reporting (anonymous telemetry) */
const COMMUNITY_DSN = DEFAULT_GLITCHTIP_DSN;

// --- Internal wire-protocol types (GlitchTip / Sentry envelope format) ---

export type { GlitchTipEvent };

export interface PendingReportRecord {
  id: string;
  event: GlitchTipEvent;
  enqueuedAt: number;
}

// --- Pure utility functions ---

/**
 * Compare two version strings numerically (YYYY.M.N format).
 * Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 */

/**
 * Same fingerprint used by GlitchTipReporter's pending-queue dedup — shared so disk-level readers
 * (readPendingErrorReportEntries, used by the error-reports CLI) collapse duplicate-fingerprint
 * entries the same way the live reporter's queue does, instead of showing a raw line count that
 * flush() would never actually deliver as-is.
 */
export function computeEventFingerprint(event: GlitchTipEvent): string {
  if (Array.isArray(event.fingerprint) && event.fingerprint.length > 0) {
    return buildFingerprintKey(event.fingerprint.map((part) => String(part)));
  }
  const exc = event.exception?.values?.[0];
  const type = typeof exc?.type === "string" ? exc.type : "Error";
  const msg = typeof exc?.value === "string" ? exc.value : "";
  return `${type}:${scrubString(msg).slice(0, 100)}`;
}

// --- GlitchTipReporter: lightweight native-fetch reporter ---

function generateEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

interface ScopeInterface {
  setTag(key: string, value: string): void;
  setContext(key: string, value: Record<string, unknown>): void;
  setFingerprint(value: string[]): void;
}

class GlitchTipReporter {
  private readonly storeUrl: string;
  private readonly publicKey: string;
  private readonly release: string;
  private readonly environment: string;
  private readonly sampleRate: number;
  private readonly resolvedIssues: Record<string, string>;
  private readonly pendingQueuePath?: string;
  private readonly maxPendingReports: number;
  private serverName?: string;

  private globalTags: Record<string, string> = {};
  private breadcrumbs: ReportBreadcrumb[] = [];
  private pendingFetches = new Set<Promise<void>>();
  private pendingReports = new Map<string, PendingReportRecord>();
  private pendingFingerprintIndex = new Map<string, string>();
  private inFlightReportIds = new Set<string>();
  private queueLoadPromise: Promise<void> | null = null;
  private queueLoaded = false;
  private queueWriteLock: Promise<void> = Promise.resolve();

  // Current scope — set synchronously during withScope callback
  private currentScopeTags: Record<string, string> = {};
  private currentScopeContexts: Record<string, Record<string, unknown>> = {};
  private currentScopeFingerprint: string[] | undefined;

  constructor(
    dsn: string,
    release: string,
    environment: string,
    sampleRate: number,
    resolvedIssues?: Record<string, string>,
    pendingQueuePath?: string,
    maxPendingReports?: number,
  ) {
    const url = new URL(dsn);
    this.publicKey = url.username;
    const pathSegments = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    const projectId = pathSegments.pop() || "";
    const basePath = pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "";
    this.storeUrl = `${url.protocol}//${url.host}${basePath}/api/${projectId}/store/`;
    this.release = release;
    this.environment = environment;
    this.sampleRate = sampleRate;
    this.resolvedIssues = resolvedIssues ?? {};
    this.pendingQueuePath = pendingQueuePath;
    this.maxPendingReports =
      typeof maxPendingReports === "number" && Number.isFinite(maxPendingReports) && maxPendingReports > 0
        ? Math.floor(maxPendingReports)
        : MAX_PENDING_REPORTS;
  }

  setTag(key: string, value: string): void {
    this.globalTags[key] = value;
  }

  setServerName(value: string): void {
    this.serverName = value;
  }

  addBreadcrumb(breadcrumb: { category?: string; level?: string; type?: string }): void {
    // Only allow plugin.* breadcrumbs — strip message/data to prevent leaking user content
    if (!breadcrumb.category?.startsWith("plugin.")) return;
    if (this.breadcrumbs.length >= MAX_BREADCRUMBS) {
      this.breadcrumbs.shift();
    }
    this.breadcrumbs.push({
      category: breadcrumb.category,
      level: breadcrumb.level,
      timestamp: Date.now() / 1000,
      type: breadcrumb.type,
    });
  }

  withScope(callback: (scope: ScopeInterface) => void): void {
    this.currentScopeTags = {};
    this.currentScopeContexts = {};
    this.currentScopeFingerprint = undefined;
    callback({
      setTag: (k, v) => {
        this.currentScopeTags[k] = v;
      },
      setContext: (k, v) => {
        this.currentScopeContexts[k] = v;
      },
      setFingerprint: (value) => {
        this.currentScopeFingerprint = value.slice();
      },
    });
    // Clear after callback — captureException captured the snapshot during the callback
    this.currentScopeTags = {};
    this.currentScopeContexts = {};
    this.currentScopeFingerprint = undefined;
  }

  captureException(error: Error): string {
    // Snapshot scope synchronously (called inside withScope callback)
    const scopeTags = { ...this.currentScopeTags };
    const scopeContexts = { ...this.currentScopeContexts };
    const scopeFingerprint = this.currentScopeFingerprint?.slice();
    const eventId = generateEventId();

    if (shouldDropNoisyError(error)) {
      return eventId;
    }

    // Sample rate check
    if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) {
      return eventId;
    }

    const rawEvent: GlitchTipEvent = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      release: this.release,
      environment: this.environment,
      server_name: this.serverName,
      fingerprint: scopeFingerprint,
      exception: {
        values: [
          {
            type: error.name || "Error",
            value: error.message,
            stacktrace: this.extractStacktrace(error),
          },
        ],
      },
      tags: { ...this.globalTags, ...scopeTags },
      contexts: {
        ...scopeContexts,
        runtime: { name: "node", version: process.version },
      },
      breadcrumbs: [...this.breadcrumbs],
    };

    // Sanitize: rebuild event from scratch using allowlist — drops any fields not explicitly permitted
    const sanitized = sanitizeEvent(rawEvent);
    if (!sanitized) return eventId;

    // Version-aware filter: drop events already fixed in a newer release
    if (shouldDropForResolvedIssue(sanitized, this.resolvedIssues, this.release)) {
      return eventId;
    }

    this.trackPending(this.sendWithPersistence(sanitized));

    return eventId;
  }

  async initPersistentQueue(): Promise<void> {
    await this.ensureQueueLoaded();
    this.retryPendingQueue();
  }

  async flush(timeoutMs: number): Promise<boolean> {
    await this.ensureQueueLoaded();
    this.retryPendingQueue();

    const pending = [...this.pendingFetches];
    if (pending.length === 0) return this.pendingReports.size === 0;
    try {
      let timeoutId: NodeJS.Timeout | undefined;
      let settledWithoutErrors = false;
      await Promise.race([
        Promise.allSettled(pending).then((results) => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          settledWithoutErrors = results.every((result) => result.status === "fulfilled");
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Flush timeout")), timeoutMs);
        }),
      ]);
      return settledWithoutErrors && this.pendingReports.size === 0;
    } catch {
      return false;
    }
  }

  getPendingCount(): number {
    return this.pendingReports.size;
  }

  private eventFingerprint(event: GlitchTipEvent): string {
    return computeEventFingerprint(event);
  }

  private rememberPendingFingerprint(eventId: string, event: GlitchTipEvent): void {
    this.pendingFingerprintIndex.set(this.eventFingerprint(event), eventId);
  }

  private forgetPendingFingerprint(event: GlitchTipEvent): void {
    this.pendingFingerprintIndex.delete(this.eventFingerprint(event));
  }

  private trackPending(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.pendingFetches.delete(tracked);
    });
    this.pendingFetches.add(tracked);
    // Prevent unhandled-rejection noise while still allowing flush() to observe failures.
    void tracked.catch(() => {});
  }

  private retryPendingQueue(): void {
    if (!this.pendingQueuePath || this.pendingReports.size === 0) return;
    for (const record of this.pendingReports.values()) {
      this.trackPending(this.sendPersistedRecord(record));
    }
  }

  private async sendWithPersistence(event: GlitchTipEvent): Promise<void> {
    const eventId =
      typeof event.event_id === "string" && event.event_id.length > 0 ? event.event_id : generateEventId();
    event.event_id = eventId;

    if (this.inFlightReportIds.has(eventId)) return;
    this.inFlightReportIds.add(eventId);
    let persisted = false;
    try {
      try {
        await this.ensureQueueLoaded();
      } catch (err) {
        logger.warn?.(
          `[ErrorReporter] Failed to load pending-report queue: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (this.pendingQueuePath) {
        try {
          await this.enqueuePendingReport(eventId, event);
          persisted = true;
        } catch (err) {
          logger.warn?.(
            `[ErrorReporter] Failed to persist pending report ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      await this.send(event);

      if (persisted) {
        await this.acknowledgeDelivered(eventId);
      }
    } finally {
      this.inFlightReportIds.delete(eventId);
    }
  }

  private async sendPersistedRecord(record: PendingReportRecord): Promise<void> {
    if (!this.pendingQueuePath) return;
    const eventId = record.id;
    if (this.inFlightReportIds.has(eventId)) return;

    this.inFlightReportIds.add(eventId);
    try {
      await this.send(record.event);
      await this.acknowledgeDelivered(eventId);
    } finally {
      this.inFlightReportIds.delete(eventId);
    }
  }

  private async enqueuePendingReport(eventId: string, event: GlitchTipEvent): Promise<void> {
    if (!this.pendingQueuePath) return;
    await this.withQueueLock(async () => {
      const fingerprint = this.eventFingerprint(event);
      const existingId = this.pendingFingerprintIndex.get(fingerprint);
      if (existingId && this.pendingReports.has(existingId)) {
        return;
      }
      this.pendingReports.set(eventId, { id: eventId, event, enqueuedAt: Date.now() });
      this.rememberPendingFingerprint(eventId, event);
      const pruned = this.prunePendingReportsLocked();
      await this.persistPendingReportsLocked();
      if (pruned > 0) {
        logger.warn?.(`[ErrorReporter] Pruned ${pruned} oldest pending report(s) to keep queue bounded`);
      }
    });
  }

  private async acknowledgeDelivered(eventId: string): Promise<void> {
    if (!this.pendingQueuePath) return;
    await this.withQueueLock(async () => {
      const record = this.pendingReports.get(eventId);
      if (!record) return;
      this.forgetPendingFingerprint(record.event);
      if (!this.pendingReports.delete(eventId)) return;
      await this.persistPendingReportsLocked();
    });
  }

  private async ensureQueueLoaded(): Promise<void> {
    if (!this.pendingQueuePath || this.queueLoaded) return;
    if (this.queueLoadPromise) {
      await this.queueLoadPromise;
      return;
    }

    this.queueLoadPromise = (async () => {
      let content = "";
      try {
        content = await readFile(this.pendingQueuePath as string, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.queueLoaded = true;
          return;
        }
        logger.warn?.(
          `[ErrorReporter] Failed reading pending-report queue: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }

      if (content.trim().length > 0) {
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Partial<PendingReportRecord>;
            if (typeof parsed.id !== "string" || parsed.id.length === 0) continue;
            if (!parsed.event || typeof parsed.event !== "object") continue;
            const persistedEventId =
              typeof parsed.event.event_id === "string" && parsed.event.event_id.length > 0
                ? parsed.event.event_id
                : parsed.id;
            const event = { ...parsed.event, event_id: persistedEventId };
            const fingerprint = this.eventFingerprint(event);
            const existingId = this.pendingFingerprintIndex.get(fingerprint);
            if (existingId && this.pendingReports.has(existingId)) {
              continue;
            }
            this.pendingReports.set(persistedEventId, {
              id: persistedEventId,
              event,
              enqueuedAt: typeof parsed.enqueuedAt === "number" ? parsed.enqueuedAt : Date.now(),
            });
            this.rememberPendingFingerprint(persistedEventId, event);
          } catch (err) {
            logger.warn?.(
              `[ErrorReporter] Failed parsing pending-report queue line, skipping: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const pruned = this.prunePendingReportsLocked();
      if (pruned > 0) {
        try {
          await this.persistPendingReportsLocked();
        } catch (persistErr) {
          logger.warn?.(
            `[ErrorReporter] Failed persisting pruned queue during load (continuing): ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          );
        }
        logger.warn?.(`[ErrorReporter] Pruned ${pruned} oldest pending report(s) during queue load`);
      }

      this.queueLoaded = true;
    })().finally(() => {
      this.queueLoadPromise = null;
    });

    await this.queueLoadPromise;
  }

  private prunePendingReportsLocked(): number {
    let pruned = 0;
    while (this.pendingReports.size > this.maxPendingReports) {
      const oldestId = this.pendingReports.keys().next().value as string | undefined;
      if (!oldestId) break;
      const record = this.pendingReports.get(oldestId);
      if (record) this.forgetPendingFingerprint(record.event);
      this.pendingReports.delete(oldestId);
      pruned++;
    }
    return pruned;
  }

  private async persistPendingReportsLocked(): Promise<void> {
    if (!this.pendingQueuePath) return;

    if (this.pendingReports.size === 0) {
      await rm(this.pendingQueuePath, { force: true });
      return;
    }

    const dir = dirname(this.pendingQueuePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.pendingQueuePath}.tmp`;
    const payload = `${[...this.pendingReports.values()].map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(tmpPath, payload, "utf-8");
    await rename(tmpPath, this.pendingQueuePath);
  }

  private async withQueueLock<T>(op: () => Promise<T>): Promise<T> {
    const prev = this.queueWriteLock;
    let releaseLock: () => void;
    this.queueWriteLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    await prev;
    try {
      return await op();
    } finally {
      // biome-ignore lint/style/noNonNullAssertion: Synchronous release initialized in Promise ctor.
      releaseLock!();
    }
  }

  private extractStacktrace(error: Error): ReportStacktrace | undefined {
    if (!error.stack) return undefined;
    const lines = error.stack.split("\n").slice(1); // skip "Error: message" first line
    const frames: ReportFrame[] = lines
      .map((line): ReportFrame | null => {
        if (line.length > 500) return null; // ReDoS guard: skip abnormally long lines
        const trimmed = line.trimStart();
        if (!trimmed.startsWith("at ")) return null; // fast path avoids regex on non-frame lines
        const match = trimmed.match(/^at (?:([^()\n]+) \()?([^)\n]+):(\d+):(\d+)\)?/);
        if (!match) return null;
        return {
          function: match[1] || "<anonymous>",
          filename: sanitizePath(match[2]),
          lineno: Number.parseInt(match[3], 10),
          colno: Number.parseInt(match[4], 10),
          in_app: !match[2].includes("node_modules"),
        };
      })
      .filter((f): f is ReportFrame => f !== null)
      .reverse();
    return frames.length > 0 ? { frames } : undefined;
  }

  private async send(event: GlitchTipEvent): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const authHeader = `Sentry sentry_version=7, sentry_timestamp=${timestamp}, sentry_client=openclaw-hybrid-memory/native, sentry_key=${this.publicKey}`;
    const resp = await fetch(this.storeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": authHeader,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    const body = await resp.text();
    if (!resp.ok) {
      throw new Error(`GlitchTip rejected event: HTTP ${resp.status} ${body}`);
    }
  }
}

// --- Module-level singleton state ---

let reporter: GlitchTipReporter | null = null;
let initialized = false;
let logger: any = console; // Default fallback to console
const errorDedup = new Map<string, number>(); // Rate limiting: fingerprint -> timestamp
const CHRONIC_FINGERPRINT_DEDUPE_MS = 24 * 60 * 60 * 1000;
let telemetryMuteReason: string | null = null;

/** Test-only: clear in-memory rate-limit state between cases. */
export function resetErrorDedupForTests(): void {
  errorDedup.clear();
}

function buildFingerprintKey(fingerprint: string[]): string {
  return fingerprint.map((part) => scrubString(String(part))).join(":");
}

export function setErrorReporterMuted(muted: boolean, reason?: string): void {
  telemetryMuteReason = muted ? (reason ?? "muted") : null;
}

export function getErrorReporterMuteReason(): string | null {
  return telemetryMuteReason;
}

function resolveNodeName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate =
    typeof env.OPENCLAW_NODE_NAME === "string" && env.OPENCLAW_NODE_NAME.trim()
      ? env.OPENCLAW_NODE_NAME.trim()
      : undefined;

  if (!candidate) return undefined;

  return (
    scrubString(candidate)
      .slice(0, 128)
      .replace(/[\x00-\x1f\x7f]/g, "") || undefined
  );
}

type DsnResolution = { dsn: string; source: "env" | "community" | "self-hosted" } | { error: string };

/**
 * Shared DSN precedence: `ERROR_REPORTING_DSN` env override, then community mode's `config.dsn`
 * fallback to `COMMUNITY_DSN`, then self-hosted mode's required `config.dsn`. Used by both
 * initErrorReporter (the module-level singleton) and attemptOneShotErrorReportFlush (#2082's
 * isolated one-shot reporter) so a future precedence change only needs applying once.
 */
function resolveDsn(config: Pick<ErrorReporterConfig, "dsn" | "mode">): DsnResolution {
  const rawEnvDsn = getEnv("ERROR_REPORTING_DSN");
  const envDsn = typeof rawEnvDsn === "string" && rawEnvDsn.trim().length > 0 ? rawEnvDsn.trim() : "";
  if (envDsn) return { dsn: envDsn, source: "env" };
  if (config.mode === "community") return { dsn: config.dsn || COMMUNITY_DSN, source: "community" };
  if (!config.dsn) return { error: "self-hosted mode requires a DSN but none was provided" };
  return { dsn: config.dsn, source: "self-hosted" };
}

/**
 * Initialize error reporter with STRICT privacy settings.
 * Optionally pass runtimeBotId from OpenClaw plugin context (e.g. api.context?.agentId) to use as bot UUID when config.botId is not set.
 */
export async function initErrorReporter(
  config: ErrorReporterConfig,
  pluginVersion: string,
  loggerInstance?: any,
  runtimeBotId?: string,
): Promise<void> {
  if (loggerInstance) {
    logger = loggerInstance;
  }

  if (!config.enabled || !config.consent) {
    logger.info?.("[ErrorReporter] Disabled: enabled=%s, consent=%s", config.enabled, config.consent);
    return;
  }

  const dsnResult = resolveDsn(config);
  if ("error" in dsnResult) {
    logger.warn?.("[ErrorReporter] Self-hosted mode requires a DSN but none was provided. Error reporting disabled.");
    return;
  }
  const resolvedDsn = dsnResult.dsn;
  const dsnSourceMessage = {
    env: "[ErrorReporter] Using DSN from ERROR_REPORTING_DSN",
    community: "[ErrorReporter] Using community mode (anonymous telemetry)",
    "self-hosted": "[ErrorReporter] Using self-hosted mode",
  }[dsnResult.source];
  logger.info?.(dsnSourceMessage);

  const releaseStr = `openclaw-hybrid-memory@${pluginVersion}`;

  try {
    reporter = new GlitchTipReporter(
      resolvedDsn,
      releaseStr,
      config.environment || "production",
      config.sampleRate ?? 1.0,
      config.resolvedIssues,
      config.pendingQueuePath,
      config.maxPendingReports,
    );
  } catch (err) {
    logger.warn?.(
      "[ErrorReporter] Failed to initialize reporter, error reporting disabled:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  try {
    await reporter.initPersistentQueue();
  } catch (err) {
    logger.warn?.(
      "[ErrorReporter] Failed to initialize persistent queue (continuing with in-memory only):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Bot identity: config first, then OpenClaw context (e.g. api.context?.agentId).
  // When neither is configured, bot_id is omitted entirely — no hostname fallback to prevent leaks.
  const botUuid =
    config.botId || (typeof runtimeBotId === "string" && runtimeBotId.trim() ? runtimeBotId.trim() : undefined);
  let nodeName: string | undefined;
  try {
    nodeName = resolveNodeName();
  } catch {
    nodeName = undefined;
  }
  const botName = config.botName
    ? scrubString(config.botName)
        .slice(0, 64)
        .replace(/[\x00-\x1f\x7f]/g, "")
    : undefined;
  if (nodeName) {
    reporter.setServerName(nodeName);
    reporter.setTag("node", nodeName);
  }
  if (botUuid) {
    reporter.setTag("agent_id", botUuid);
    reporter.setTag("bot_id", botUuid);
  }
  if (botName) {
    reporter.setTag("agent_name", botName);
    reporter.setTag("bot_name", botName);
    logger.debug?.("[ErrorReporter] Bot name set (opt-in)");
  } else {
    logger.debug?.("[ErrorReporter] Bot name omitted (not configured — privacy default)");
  }

  initialized = true;
  const dsnHost = resolvedDsn.split("@")[1] || "***";
  logger.info?.("[ErrorReporter] Initialized with DSN host:", dsnHost);
  scheduleStartupErrorReporterDrain();
}

/** Adaptive shutdown flush budget from pending queue depth (#1978). */
export function computeShutdownFlushTimeoutMs(pendingCount: number): number {
  if (pendingCount <= 0) return 2000;
  return Math.min(30_000, Math.max(2000, pendingCount * 50));
}

export function getPendingErrorReportCount(): number {
  return reporter?.getPendingCount() ?? 0;
}

/** Default on-disk pending queue path next to the SQLite memory DB. */
export function resolveErrorReportPendingQueuePath(resolvedSqlitePath: string): string | undefined {
  if (resolvedSqlitePath === ":memory:") return undefined;
  return join(dirname(resolvedSqlitePath), ".error_reports.pending.jsonl");
}

/** Count pending telemetry lines on disk (works when reporter is not initialized). */
export function countPendingErrorReportsOnDisk(queuePath?: string): number {
  if (!queuePath) return 0;
  try {
    if (!existsSync(queuePath)) return 0;
    const content = readFileSync(queuePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/** Reporter in-memory count plus on-disk queue when reporter is cold (e.g. verify CLI). */
export function resolvePendingErrorReportCount(resolvedSqlitePath?: string): number {
  const active = getPendingErrorReportCount();
  if (active > 0) return active;
  const queuePath = resolvedSqlitePath ? resolveErrorReportPendingQueuePath(resolvedSqlitePath) : undefined;
  return countPendingErrorReportsOnDisk(queuePath);
}

/** Oldest/newest `enqueuedAt` (ms epoch) across the on-disk pending queue, or null when empty/absent. */
export function readPendingErrorReportEnqueueRange(queuePath?: string): { oldest: number; newest: number } | null {
  const entries = readPendingErrorReportEntries(queuePath);
  if (entries.length === 0) return null;
  let oldest = entries[0].enqueuedAt;
  let newest = entries[0].enqueuedAt;
  for (const entry of entries) {
    if (entry.enqueuedAt < oldest) oldest = entry.enqueuedAt;
    if (entry.enqueuedAt > newest) newest = entry.enqueuedAt;
  }
  return { oldest, newest };
}

export interface PendingErrorReportSummary {
  id: string;
  enqueuedAt: number;
  eventTimestamp?: number;
  type: string;
  message: string;
  subsystem?: string;
  operation?: string;
}

function summarizePendingReportRecord(record: PendingReportRecord): PendingErrorReportSummary {
  const exc = record.event.exception?.values?.[0];
  return {
    id: record.id,
    enqueuedAt: record.enqueuedAt,
    eventTimestamp: typeof record.event.timestamp === "number" ? record.event.timestamp : undefined,
    type: typeof exc?.type === "string" && exc.type.length > 0 ? exc.type : "Error",
    message: typeof exc?.value === "string" ? exc.value : "",
    subsystem: record.event.tags?.subsystem,
    operation: record.event.tags?.operation,
  };
}

/**
 * Read pending report entries directly off disk (works whether or not the reporter is active in
 * this process — issue #2082). Returns oldest-first, optionally capped to `limit`.
 */
export function readPendingErrorReportEntries(queuePath?: string, limit?: number): PendingErrorReportSummary[] {
  if (!queuePath) return [];
  let content: string;
  try {
    if (!existsSync(queuePath)) return [];
    content = readFileSync(queuePath, "utf-8");
  } catch {
    return [];
  }

  const records: PendingReportRecord[] = [];
  // Same fingerprint-dedup GlitchTipReporter.ensureQueueLoaded() applies (first occurrence wins)
  // so this disk-level view doesn't show duplicate-fingerprint entries flush() would collapse.
  const seenFingerprints = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<PendingReportRecord>;
      if (typeof parsed.id !== "string" || parsed.id.length === 0) continue;
      if (!parsed.event || typeof parsed.event !== "object") continue;
      const fingerprint = computeEventFingerprint(parsed.event);
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
      records.push({
        id: parsed.id,
        event: parsed.event,
        enqueuedAt: typeof parsed.enqueuedAt === "number" ? parsed.enqueuedAt : 0,
      });
    } catch {
      // Skip unparseable lines — mirrors GlitchTipReporter's own queue-load tolerance.
    }
  }

  records.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const bounded = typeof limit === "number" && limit >= 0 ? records.slice(0, limit) : records;
  return bounded.map(summarizePendingReportRecord);
}

export interface OneShotErrorReportFlushResult {
  attempted: boolean;
  /** Set when attempted is false, explaining why no network flush was tried. */
  reason?: string;
  pendingBefore: number;
  pendingAfter: number;
  flushed: boolean;
}

/**
 * One-shot bounded flush for CLI use (#2082). Constructs an isolated reporter instance scoped to
 * this call only — unlike initErrorReporter(), it never touches the module-level reporter/
 * initialized state, so it is safe to call from a bare CLI process without side effects on the
 * wider plugin error-reporting lifecycle. Callers should prefer flushErrorReporter() when
 * isErrorReporterActive() is already true in this process, to avoid two reporters racing the same
 * on-disk queue file.
 */
export async function attemptOneShotErrorReportFlush(
  config: Pick<
    ErrorReporterConfig,
    "enabled" | "dsn" | "mode" | "consent" | "environment" | "sampleRate" | "resolvedIssues" | "maxPendingReports"
  >,
  pendingQueuePath: string | undefined,
  pluginVersion: string,
  timeoutMs: number,
): Promise<OneShotErrorReportFlushResult> {
  const empty = { pendingBefore: 0, pendingAfter: 0, flushed: false };
  if (!config.enabled || !config.consent) {
    return { attempted: false, reason: "error reporting disabled (enabled=false or consent=false)", ...empty };
  }
  if (!pendingQueuePath) {
    return { attempted: false, reason: "no on-disk pending queue configured (in-memory database)", ...empty };
  }

  const dsnResult = resolveDsn(config);
  if ("error" in dsnResult) {
    return { attempted: false, reason: dsnResult.error, ...empty };
  }
  const resolvedDsn = dsnResult.dsn;

  let oneShotReporter: GlitchTipReporter;
  try {
    oneShotReporter = new GlitchTipReporter(
      resolvedDsn,
      `openclaw-hybrid-memory@${pluginVersion}`,
      config.environment || "production",
      config.sampleRate ?? 1.0,
      config.resolvedIssues,
      pendingQueuePath,
      config.maxPendingReports,
    );
  } catch (err) {
    return {
      attempted: false,
      reason: `failed to construct reporter: ${err instanceof Error ? err.message : String(err)}`,
      ...empty,
    };
  }

  await oneShotReporter.initPersistentQueue();
  const pendingBefore = oneShotReporter.getPendingCount();
  const flushed = await oneShotReporter.flush(timeoutMs);
  const pendingAfter = oneShotReporter.getPendingCount();
  return { attempted: true, pendingBefore, pendingAfter, flushed };
}

function scheduleStartupErrorReporterDrain(): void {
  if (!reporter) return;
  void (async () => {
    try {
      await reporter?.initPersistentQueue();
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const count = reporter?.getPendingCount() ?? 0;
        if (count === 0) {
          if (attempt === 1) return;
          logger.info?.("[ErrorReporter] Startup pending queue drained");
          return;
        }
        if (attempt === 1) {
          logger.info?.(`[ErrorReporter] Draining ${count} pending report(s) from previous run`);
        }
        const flushed = await reporter?.flush(computeShutdownFlushTimeoutMs(count));
        if (flushed) {
          logger.info?.("[ErrorReporter] Startup pending queue drained");
          return;
        }
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      const remaining = reporter?.getPendingCount() ?? 0;
      if (remaining > 0) {
        logger.warn?.(
          `[ErrorReporter] Startup drain incomplete (${remaining} pending); run \`openclaw hybrid-mem verify\` to inspect the telemetry queue`,
        );
      }
    } catch (err) {
      logger.debug?.(`[ErrorReporter] Startup drain failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

/**
 * Capture a plugin error with context
 */
export function capturePluginError(
  error: Error,
  context: {
    operation: string;
    /** Subsystem (e.g. "cli", "reflection", "credentials"). Default "plugin". */
    subsystem?: string;
    configShape?: Record<string, string>;
    phase?: string;
    backend?: string;
    retryAttempt?: number;
    memoryCount?: number;
    /** Severity level (e.g. "info", "warning", "error"). Not sent to reporter, used for local logging/filtering. */
    severity?: string;
    fingerprint?: string[];
    tags?: Record<string, string | number | boolean | undefined>;
    contexts?: Record<string, Record<string, unknown>>;
    /** Additional context fields for specific operations */
    [key: string]: unknown;
  },
): string | undefined {
  if (shouldDropNoisyError(error)) return undefined;
  if (telemetryMuteReason) return undefined;

  if (!initialized || !reporter) {
    return undefined;
  }

  // Rate limiting: default 60s; chronic fingerprinted warnings use 24h (#1988)
  const fingerprint =
    Array.isArray(context.fingerprint) && context.fingerprint.length > 0
      ? buildFingerprintKey(context.fingerprint)
      : `${error.name}:${scrubString(error.message).slice(0, 100)}`;
  const dedupeWindowMs =
    context.operation === "invalid_goal_registry_entry" &&
    Array.isArray(context.fingerprint) &&
    context.fingerprint.length > 0
      ? CHRONIC_FINGERPRINT_DEDUPE_MS
      : 60000;
  const now = Date.now();
  const lastSeen = errorDedup.get(fingerprint);
  if (lastSeen && now - lastSeen < dedupeWindowMs) {
    return undefined; // Skip duplicate
  }
  errorDedup.set(fingerprint, now);

  // Prevent memory leak: prune stale entries periodically
  if (errorDedup.size % 10 === 0) {
    for (const [key, ts] of errorDedup) {
      if (now - ts > CHRONIC_FINGERPRINT_DEDUPE_MS) errorDedup.delete(key);
    }
  }

  const subsystem = context.subsystem ?? "plugin";
  let eventId: string | undefined;
  reporter.withScope((scope) => {
    scope.setTag("subsystem", subsystem);
    scope.setTag("operation", context.operation);
    if (context.phase) scope.setTag("phase", context.phase);
    if (context.backend) scope.setTag("backend", context.backend);
    if (context.retryAttempt !== undefined) scope.setTag("retryAttempt", String(context.retryAttempt));
    if (context.memoryCount !== undefined) scope.setTag("memoryCount", String(context.memoryCount));
    if (Array.isArray(context.fingerprint) && context.fingerprint.length > 0) {
      scope.setFingerprint(context.fingerprint.map((part) => scrubString(String(part))));
    }
    if (context.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        if (value === undefined || value === null) continue;
        scope.setTag(key, String(value));
      }
    }
    if (context.configShape) {
      scope.setContext("config_shape", context.configShape);
    }
    if (context.contexts) {
      for (const [key, value] of Object.entries(context.contexts)) {
        scope.setContext(key, value);
      }
    }
    eventId = reporter?.captureException(error);
  });

  return eventId;
}

/**
 * Check if error reporter is active
 */
export function isErrorReporterActive(): boolean {
  return initialized;
}

/**
 * Flush pending error reports with timeout
 */
export async function flushErrorReporter(timeoutMs?: number): Promise<boolean> {
  if (!initialized || !reporter) {
    return false;
  }
  const budget =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : computeShutdownFlushTimeoutMs(reporter.getPendingCount());
  try {
    return await reporter.flush(budget);
  } catch (err) {
    logger.warn?.("[ErrorReporter] Flush failed:", err);
    return false;
  }
}

/**
 * Test error reporter diagnostics
 */
export function testErrorReporter(): { ok: boolean; error?: string } {
  if (!initialized || !reporter) {
    return { ok: false, error: "Error reporter not initialized (consent or disabled)" };
  }
  return { ok: true };
}

/**
 * Capture a test error to verify reporting works
 */
export function captureTestError(): string | null {
  if (telemetryMuteReason) {
    return null;
  }
  if (!initialized || !reporter) {
    return null;
  }
  try {
    const testError = new Error("Test error from captureTestError()");
    return reporter.captureException(testError);
  } catch (err) {
    logger.warn?.("[ErrorReporter] captureTestError failed:", err);
    return null;
  }
}

/**
 * Add operation breadcrumb for plugin subsystems
 */
export function addOperationBreadcrumb(subsystem: string, operation: string): void {
  if (!reporter || !initialized) return;
  reporter.addBreadcrumb({
    category: `plugin.${subsystem}.${operation}`,
    level: "info",
  });
}
