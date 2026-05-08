/**
 * Dashboard HTTP Route Registration — Issue #279
 *
 * Registers all HTTP routes for the memory health dashboard via the OpenClaw
 * plugin SDK's registerHttpRoute API.
 *
 * OpenClaw v2026.3.8 rejects mixed-auth overlapping routes: every route
 * registered under the same path prefix MUST use identical auth settings.
 * This module enforces that guarantee by reading `cfg.health.authenticated`
 * once and applying it uniformly to every route.
 *
 * All routes are registered through {@link createSafeRegisterHttpRoute} so
 * that the OpenClaw 2026.5.4+ gateway no longer emits
 * `http route registration missing path` warnings (issue #1173): paths are
 * trimmed, normalized (no trailing slash on the dashboard root), and
 * validated to be non-empty before they reach the gateway.
 *
 * Routes:
 *   GET /plugins/memory-dashboard          — HTML dashboard shell
 *   GET /plugins/memory-dashboard/api/health — JSON health report
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HealthConfig } from "../config/types/maintenance.js";
import type { HttpRouteOptions } from "./http-route-types.js";
import { type SafeRouteLogger, createSafeRegisterHttpRoute } from "./safe-register-http-route.js";

export interface DashboardRoutesContext {
  cfg: Pick<{ health: HealthConfig }, "health">;
}

/** Path prefix for all dashboard routes (plugin-scoped by OpenClaw gateway). */
export const DASHBOARD_PREFIX = "/plugins/memory-dashboard";

/**
 * Sub-paths registered under DASHBOARD_PREFIX.
 *
 * Note: `root` is the empty string (not `"/"`) so the registered path is
 * `/plugins/memory-dashboard` rather than `/plugins/memory-dashboard/`. The
 * OpenClaw 2026.5.4+ gateway treats a trailing slash as a separate empty
 * sub-path and warns about "missing path" (issue #1173); the safe wrapper
 * also normalizes trailing slashes defensively.
 */
export const DASHBOARD_PATHS = {
  root: "",
  healthApi: "/api/health",
} as const;

/**
 * Register all memory dashboard HTTP routes with consistent auth.
 *
 * All routes use the same `authenticated` value from `cfg.health.authenticated`
 * to satisfy the OpenClaw v2026.3.8 no-mixed-auth requirement.
 *
 * No-ops when `cfg.health.enabled` is false.
 */
export function registerDashboardHttpRoutes(ctx: DashboardRoutesContext, api: ClawdbotPluginApi): void {
  if (!ctx.cfg.health.enabled) return;
  if (typeof api.registerHttpRoute !== "function") return;

  const routeOpts: HttpRouteOptions = {
    authenticated: ctx.cfg.health.authenticated,
  };

  const logger = (api.logger ?? { warn: () => {} }) as SafeRouteLogger;
  const register = createSafeRegisterHttpRoute(api, logger, "memory-dashboard");

  // All routes MUST use the same routeOpts to satisfy the consistent-auth
  // requirement. Do not pass different options to any of these calls.

  // GET /plugins/memory-dashboard — dashboard HTML shell
  register(
    `${DASHBOARD_PREFIX}${DASHBOARD_PATHS.root}`,
    async (_req) => ({
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: getDashboardHtml(),
    }),
    routeOpts,
  );

  // GET /plugins/memory-dashboard/api/health — JSON health summary
  register(
    `${DASHBOARD_PREFIX}${DASHBOARD_PATHS.healthApi}`,
    async (_req) => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ok", generatedAt: new Date().toISOString() }),
    }),
    routeOpts,
  );
}

/** Minimal HTML shell returned by the dashboard root route. */
function getDashboardHtml(): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>Memory Health Dashboard</title>",
    "</head>",
    "<body>",
    "<h1>Memory Health Dashboard</h1>",
    '<p>Dashboard implementation pending <a href="https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/148">#148</a>.</p>',
    `<script>fetch("${DASHBOARD_PREFIX}${DASHBOARD_PATHS.healthApi}").then(r=>r.json()).then(d=>console.log("health",d));</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
