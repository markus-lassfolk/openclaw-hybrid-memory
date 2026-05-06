/**
 * Drive a gateway-style `(req, res)` route handler from a legacy-shaped request
 * object used in unit tests.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

export type LegacyRouteRequest = { method: string; url: string; headers: Record<string, string> };

export async function invokeNodeHttpRoute(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  legacy: LegacyRouteRequest,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const req = new EventEmitter() as IncomingMessage;
  req.method = legacy.method;
  req.url = legacy.url;
  req.headers = legacy.headers;

  let statusCode = 200;
  const headersOut: Record<string, string> = {};
  const chunks: Buffer[] = [];

  const res = new EventEmitter() as unknown as ServerResponse;
  res.writeHead = (code: number, headersArg?: unknown): ServerResponse => {
    statusCode = code;
    if (headersArg && typeof headersArg === "object" && !Array.isArray(headersArg)) {
      for (const [k, v] of Object.entries(headersArg as Record<string, unknown>)) {
        if (v === undefined) continue;
        headersOut[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }
    }
    return res;
  };
  res.end = (chunk?: unknown): ServerResponse => {
    if (chunk != null && chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return res;
  };

  await Promise.resolve(handler(req, res));
  return { status: statusCode, headers: headersOut, body: Buffer.concat(chunks).toString("utf8") };
}
