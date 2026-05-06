/**
 * Tests for tools/safe-register-http-route.ts (issue #1173).
 *
 * Validates:
 *   - Empty / whitespace / non-string paths are rejected before they reach the gateway
 *   - Trailing slashes are stripped (except for the literal root path)
 *   - Repeated leading slashes are collapsed
 *   - Duplicate registrations after normalization are skipped (with a warn log)
 *   - When the gateway lacks `registerHttpRoute`, the wrapper warns instead of throwing
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { HttpRequestHandler, HttpRouteOptions } from "../tools/http-route-types.js";
import { createSafeRegisterHttpRoute, normalizeRoutePath } from "../tools/safe-register-http-route.js";

interface RouteRegistration {
  path: string;
  handler: HttpRequestHandler;
  opts: HttpRouteOptions;
}

function makeApi(opts: { withRegister?: boolean } = {}): {
  api: ClawdbotPluginApi;
  routes: RouteRegistration[];
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const routes: RouteRegistration[] = [];
  const warn = vi.fn();
  const error = vi.fn();
  const api = {
    logger: { info: vi.fn(), warn, error, debug: vi.fn() },
    ...(opts.withRegister !== false
      ? {
          registerHttpRoute: (path: string, handler: HttpRequestHandler, o: HttpRouteOptions) => {
            routes.push({ path, handler, opts: o });
          },
        }
      : {}),
  } as unknown as ClawdbotPluginApi;
  return { api, routes, warn, error };
}

const noopHandler: HttpRequestHandler = async () => ({ status: 204, body: "" });
const noopOpts: HttpRouteOptions = { authenticated: true };

describe("normalizeRoutePath", () => {
  it("returns null for non-string input", () => {
    expect(normalizeRoutePath(undefined)).toBeNull();
    expect(normalizeRoutePath(null)).toBeNull();
    expect(normalizeRoutePath(42)).toBeNull();
  });

  it("returns null for an empty / whitespace-only string", () => {
    expect(normalizeRoutePath("")).toBeNull();
    expect(normalizeRoutePath("   ")).toBeNull();
  });

  it("returns null when the path does not start with /", () => {
    expect(normalizeRoutePath("foo")).toBeNull();
    expect(normalizeRoutePath(" foo")).toBeNull();
  });

  it("preserves the literal root path", () => {
    expect(normalizeRoutePath("/")).toBe("/");
  });

  it("strips a single trailing slash", () => {
    expect(normalizeRoutePath("/plugins/memory-dashboard/")).toBe("/plugins/memory-dashboard");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeRoutePath("/foo///")).toBe("/foo");
  });

  it("collapses repeated leading slashes", () => {
    expect(normalizeRoutePath("//plugins/foo")).toBe("/plugins/foo");
    expect(normalizeRoutePath("///plugins/foo")).toBe("/plugins/foo");
  });

  it("trims surrounding whitespace before validation", () => {
    expect(normalizeRoutePath("  /foo  ")).toBe("/foo");
  });
});

describe("createSafeRegisterHttpRoute", () => {
  it("forwards normalized paths to api.registerHttpRoute", () => {
    const { api, routes } = makeApi();
    const register = createSafeRegisterHttpRoute(api, api.logger, "test");
    register("/plugins/memory-dashboard/", noopHandler, noopOpts);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/plugins/memory-dashboard");
  });

  it("rejects empty / non-string paths and logs an error (issue #1173 root cause)", () => {
    const { api, routes, error, warn } = makeApi();
    const register = createSafeRegisterHttpRoute(api, api.logger, "test");

    register("", noopHandler, noopOpts);
    register("   ", noopHandler, noopOpts);
    register(undefined as unknown as string, noopHandler, noopOpts);

    expect(routes).toHaveLength(0);
    // Error logger preferred when present.
    expect(error).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/refusing to register HTTP route with invalid path/);
  });

  it("falls back to logger.warn when logger.error is not provided", () => {
    const { api } = makeApi();
    const warnOnly = { warn: vi.fn() };
    const register = createSafeRegisterHttpRoute(api, warnOnly, "test");
    register("", noopHandler, noopOpts);
    expect(warnOnly.warn).toHaveBeenCalledTimes(1);
    expect(warnOnly.warn.mock.calls[0][0]).toMatch(/invalid path/);
  });

  it("skips duplicate registrations after normalization", () => {
    const { api, routes, warn } = makeApi();
    const register = createSafeRegisterHttpRoute(api, api.logger, "test");

    register("/plugins/memory-dashboard", noopHandler, noopOpts);
    register("/plugins/memory-dashboard/", noopHandler, noopOpts);
    register("//plugins/memory-dashboard", noopHandler, noopOpts);

    expect(routes).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/duplicate HTTP route registration/);
  });

  it("warns and no-ops when the gateway does not expose registerHttpRoute", () => {
    const { api, warn } = makeApi({ withRegister: false });
    const register = createSafeRegisterHttpRoute(api, api.logger, "test");
    register("/plugins/memory-dashboard", noopHandler, noopOpts);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/api\.registerHttpRoute is not available/);
  });
});
