/**
 * Error Reporter Service for GlitchTip/Sentry Integration
 *
 * SECURITY REQUIREMENTS (NON-NEGOTIABLE):
 * - consent: true by default — user must explicitly opt OUT
 * - sendDefaultPii: false always
 * - maxBreadcrumbs: 10 — only plugin.* category allowed, message/data stripped
 * - Only safe Sentry integrations enabled: LinkedErrors, InboundFilters, FunctionToString
 * - beforeSend rebuilds event from scratch using allowlist
 * - NEVER include: memory text, prompts, API keys, home paths, IPs, emails
 * - Rate limiting: 60s dedup window for same error fingerprint
 */

import * as SentryType from "@sentry/node";
import { isVersionAtLeast } from "../utils/version-check.js";

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
  maxBreadcrumbs: number; // PRIVACY: Always passed as 0 (breadcrumbs can contain user prompts). Not user-configurable.
  sampleRate: number;  // 0.0-1.0, default 1.0
  consent: boolean;    // explicit opt-in required
  /**
   * Opt-in: Only sent when explicitly configured. Not sent by default for privacy.
   * Optional UUID for this bot instance; sent as tag so GlitchTip can group errors by bot.
   */
  botId?: string;
  /**
   * Opt-in: Only sent when explicitly configured. Not sent by default for privacy.
   * Optional friendly name (e.g. Maeve, Doris); sent as tag for readable reports.
   */
  botName?: string;
  /**
   * Optional map of error fingerprints to the version that fixed them.
   * Errors matching a fingerprint from an older version are silently dropped (not regressions).
   * Format: { "ErrorType:message prefix (first 100 chars)": "YYYY.M.NNN" }
   * When not configured, behavior is identical to today.
   */
  resolvedIssues?: Record<string, string>;
}

/** Hardcoded DSN for community error reporting (anonymous telemetry) */
const COMMUNITY_DSN = DEFAULT_GLITCHTIP_DSN;

/**
 * Extract version string from a release identifier.
 * "openclaw-hybrid-memory@2026.3.110" → "2026.3.110"
 * Returns null if the release string can't be parsed.
 */
export function extractVersion(release: string): string | null {
  if (!release) return null;
  const atIdx = release.indexOf('@');
  if (atIdx < 0) return null;
  const version = release.slice(atIdx + 1);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return version;
}

/**
 * Check whether an event should be dropped because it matches a known-fixed issue
 * and the event's release version is older than the fix.
 * Returns true (drop) only when: fingerprint matches AND version < fixedInVersion.
 * If event release can't be parsed, returns false (safe default: let through).
 */
export function shouldDropForResolvedIssue(
  event: SentryType.Event,
  resolvedIssues: Record<string, string>,
  fallbackRelease?: string,
): boolean {
  if (!resolvedIssues || Object.keys(resolvedIssues).length === 0) return false;

  const errType = event.exception?.values?.[0]?.type || "Error";
  const errValue = event.exception?.values?.[0]?.value || "";
  const fingerprint = `${errType}:${errValue.slice(0, 100)}`;

  const fixedInVersion = resolvedIssues[fingerprint];
  if (!fixedInVersion || typeof fixedInVersion !== "string") return false;

  const releaseStr = event.release || fallbackRelease || "";
  const eventVersion = extractVersion(releaseStr);
  if (!eventVersion) return false;

  return !isVersionAtLeast(eventVersion, fixedInVersion);
}

const Sentry: typeof SentryType | null = SentryType;
let initialized = false;
let logger: any = console; // Default fallback to console
const errorDedup = new Map<string, number>(); // Rate limiting: fingerprint -> timestamp

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
    logger.info?.('[ErrorReporter] Disabled: enabled=%s, consent=%s',
      config.enabled, config.consent);
    return;
  }

  // Resolve DSN based on mode
  let resolvedDsn: string;
  if (config.mode === "community") {
    // Community mode: allow override via config.dsn, otherwise use COMMUNITY_DSN
    resolvedDsn = config.dsn || COMMUNITY_DSN;
    logger.info?.('[ErrorReporter] Using community mode (anonymous telemetry)');
  } else {
    // self-hosted mode
    if (!config.dsn) {
      logger.warn?.('[ErrorReporter] Self-hosted mode requires a DSN but none was provided. Error reporting disabled.');
      return;
    }
    resolvedDsn = config.dsn;
    logger.info?.('[ErrorReporter] Using self-hosted mode');
  }

  if (!Sentry) return;

  const releaseStr = `openclaw-hybrid-memory@${pluginVersion}`;
  const resolvedIssues = config.resolvedIssues;

  Sentry.init({
    dsn: resolvedDsn,
    release: releaseStr,
    environment: config.environment || "production",
    sampleRate: config.sampleRate ?? 1.0,
    maxBreadcrumbs: 10,          // Limited safe breadcrumbs for plugin operations
    sendDefaultPii: false,       // NO PII
    autoSessionTracking: false,  // NO session tracking
    integrations: (defaults) => defaults.filter(i => ["LinkedErrors", "InboundFilters", "FunctionToString"].includes(i.name)), // Keep only safe integrations
    beforeSend(event): SentryType.ErrorEvent | PromiseLike<SentryType.ErrorEvent | null> | null {
      // Sanitize first (allowlist rebuild; event.release is preserved from Sentry.init)
      const sanitized = sanitizeEvent(event) as SentryType.ErrorEvent | null;
      if (!sanitized) return null;

      // Version-aware filtering: drop events already fixed in a newer release
      if (resolvedIssues && shouldDropForResolvedIssue(sanitized, resolvedIssues, releaseStr)) {
        return null;
      }

      return sanitized;
    },
    beforeBreadcrumb(breadcrumb) {
      // Only allow breadcrumbs with category starting with "plugin."
      if (breadcrumb.category?.startsWith('plugin.')) {
        // Strip message and data to prevent leaking user content
        return {
          ...breadcrumb,
          message: undefined,
          data: undefined,
        };
      }
      return null; // Drop all other breadcrumbs
    },
  });

  // Bot identity: config first, then OpenClaw context (e.g. api.context?.agentId).
  // When neither is configured, bot_id is omitted entirely — no hostname fallback to prevent leaks.
  const botUuid = config.botId || (typeof runtimeBotId === "string" && runtimeBotId.trim() ? runtimeBotId.trim() : undefined);
  const botName = config.botName ? scrubString(config.botName).slice(0, 64).replace(/[\x00-\x1f\x7f]/g, "") : undefined;
  if (botUuid) {
    Sentry.setTag("bot_id", botUuid);
  }
  if (botName) {
    Sentry.setTag("bot_name", botName);
    logger.info?.('[ErrorReporter] Bot name set (opt-in)');
  } else {
    logger.info?.('[ErrorReporter] Bot name omitted (not configured — privacy default)');
  }

  initialized = true;
  const dsnHost = resolvedDsn.split('@')[1] || '***';
  logger.info?.('[ErrorReporter] Initialized with DSN host:', dsnHost);
}

/**
 * Sanitize event using ALLOWLIST approach: rebuild event with only safe fields
 */
export function sanitizeEvent(event: SentryType.Event): SentryType.Event | null {
  if (!event) return null;

  const safe: SentryType.Event = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "node",
    level: event.level,
    release: event.release,
    environment: event.environment,
    fingerprint: event.fingerprint,
    // Only keep exception type and sanitized message
    exception: event.exception ? {
      values: event.exception.values?.map(v => ({
        type: v.type,
        value: scrubString(v.value || ""),
        stacktrace: v.stacktrace ? {
          frames: v.stacktrace.frames?.map(f => ({
            filename: sanitizePath(f.filename || ""),
            function: f.function,
            lineno: f.lineno,
            colno: f.colno,
            in_app: f.in_app,
            // NO: abs_path, context_line, pre_context, post_context, vars
          }))
        } : undefined,
      }))
    } : undefined,
    tags: {
      subsystem: event.tags?.subsystem ? scrubString(String(event.tags.subsystem)) : undefined,
      operation: event.tags?.operation ? scrubString(String(event.tags.operation)) : undefined,
      phase: event.tags?.phase ? scrubString(String(event.tags.phase)) : undefined,
      backend: event.tags?.backend ? scrubString(String(event.tags.backend)) : undefined,
      bot_id: event.tags?.bot_id ? scrubString(String(event.tags.bot_id)) : undefined,
      bot_name: event.tags?.bot_name ? scrubString(String(event.tags.bot_name).slice(0, 64)) : undefined,
    },
    contexts: {
      ...(event.contexts?.config_shape ? {
        config_shape: Object.fromEntries(
          Object.entries(event.contexts.config_shape).map(([k, v]) => [
            k,
            typeof v === 'string' ? scrubString(v) : v
          ])
        )
      } : {}),
      ...(event.contexts?.runtime ? {
        runtime: { name: event.contexts.runtime.name, version: event.contexts.runtime.version }
      } : {}),
      ...(event.contexts?.os ? {
        os: { name: event.contexts.os.name } // Only name, no version
      } : {}),
    },
    breadcrumbs: event.breadcrumbs?.filter(b => b.category?.startsWith('plugin.')).map(b => ({
      category: b.category,
      level: b.level,
      timestamp: b.timestamp,
      type: b.type,
      // Strip message and data to prevent leaking user content
    })),
    // Preserve user.id and user.username for GlitchTip "Users Affected" and grouping
    user: event.user ? {
      id: event.user.id ? scrubString(String(event.user.id)) : undefined,
      username: event.user.username ? scrubString(String(event.user.username)) : undefined,
    } : undefined,
    // NO: request, contexts.device, extra
  };

  return safe;
}

/**
 * Scrub sensitive data from strings
 */
export function scrubString(input: string): string {
  return input
    // API keys (OpenAI, Anthropic, GitHub)
    .replace(/sk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_]{20,})/g, '[REDACTED]')  // OpenAI (sk-, sk-proj-)
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED]')       // Anthropic
    .replace(/ghp_[A-Za-z0-9]{36}/g, '[REDACTED]')             // GitHub PAT
    .replace(/gho_[A-Za-z0-9]{36}/g, '[REDACTED]')             // GitHub OAuth
    .replace(/Bearer\s+[\w.-]+/gi, '[REDACTED]')
    // JWT tokens (eyJ...)
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    // AWS and other cloud credentials
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')                // AWS access keys
    // Slack tokens
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')    // Slack tokens
    // Private keys
    .replace(/-----BEGIN .*PRIVATE KEY/g, '[REDACTED]')        // Private key headers
    // Connection strings with embedded passwords (generic + specific)
    .replace(/:\/\/[^\s:@]+:[^\s@]+@[^\s/]+/g, '://[REDACTED]@')
    .replace(/postgres:\/\/[^\s]+/g, 'postgres://[REDACTED]')
    .replace(/mysql:\/\/[^\s]+/g, 'mysql://[REDACTED]')
    .replace(/redis:\/\/[^\s]+/g, 'redis://[REDACTED]')
    .replace(/mongodb:\/\/[^\s]+/g, 'mongodb://[REDACTED]')
    // Paths
    .replace(/\/home\/[^/\s]+/g, '$HOME')
    .replace(/\/Users\/[^/\s]+/g, '$HOME')
    .replace(/C:\\Users\\[^\\\s]+/g, '%USERPROFILE%')
    // PII
    .replace(/\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, '[EMAIL]')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]')
    // Truncate
    .slice(0, 500);
}

/**
 * Sanitize file paths: keep only relative plugin paths
 */
export function sanitizePath(path: string): string {
  // Try multiple possible plugin directory markers
  const markers = [
    'extensions/openclaw-hybrid-memory/',
    'extensions/memory-hybrid/',
    'openclaw-hybrid-memory/',
  ];

  for (const marker of markers) {
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      return path.slice(idx);
    }
  }

  // Fallback: if path contains node_modules or extensions, return basename
  if (path.includes('node_modules') || path.includes('extensions')) {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }

  // Scrub user-specific paths
  return path
    .replace(/\/home\/[^/]+/g, '$HOME')
    .replace(/\/Users\/[^/]+/g, '$HOME')
    .replace(/C:\\Users\\[^\\]+/g, '%USERPROFILE%');
}

/**
 * Capture a plugin error with context
 */
export function capturePluginError(error: Error, context: {
  operation: string;
  /** Subsystem (e.g. "cli", "reflection", "credentials"). Default "plugin". */
  subsystem?: string;
  configShape?: Record<string, string>;
  phase?: string;
  backend?: string;
  retryAttempt?: number;
  memoryCount?: number;
  /** Severity level (e.g. "info", "warning", "error"). Not sent to Sentry, used for local logging/filtering. */
  severity?: string;
  /** Additional context fields for specific operations */
  [key: string]: unknown;
}): string | undefined {
  if (!initialized || !Sentry) {
    return undefined;
  }

  // Rate limiting: dedup same errors within 60s
  const fingerprint = `${error.name}:${scrubString(error.message).slice(0, 100)}`;
  const now = Date.now();
  const lastSeen = errorDedup.get(fingerprint);
  if (lastSeen && (now - lastSeen) < 60000) {
    return undefined; // Skip duplicate
  }
  errorDedup.set(fingerprint, now);

  // Prevent memory leak: prune stale entries every 10 new entries
  if (errorDedup.size % 10 === 0) {
    for (const [key, ts] of errorDedup) {
      if (now - ts > 60000) errorDedup.delete(key);
    }
  }

  const subsystem = context.subsystem ?? "plugin";
  let eventId: string | undefined;
  Sentry.withScope((scope) => {
    scope.setTag("subsystem", subsystem);
    scope.setTag("operation", context.operation);
    if (context.phase) scope.setTag("phase", context.phase);
    if (context.backend) scope.setTag("backend", context.backend);
    if (context.retryAttempt !== undefined) scope.setTag("retryAttempt", String(context.retryAttempt));
    if (context.memoryCount !== undefined) scope.setTag("memoryCount", String(context.memoryCount));
    if (context.configShape) {
      scope.setContext("config_shape", context.configShape);
    }
    eventId = Sentry!.captureException(error);
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
export async function flushErrorReporter(timeoutMs = 2000): Promise<boolean> {
  if (!initialized || !Sentry) {
    return false;
  }
  try {
    return await Sentry.flush(timeoutMs);
  } catch (err) {
    logger.warn?.('[ErrorReporter] Flush failed:', err);
    return false;
  }
}

/**
 * Test error reporter diagnostics
 */
export function testErrorReporter(): { ok: boolean; error?: string } {
  if (!Sentry) {
    return { ok: false, error: "@sentry/node not loaded" };
  }
  if (!initialized) {
    return { ok: false, error: "Error reporter not initialized (consent or disabled)" };
  }
  return { ok: true };
}

/**
 * Capture a test error to verify reporting works
 */
export function captureTestError(): string | null {
  if (!initialized || !Sentry) {
    return null;
  }
  try {
    const testError = new Error("Test error from captureTestError()");
    return Sentry.captureException(testError);
  } catch (err) {
    logger.warn?.('[ErrorReporter] captureTestError failed:', err);
    return null;
  }
}

/**
 * Add operation breadcrumb for plugin subsystems
 */
export function addOperationBreadcrumb(subsystem: string, operation: string): void {
  if (!Sentry || !initialized) return;
  Sentry.addBreadcrumb({
    category: `plugin.${subsystem}.${operation}`,
    level: "info"
  });
}
