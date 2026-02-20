/**
 * Error Reporter Service for GlitchTip/Sentry Integration
 * 
 * SECURITY REQUIREMENTS (NON-NEGOTIABLE):
 * - consent: false by default — user must explicitly opt in
 * - sendDefaultPii: false always
 * - maxBreadcrumbs: 0 — breadcrumbs can contain user prompts
 * - ALL default Sentry integrations disabled (they capture HTTP requests, console output, etc.)
 * - beforeSend rebuilds event from scratch using allowlist
 * - NEVER include: memory text, prompts, API keys, home paths, IPs, emails
 */

import type * as SentryType from "@sentry/node";

export interface ErrorReporterConfig {
  enabled: boolean;
  dsn: string;        // Sentry/GlitchTip DSN
  environment?: string; // "production" | "development"
  maxBreadcrumbs: number; // PRIVACY: Always passed as 0 (breadcrumbs can contain user prompts). Not user-configurable.
  sampleRate: number;  // 0.0-1.0, default 1.0
  consent: boolean;    // explicit opt-in required
}

let Sentry: typeof SentryType | null = null;
let initialized = false;
let logger: any = console; // Default fallback to console

/**
 * Initialize error reporter with STRICT privacy settings
 */
export async function initErrorReporter(
  config: ErrorReporterConfig, 
  pluginVersion: string,
  loggerInstance?: any
): Promise<void> {
  if (loggerInstance) {
    logger = loggerInstance;
  }
  
  if (!config.enabled || !config.consent || !config.dsn) {
    logger.info?.('[ErrorReporter] Disabled: enabled=%s, consent=%s, dsn=%s',
      config.enabled, config.consent, !!config.dsn);
    return;
  }

  // Lazy-load @sentry/node (optional peer dependency)
  try {
    Sentry = await import("@sentry/node");
  } catch (err) {
    logger.warn?.('[ErrorReporter] @sentry/node not installed. Error reporting disabled.');
    logger.warn?.('[ErrorReporter] Install with: npm install @sentry/node --save-optional');
    return;
  }

  if (!Sentry) return;

  Sentry.init({
    dsn: config.dsn,
    release: `openclaw-hybrid-memory@${pluginVersion}`,
    environment: config.environment || "production",
    sampleRate: config.sampleRate ?? 1.0,
    maxBreadcrumbs: 0,           // NO breadcrumbs (could contain user data)
    sendDefaultPii: false,       // NO PII
    autoSessionTracking: false,  // NO session tracking
    integrations: [],            // NO default integrations (they capture too much)
    beforeSend(event) {
      return sanitizeEvent(event);
    },
    beforeBreadcrumb() {
      return null; // Drop ALL breadcrumbs
    },
  });

  initialized = true;
  const dsnHost = config.dsn.split('@')[1] || '***';
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
    },
    contexts: event.contexts?.config_shape ? {
      config_shape: Object.fromEntries(
        Object.entries(event.contexts.config_shape).map(([k, v]) => [
          k,
          typeof v === 'string' ? scrubString(v) : v
        ])
      ),
    } : undefined,
    // NO: user, request, breadcrumbs, contexts.device, extra
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
    // AWS and other cloud credentials
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')                // AWS access keys
    // Slack tokens
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')    // Slack tokens
    // Private keys
    .replace(/-----BEGIN .*PRIVATE KEY/g, '[REDACTED]')        // Private key headers
    // Connection strings with embedded passwords
    .replace(/:\/\/[^\s:@]+:[^\s@]+@[^\s/]+/g, '://[REDACTED]@')
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
  // Keep only relative plugin paths
  const idx = path.indexOf('extensions/memory-hybrid/');
  if (idx >= 0) {
    return path.slice(idx);
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
  subsystem: string;
  configShape?: Record<string, string>;
}): void {
  if (!initialized || !Sentry) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag("subsystem", context.subsystem);
    scope.setTag("operation", context.operation);
    if (context.configShape) {
      scope.setContext("config_shape", context.configShape);
    }
    Sentry.captureException(error);
  });
}

/**
 * Check if error reporter is active
 */
export function isErrorReporterActive(): boolean {
  return initialized;
}
