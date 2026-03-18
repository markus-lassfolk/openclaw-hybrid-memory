/**
 * ApiTap Service — wrapper around the `apitap` CLI for browser traffic capture (Issue #614).
 *
 * Provides:
 *  - isAvailable(): check if `apitap` binary is installed
 *  - capture(url, options): run `apitap capture` and return discovered endpoints
 *  - peek(url): run `apitap peek` for quick headless API discovery
 *  - buildSkillScaffold(endpoint): generate an OpenClaw skill spec from an endpoint
 *
 * Security model:
 *  - Only runs when cfg.apiTap.enabled = true (explicit opt-in)
 *  - Validates URLs against allowedPatterns / blockedPatterns before running
 *  - Never auto-triggers; only responds to explicit agent tool calls
 */

import { spawnSync, execSync } from "node:child_process";
import type { ApiTapConfig } from "../config/types/features.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RawCapturedEndpoint {
  endpoint: string;
  method: string;
  parameters?: Record<string, unknown>;
  sampleResponse?: unknown;
  contentType?: string;
}

export interface ApitapCaptureResult {
  sessionId: string;
  siteUrl: string;
  endpoints: RawCapturedEndpoint[];
  durationMs: number;
  error?: string;
}

export interface SkillScaffold {
  skillName: string;
  description: string;
  endpoint: string;
  method: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  sampleResponse: string;
  curlExample: string;
}

// ---------------------------------------------------------------------------
// URL security helpers
// ---------------------------------------------------------------------------

/**
 * Check if a URL matches any of the given glob-style patterns.
 * Supports `*` (single segment) and `**` (multi-segment) wildcards.
 */
function matchesPattern(url: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars except * and ?
    .replace(/\*\*/g, "§DOUBLESTAR§") // placeholder for **
    .replace(/\*/g, "[^/]*") // * matches within a segment
    .replace(/§DOUBLESTAR§/g, ".*"); // ** matches across segments
  try {
    return new RegExp(`^${escaped}$`, "i").test(url);
  } catch {
    return false;
  }
}

/**
 * Validate a URL against allowed/blocked patterns.
 * Returns null if allowed, or an error message if blocked.
 */
export function validateUrl(url: string, cfg: ApiTapConfig): string | null {
  // Check blocked patterns first (blocklist wins)
  for (const pattern of cfg.blockedPatterns) {
    if (matchesPattern(url, pattern)) {
      return `URL matches blocked pattern "${pattern}". ApiTap will not capture auth/sensitive endpoints.`;
    }
  }

  // Check allowed patterns (empty = allow all)
  if (cfg.allowedPatterns.length > 0) {
    const allowed = cfg.allowedPatterns.some((p) => matchesPattern(url, p));
    if (!allowed) {
      return `URL does not match any allowed pattern. Configure apiTap.allowedPatterns to permit this site.`;
    }
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return `Invalid URL: "${url}"`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// ApitapService
// ---------------------------------------------------------------------------

export class ApitapService {
  private cfg: ApiTapConfig;
  private _available: boolean | null = null;

  constructor(cfg: ApiTapConfig) {
    this.cfg = cfg;
  }

  /**
   * Check if the `apitap` CLI binary is installed and reachable.
   * Result is cached after first check.
   */
  isAvailable(): boolean {
    if (this._available !== null) return this._available;
    try {
      const result = spawnSync("apitap", ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this._available = result.status === 0;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  /**
   * Run `apitap capture` to record live browser traffic for a site.
   * Blocks until the capture session ends (timeout) or the user stops it.
   */
  capture(siteUrl: string, timeoutSeconds?: number): ApitapCaptureResult {
    const urlError = validateUrl(siteUrl, this.cfg);
    if (urlError) {
      return {
        sessionId: "",
        siteUrl,
        endpoints: [],
        durationMs: 0,
        error: urlError,
      };
    }

    const timeout = timeoutSeconds ?? this.cfg.captureTimeoutSeconds;
    const startMs = Date.now();

    try {
      const result = spawnSync(
        "apitap",
        ["capture", "--url", siteUrl, "--timeout", String(timeout), "--output", "json", "--no-browser-ui"],
        {
          encoding: "utf8",
          timeout: (timeout + 10) * 1000, // extra 10s buffer
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const durationMs = Date.now() - startMs;

      if (result.status !== 0) {
        const errMsg = result.stderr?.trim() || `apitap capture exited with code ${result.status}`;
        return { sessionId: "", siteUrl, endpoints: [], durationMs, error: errMsg };
      }

      return this.parseCaptureOutput(result.stdout ?? "", siteUrl, durationMs);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      return { sessionId: "", siteUrl, endpoints: [], durationMs, error: errMsg };
    }
  }

  /**
   * Run `apitap peek` for quick headless API discovery (no browser window).
   * Faster than capture but may miss dynamically loaded endpoints.
   */
  peek(siteUrl: string): ApitapCaptureResult {
    const urlError = validateUrl(siteUrl, this.cfg);
    if (urlError) {
      return {
        sessionId: "",
        siteUrl,
        endpoints: [],
        durationMs: 0,
        error: urlError,
      };
    }

    const startMs = Date.now();

    try {
      const result = spawnSync("apitap", ["peek", "--url", siteUrl, "--output", "json"], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const durationMs = Date.now() - startMs;

      if (result.status !== 0) {
        const errMsg = result.stderr?.trim() || `apitap peek exited with code ${result.status}`;
        return { sessionId: "", siteUrl, endpoints: [], durationMs, error: errMsg };
      }

      return this.parseCaptureOutput(result.stdout ?? "", siteUrl, durationMs);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      return { sessionId: "", siteUrl, endpoints: [], durationMs, error: errMsg };
    }
  }

  /**
   * Generate an OpenClaw skill scaffold from a discovered API endpoint.
   * Returns a structured spec ready for human review and skill file generation.
   */
  buildSkillScaffold(
    siteUrl: string,
    endpoint: string,
    method: string,
    parameters: Record<string, unknown>,
    sampleResponse: unknown,
  ): SkillScaffold {
    const urlObj = (() => {
      try {
        return new URL(siteUrl);
      } catch {
        return null;
      }
    })();

    const host = urlObj?.hostname ?? siteUrl;
    const endpointSlug = endpoint
      .replace(/[^a-zA-Z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    const skillName = `${host.replace(/\./g, "_")}_${method.toLowerCase()}_${endpointSlug}`.slice(0, 60);

    // Build parameter schema from observed data
    const paramSchema: Record<string, { type: string; description: string; required?: boolean }> = {};
    for (const [key, value] of Object.entries(parameters)) {
      const jsType = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
      paramSchema[key] = {
        type: jsType,
        description: `Parameter: ${key}`,
      };
    }

    const sampleResponseStr = (() => {
      try {
        return JSON.stringify(sampleResponse, null, 2).slice(0, 2000);
      } catch {
        return String(sampleResponse).slice(0, 2000);
      }
    })();

    const curlParams = Object.entries(parameters)
      .map(([k, v]) => `-d '${k}=${v}'`)
      .join(" ");
    const curlExample =
      method.toUpperCase() === "GET"
        ? `curl "${siteUrl}${endpoint}"`
        : `curl -X ${method.toUpperCase()} "${siteUrl}${endpoint}" ${curlParams}`.trim();

    return {
      skillName,
      description: `Call the ${method.toUpperCase()} ${endpoint} endpoint on ${host}`,
      endpoint,
      method: method.toUpperCase(),
      parameters: paramSchema,
      sampleResponse: sampleResponseStr,
      curlExample,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private parseCaptureOutput(output: string, siteUrl: string, durationMs: number): ApitapCaptureResult {
    const trimmed = output.trim();
    if (!trimmed) {
      return {
        sessionId: "",
        siteUrl,
        endpoints: [],
        durationMs,
        error: "apitap returned empty output",
      };
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : randomSessionId();
      const rawEndpoints = Array.isArray(parsed.endpoints)
        ? (parsed.endpoints as unknown[]).slice(0, this.cfg.maxEndpointsPerSession)
        : [];

      const endpoints: RawCapturedEndpoint[] = rawEndpoints
        .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
        .map((e) => ({
          endpoint: typeof e.endpoint === "string" ? e.endpoint : "/",
          method: typeof e.method === "string" ? e.method.toUpperCase() : "GET",
          parameters:
            e.parameters && typeof e.parameters === "object" && !Array.isArray(e.parameters)
              ? (e.parameters as Record<string, unknown>)
              : {},
          sampleResponse: e.sampleResponse,
          contentType: typeof e.contentType === "string" ? e.contentType : "application/json",
        }));

      return { sessionId, siteUrl, endpoints, durationMs };
    } catch {
      // Not valid JSON — apitap may have printed non-JSON output
      return {
        sessionId: "",
        siteUrl,
        endpoints: [],
        durationMs,
        error: `apitap output could not be parsed as JSON. Raw output: ${trimmed.slice(0, 200)}`,
      };
    }
  }
}

function randomSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check if apitap is installed by running `apitap --version` via execSync.
 * Used for CLI verify commands.
 */
export function checkApitapInstalled(): { installed: boolean; version?: string; error?: string } {
  try {
    const output = execSync("apitap --version", { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    return { installed: true, version: output.trim() };
  } catch {
    return {
      installed: false,
      error: "apitap CLI not found. Install with: npm install -g @apitap/core",
    };
  }
}
