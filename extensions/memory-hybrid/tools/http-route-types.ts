/**
 * Shared HTTP route types for OpenClaw plugin SDK.
 *
 * OpenClaw 2026.5+ registers routes with a single params object and a Node
 * `(IncomingMessage, ServerResponse)` handler. Plugin code in this repo still
 * uses the legacy response-object shape; `createSafeRegisterHttpRoute` in
 * `safe-register-http-route.ts` adapts it before calling the gateway.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpRouteOptions {
  /** Whether the route requires an authenticated session. Must be the same for all sibling routes. */
  authenticated: boolean;
}

export type HttpRequestHandler = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; headers?: Record<string, string>; body: string }>;

/** Gateway `registerHttpRoute` auth mode (OpenClaw 2026.5+). */
export type RegisterHttpRouteGatewayAuth = "gateway" | "plugin";

export type RegisterHttpRouteGatewayHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Params object passed to `api.registerHttpRoute` on OpenClaw 2026.5+. */
export interface RegisterHttpRouteGatewayParams {
  path: string;
  handler: RegisterHttpRouteGatewayHandler;
  auth: RegisterHttpRouteGatewayAuth;
  /** When set, gateway matches the path mode (e.g. exact). */
  match?: "exact";
}
