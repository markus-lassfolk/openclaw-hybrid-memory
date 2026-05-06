/**
 * Safe wrapper around `api.registerHttpRoute` (issue #1173).
 *
 * The OpenClaw 2026.5.4+ gateway emits the warning
 *   `[plugins] http route registration missing path`
 * when a plugin attempts to register an HTTP route with a missing or
 * empty-after-normalization path string. This wrapper:
 *
 *   1. Validates the path is a non-empty string starting with `/`.
 *   2. Normalizes trailing slashes (so `/plugins/memory-dashboard/` becomes
 *      `/plugins/memory-dashboard` — gateway treats the trailing slash as a
 *      separate, empty sub-path).
 *   3. De-duplicates registrations that collapse to the same normalized path.
 *   4. Surfaces a clear, actionable plugin-side error instead of silently
 *      letting the gateway log a generic warning.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HttpRequestHandler, HttpRouteOptions } from "./http-route-types.js";

export type RegisterHttpRouteFn = (path: string, handler: HttpRequestHandler, opts: HttpRouteOptions) => void;

/** Lightweight logger surface compatible with the OpenClaw plugin logger. */
export interface SafeRouteLogger {
  warn: (msg: string) => void;
  error?: (msg: string) => void;
}

/**
 * Normalize a route path:
 *   - trims whitespace
 *   - collapses repeated leading slashes to one
 *   - strips trailing slashes (keeps the literal `/` for root)
 *
 * Returns the normalized string, or `null` if normalization would produce an
 * empty/invalid path (which is the case the gateway warns about).
 */
export function normalizeRoutePath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("/")) return null;

  // Collapse repeated leading slashes (e.g. "//foo" -> "/foo").
  let normalized = trimmed.replace(/^\/+/, "/");
  // Strip trailing slashes except the literal root path.
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }
  if (normalized.length === 0) return null;
  return normalized;
}

/**
 * Build a safe `registerHttpRoute` callable bound to the given plugin API and
 * logger. The returned function silently no-ops (with a clear warn log) if
 * the underlying gateway does not implement `registerHttpRoute`.
 */
export function createSafeRegisterHttpRoute(
  api: ClawdbotPluginApi,
  logger: SafeRouteLogger,
  source: string,
): RegisterHttpRouteFn {
  const seen = new Set<string>();
  const register = api.registerHttpRoute as RegisterHttpRouteFn | undefined;

  return (rawPath, handler, opts) => {
    const normalized = normalizeRoutePath(rawPath);
    if (normalized === null) {
      const message =
        `${source}: refusing to register HTTP route with invalid path ` +
        `(received ${JSON.stringify(rawPath)}). ` +
        "Path must be a non-empty string starting with '/'.";
      (logger.error ?? logger.warn).call(logger, message);
      return;
    }

    if (typeof register !== "function") {
      logger.warn(
        `${source}: api.registerHttpRoute is not available on this gateway; ` + `skipping route ${normalized}.`,
      );
      return;
    }

    if (seen.has(normalized)) {
      logger.warn(`${source}: duplicate HTTP route registration for ${normalized} ignored.`);
      return;
    }
    seen.add(normalized);

    register(normalized, handler, opts);
  };
}
