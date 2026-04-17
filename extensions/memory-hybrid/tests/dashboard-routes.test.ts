// @ts-nocheck
/**
 * Tests for Issue #279 — Dashboard HTTP routes must use consistent auth
 *
 * Coverage:
 *   - registerDashboardHttpRoutes: does not register routes when health.enabled is false
 *   - registerDashboardHttpRoutes: registers root and api/health routes when enabled
 *   - registerDashboardHttpRoutes: all routes use authenticated=true by default
 *   - registerDashboardHttpRoutes: all routes use authenticated=false when configured
 *   - registerDashboardHttpRoutes: every registered route has identical authenticated value (consistent-auth)
 *   - registerDashboardHttpRoutes: root route handler returns 200 HTML
 *   - registerDashboardHttpRoutes: api/health route handler returns 200 JSON with status=ok
 *   - parseHealthConfig: defaults authenticated to true
 *   - parseHealthConfig: respects authenticated=false
 *   - parseHealthConfig: ignores invalid authenticated values (defaults to true)
 *   - DASHBOARD_PREFIX: equals /plugins/memory-dashboard
 *   - DASHBOARD_PATHS: root is / and healthApi is /api/health
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { parseHealthConfig } from "../config/parsers/maintenance.js";
import {
	DASHBOARD_PATHS,
	DASHBOARD_PREFIX,
	type HttpRequestHandler,
	type HttpRouteOptions,
	registerDashboardHttpRoutes,
} from "../tools/dashboard-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RouteRegistration {
	path: string;
	handler: HttpRequestHandler;
	opts: HttpRouteOptions;
}

function makeApi(): { api: ClawdbotPluginApi; routes: RouteRegistration[] } {
	const routes: RouteRegistration[] = [];
	const api = {
		registerHttpRoute: (
			path: string,
			handler: HttpRequestHandler,
			opts: HttpRouteOptions,
		) => {
			routes.push({ path, handler, opts });
		},
		logger: { info: () => {}, warn: () => {}, error: () => {} },
	} as unknown as ClawdbotPluginApi;
	return { api, routes };
}

function fakeReq(): {
	method: string;
	url: string;
	headers: Record<string, string>;
} {
	return { method: "GET", url: "/", headers: {} };
}

// ---------------------------------------------------------------------------
// registerDashboardHttpRoutes
// ---------------------------------------------------------------------------

describe("registerDashboardHttpRoutes", () => {
	it("does not register routes when health.enabled is false", () => {
		const { api, routes } = makeApi();
		registerDashboardHttpRoutes(
			{ cfg: { health: { enabled: false, authenticated: true } } },
			api,
		);
		expect(routes).toHaveLength(0);
	});

	it("registers root and api/health routes when enabled", () => {
		const { api, routes } = makeApi();
		registerDashboardHttpRoutes(
			{ cfg: { health: { enabled: true, authenticated: true } } },
			api,
		);
		expect(routes.map((r) => r.path)).toContain(
			`${DASHBOARD_PREFIX}${DASHBOARD_PATHS.root}`,
		);
		expect(routes.map((r) => r.path)).toContain(
			`${DASHBOARD_PREFIX}${DASHBOARD_PATHS.healthApi}`,
		);
	});

	it("all routes use authenticated=true by default", () => {
		const { api, routes } = makeApi();
		registerDashboardHttpRoutes(
			{ cfg: { health: { enabled: true, authenticated: true } } },
			api,
		);
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			expect(route.opts.authenticated).toBe(true);
		}
	});

	it("all routes use authenticated=false when configured", () => {
		const { api, routes } = makeApi();
		registerDashboardHttpRoutes(
			{ cfg: { health: { enabled: true, authenticated: false } } },
			api,
		);
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			expect(route.opts.authenticated).toBe(false);
		}
	});

	it("every registered route has identical authenticated value (consistent-auth requirement)", () => {
		const { api, routes } = makeApi();
		registerDashboardHttpRoutes(
			{ cfg: { health: { enabled: true, authenticated: true } } },
			api,
		);
		const authValues = [...new Set(routes.map((r) => r.opts.authenticated))];
		expect(authValues).toHaveLength(1);
	});

	it("root route handler returns 200 HTML", async () => {
		const { api, routes } = makeApi();
		registerDashboardHttpRoutes(
			{ cfg: { health: { enabled: true, authenticated: true } } },
			api,
		);
		const rootRoute = routes.find(
			(r) => r.path === `${DASHBOARD_PREFIX}${DASHBOARD_PATHS.root}`,
		);
		expect(rootRoute).toBeDefined();
		const response = await rootRoute?.handler(fakeReq());
		expect(response.status).toBe(200);
		expect(response.headers?.["Content-Type"]).toMatch(/text\/html/);
		expect(response.body).toContain("<!DOCTYPE html>");
	});

	it("api/health route handler returns 200 JSON with status=ok", async () => {
		const { api, routes } = makeApi();
		registerDashboardHttpRoutes(
			{ cfg: { health: { enabled: true, authenticated: true } } },
			api,
		);
		const healthRoute = routes.find(
			(r) => r.path === `${DASHBOARD_PREFIX}${DASHBOARD_PATHS.healthApi}`,
		);
		expect(healthRoute).toBeDefined();
		const response = await healthRoute?.handler(fakeReq());
		expect(response.status).toBe(200);
		expect(response.headers?.["Content-Type"]).toMatch(/application\/json/);
		const body = JSON.parse(response.body) as {
			status: string;
			generatedAt: string;
		};
		expect(body.status).toBe("ok");
		expect(typeof body.generatedAt).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// parseHealthConfig — authenticated field
// ---------------------------------------------------------------------------

describe("parseHealthConfig — authenticated field", () => {
	it("defaults authenticated to true when not specified", () => {
		const cfg = parseHealthConfig({});
		expect(cfg.authenticated).toBe(true);
	});

	it("respects authenticated=false", () => {
		const cfg = parseHealthConfig({ health: { authenticated: false } });
		expect(cfg.authenticated).toBe(false);
	});

	it("respects authenticated=true explicitly", () => {
		const cfg = parseHealthConfig({ health: { authenticated: true } });
		expect(cfg.authenticated).toBe(true);
	});

	it("defaults authenticated to true for non-boolean values", () => {
		const cfg = parseHealthConfig({ health: { authenticated: "yes" } });
		expect(cfg.authenticated).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("DASHBOARD_PREFIX and DASHBOARD_PATHS", () => {
	it("DASHBOARD_PREFIX is /plugins/memory-dashboard", () => {
		expect(DASHBOARD_PREFIX).toBe("/plugins/memory-dashboard");
	});

	it("DASHBOARD_PATHS.root is /", () => {
		expect(DASHBOARD_PATHS.root).toBe("/");
	});

	it("DASHBOARD_PATHS.healthApi is /api/health", () => {
		expect(DASHBOARD_PATHS.healthApi).toBe("/api/health");
	});
});
