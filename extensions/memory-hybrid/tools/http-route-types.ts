/**
 * Shared HTTP route types for OpenClaw plugin SDK.
 *
 * These types define the contract for registerHttpRoute API available
 * in OpenClaw v2026.3.8+.
 */

export interface HttpRouteOptions {
  /** Whether the route requires an authenticated session. Must be the same for all sibling routes. */
  authenticated: boolean;
}

export type HttpRequestHandler = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; headers?: Record<string, string>; body: string }>;
