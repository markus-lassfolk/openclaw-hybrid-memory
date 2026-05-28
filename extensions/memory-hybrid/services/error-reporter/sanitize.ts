import { compareVersions } from "../../utils/version-check.js";
import type { GlitchTipEvent } from "./types.js";

/**
 * Extract version string from a release identifier.
 * "openclaw-hybrid-memory@2026.3.110" → "2026.3.110"
 * Returns null if the release string can't be parsed.
 */
export function extractVersion(release: string): string | null {
  if (!release) return null;
  const atIdx = release.indexOf("@");
  if (atIdx < 0) return null;
  const version = release.slice(atIdx + 1);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return version;
}

/**
 * Scrub sensitive data from strings
 */
export function scrubString(input: string): string {
  return input
    .replace(/sk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_]{20,})/g, "[REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED]")
    .replace(/gho_[A-Za-z0-9]{36}/g, "[REDACTED]")
    .replace(/Bearer\s+[\w.-]+/gi, "[REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=_-]+/gi, "[REDACTED]")
    .replace(/(?:\?|&)(?:api[_-]?key|token|access_token|password|secret)=[^&\s]+/gi, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/:\/\/[^\s:@]+:[^\s@]+@[^\s/]+/g, "://[REDACTED]@")
    .replace(/postgres:\/\/[^\s]+/g, "postgres://[REDACTED]")
    .replace(/mysql:\/\/[^\s]+/g, "mysql://[REDACTED]")
    .replace(/redis:\/\/[^\s]+/g, "redis://[REDACTED]")
    .replace(/mongodb:\/\/[^\s]+/g, "mongodb://[REDACTED]")
    .replace(/\/home\/[^/\s]+/g, "$HOME")
    .replace(/\/Users\/[^/\s]+/g, "$HOME")
    .replace(/C:\\Users\\[^\\\s]+/g, "%USERPROFILE%")
    .replace(/\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, "[EMAIL]")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[IP]")
    .slice(0, 500);
}

/**
 * Sanitize file paths: keep only relative plugin paths
 */
export function sanitizePath(path: string): string {
  const markers = ["extensions/openclaw-hybrid-memory/", "extensions/memory-hybrid/", "openclaw-hybrid-memory/"];

  for (const marker of markers) {
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      return path.slice(idx);
    }
  }

  if (path.includes("node_modules") || path.includes("extensions")) {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }

  return path
    .replace(/\/home\/[^/]+/g, "$HOME")
    .replace(/\/Users\/[^/]+/g, "$HOME")
    .replace(/C:\\Users\\[^\\]+/g, "%USERPROFILE%");
}

/**
 * Sanitize event using ALLOWLIST approach: rebuild event with only safe fields
 */
export function sanitizeEvent(event: GlitchTipEvent): GlitchTipEvent | null {
  if (!event) return null;

  const safe: GlitchTipEvent = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "node",
    level: event.level,
    release: event.release,
    environment: event.environment,
    server_name: event.server_name ? scrubString(String(event.server_name).slice(0, 128)) : undefined,
    fingerprint: event.fingerprint,
    exception: event.exception
      ? {
          values: event.exception.values?.map((v) => ({
            type: v.type,
            value: scrubString(v.value || ""),
            stacktrace: v.stacktrace
              ? {
                  frames: v.stacktrace.frames?.map((f) => ({
                    filename: sanitizePath(f.filename || ""),
                    function: f.function,
                    lineno: f.lineno,
                    colno: f.colno,
                    in_app: f.in_app,
                  })),
                }
              : undefined,
          })),
        }
      : undefined,
    tags: {
      subsystem: event.tags?.subsystem ? scrubString(String(event.tags.subsystem)) : undefined,
      operation: event.tags?.operation ? scrubString(String(event.tags.operation)) : undefined,
      phase: event.tags?.phase ? scrubString(String(event.tags.phase)) : undefined,
      backend: event.tags?.backend ? scrubString(String(event.tags.backend)) : undefined,
      node: event.tags?.node ? scrubString(String(event.tags.node).slice(0, 128)) : undefined,
      agent_id: event.tags?.agent_id ? scrubString(String(event.tags.agent_id)) : undefined,
      agent_name: event.tags?.agent_name ? scrubString(String(event.tags.agent_name).slice(0, 64)) : undefined,
      bot_id: event.tags?.bot_id ? scrubString(String(event.tags.bot_id)) : undefined,
      bot_name: event.tags?.bot_name ? scrubString(String(event.tags.bot_name).slice(0, 64)) : undefined,
      retryAttempt: event.tags?.retryAttempt ? scrubString(String(event.tags.retryAttempt)) : undefined,
      memoryCount: event.tags?.memoryCount ? scrubString(String(event.tags.memoryCount)) : undefined,
    },
    contexts: {
      ...(event.contexts?.config_shape
        ? {
            config_shape: Object.fromEntries(
              Object.entries(event.contexts.config_shape).map(([k, v]) => [
                k,
                typeof v === "string" ? scrubString(v) : v,
              ]),
            ),
          }
        : {}),
      ...(event.contexts?.runtime
        ? { runtime: { name: event.contexts.runtime.name, version: event.contexts.runtime.version } }
        : {}),
      ...(event.contexts?.os ? { os: { name: event.contexts.os.name } } : {}),
    },
    breadcrumbs: event.breadcrumbs
      ?.filter((b) => b.category?.startsWith("plugin."))
      .map((b) => ({
        category: b.category,
        level: b.level,
        timestamp: b.timestamp,
        type: b.type,
      })),
    user: event.user
      ? {
          id: event.user.id ? scrubString(String(event.user.id)) : undefined,
          username: event.user.username ? scrubString(String(event.user.username)) : undefined,
        }
      : undefined,
  };

  return safe;
}

/**
 * Check whether an event should be dropped because it matches a known-fixed issue
 * and the event's release version is older than the fix.
 */
export function shouldDropForResolvedIssue(
  event: GlitchTipEvent,
  resolvedIssues: Record<string, string>,
  fallbackRelease?: string,
): boolean {
  if (!resolvedIssues || Object.keys(resolvedIssues).length === 0) return false;

  const errType = event.exception?.values?.[0]?.type || "Error";
  const errValue = scrubString(event.exception?.values?.[0]?.value || "");
  const fingerprint = `${errType}:${errValue.slice(0, 100)}`;

  const fixedInVersion = resolvedIssues[fingerprint];
  if (!fixedInVersion || typeof fixedInVersion !== "string") return false;
  if (!/^\d+\.\d+\.\d+/.test(fixedInVersion)) return false;

  const releaseStr = event.release || fallbackRelease || "";
  const eventVersion = extractVersion(releaseStr);
  if (!eventVersion) return false;

  return compareVersions(eventVersion, fixedInVersion) < 0;
}
