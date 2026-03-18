/**
 * ApiTap Tools — expose browser API capture to the agent (Issue #614).
 *
 * Tools:
 *  - apitap_capture:   Run a live capture session; records network traffic while user browses
 *  - apitap_peek:      Quick headless API discovery without a visible browser window
 *  - apitap_list:      List discovered endpoints from the store
 *  - apitap_to_skill:  Convert a stored endpoint into an OpenClaw skill scaffold
 *
 * Security: all tools require cfg.apiTap.enabled = true and explicit opt-in.
 * Capture sessions are never automatic.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { ApitapStore } from "../backends/apitap-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { ApitapService, validateUrl } from "../services/apitap-service.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface ApitapToolsContext {
  apitapStore: ApitapStore;
  cfg: HybridMemoryConfig;
}

interface PersistResult {
  stored: Array<{ id: string; method: string; endpoint: string }>;
  outputText: string;
}

function persistAndFormatEndpoints(
  result: { sessionId: string; endpoints: Array<{ endpoint: string; method: string; parameters?: Record<string, unknown>; sampleResponse?: unknown; contentType?: string }> },
  url: string,
  cfg: HybridMemoryConfig,
  apitapStore: ApitapStore,
  label: string,
  zeroResultsMessage: string,
): PersistResult {
  const expiresAt =
    cfg.apiTap.endpointTtlDays > 0
      ? new Date(Date.now() + cfg.apiTap.endpointTtlDays * 24 * 60 * 60_000).toISOString()
      : null;

  const stored = result.endpoints.map((ep) =>
    apitapStore.create({
      siteUrl: url,
      endpoint: ep.endpoint,
      method: ep.method,
      parameters: ep.parameters ?? {},
      sampleResponse: ep.sampleResponse ?? null,
      contentType: ep.contentType ?? "application/json",
      sessionId: result.sessionId,
      expiresAt,
    }),
  );

  const lines: string[] = [];
  lines.push(`${label} for ${url}.`);
  lines.push(`  Session ID:       ${result.sessionId}`);
  lines.push(`  Endpoints found:  ${stored.length}`);

  if (stored.length === 0) {
    lines.push("");
    lines.push(zeroResultsMessage);
  } else {
    lines.push("");
    lines.push("Discovered endpoints:");
    stored.slice(0, 20).forEach((ep, i) => {
      lines.push(`  ${i + 1}. [${ep.method}] ${ep.endpoint}  (id: ${ep.id})`);
    });
    if (stored.length > 20) {
      lines.push(`  ... and ${stored.length - 20} more`);
    }
    lines.push("");
    lines.push("Use apitap_to_skill <id> to generate a skill scaffold.");
  }

  return { stored, outputText: lines.join("\n") };
}

export function registerApitapTools(ctx: ApitapToolsContext, api: ClawdbotPluginApi): void {
  const { apitapStore, cfg } = ctx;
  const service = new ApitapService(cfg.apiTap);

  // -------------------------------------------------------------------------
  // apitap_capture — live browser capture session
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "apitap_capture",
    label: "ApiTap: Capture Browser Traffic",
    description:
      "Launch a browser capture session using ApiTap to intercept and parameterize real network traffic. " +
      "The browser opens to the target URL; navigate normally while ApiTap records API calls. " +
      "Returns discovered endpoints for review. Requires apiTap.enabled = true in plugin config. " +
      "SECURITY: never use against auth flows or sensitive sites without review.",
    parameters: Type.Object({
      url: Type.String({
        description: "Target site URL to capture (e.g. https://api.example.com).",
      }),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 5,
          maximum: 300,
          description: "Capture duration in seconds (default: from config, typically 60).",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { url, timeoutSeconds } = params as { url: string; timeoutSeconds?: number };

      try {
        if (!cfg.apiTap.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "ApiTap integration is disabled. Set apiTap.enabled = true in plugin config to use this feature.",
              },
            ],
          };
        }

        if (!service.isAvailable()) {
          return {
            content: [
              {
                type: "text",
                text: "apitap CLI is not installed. Install it with: npm install -g @apitap/core\n\nSee https://www.npmjs.com/package/@apitap/core for documentation.",
              },
            ],
          };
        }

        const urlError = validateUrl(url, cfg.apiTap);
        if (urlError) {
          return {
            content: [{ type: "text", text: `Cannot capture: ${urlError}` }],
          };
        }

        const result = await service.capture(url, timeoutSeconds);

        if (result.error) {
          return {
            content: [{ type: "text", text: `Capture failed: ${result.error}` }],
          };
        }

        const { stored, outputText } = persistAndFormatEndpoints(
          result,
          url,
          cfg,
          apitapStore,
          `ApiTap capture complete`,
          "",
        );

        const lines = outputText.split("\n");
        lines.splice(2, 0, `  Duration:         ${Math.round(result.durationMs / 1000)}s`);

        if (stored.length > 0) {
          lines[lines.length - 2] = "Discovered endpoints (pending review):";
          lines.push("Use apitap_list to see all discovered endpoints.");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { sessionId: result.sessionId, stored: stored.length, endpoints: stored },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "apitap",
          operation: "apitap-capture",
          phase: "runtime",
        });
        throw err;
      }
    },
  });

  // -------------------------------------------------------------------------
  // apitap_peek — quick headless API discovery
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "apitap_peek",
    label: "ApiTap: Quick API Discovery (Peek)",
    description:
      "Run a headless API discovery scan against a URL without opening a visible browser window. " +
      "Faster than apitap_capture but may miss dynamically loaded endpoints. " +
      "Ideal for initial API exploration before committing to a full capture session. " +
      "Requires apiTap.enabled = true in plugin config.",
    parameters: Type.Object({
      url: Type.String({
        description: "Target site URL to scan (e.g. https://api.example.com).",
      }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { url } = params as { url: string };

      try {
        if (!cfg.apiTap.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "ApiTap integration is disabled. Set apiTap.enabled = true in plugin config to use this feature.",
              },
            ],
          };
        }

        if (!service.isAvailable()) {
          return {
            content: [
              {
                type: "text",
                text: "apitap CLI is not installed. Install it with: npm install -g @apitap/core",
              },
            ],
          };
        }

        const urlError = validateUrl(url, cfg.apiTap);
        if (urlError) {
          return {
            content: [{ type: "text", text: `Cannot peek: ${urlError}` }],
          };
        }

        const result = await service.peek(url);

        if (result.error) {
          return {
            content: [{ type: "text", text: `Peek failed: ${result.error}` }],
          };
        }

        const { stored, outputText } = persistAndFormatEndpoints(
          result,
          url,
          cfg,
          apitapStore,
          `ApiTap peek complete`,
          "No API endpoints discovered. Try apitap_capture for a more thorough scan.",
        );

        const lines = outputText.split("\n");
        lines.splice(2, 0, `  Duration:         ${Math.round(result.durationMs / 1000)}s`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { sessionId: result.sessionId, stored: stored.length, endpoints: stored },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "apitap",
          operation: "apitap-peek",
          phase: "runtime",
        });
        throw err;
      }
    },
  });

  // -------------------------------------------------------------------------
  // apitap_list — list discovered endpoints
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "apitap_list",
    label: "ApiTap: List Discovered Endpoints",
    description:
      "List API endpoints previously discovered by apitap_capture or apitap_peek. " +
      "Filter by site URL, session ID, or review status. " +
      "Use the endpoint ID with apitap_to_skill to generate a skill scaffold.",
    parameters: Type.Object({
      siteUrl: Type.Optional(
        Type.String({
          description: "Filter by site URL (partial match).",
        }),
      ),
      sessionId: Type.Optional(
        Type.String({
          description: "Filter by capture session ID.",
        }),
      ),
      status: Type.Optional(
        Type.Union(
          [Type.Literal("pending"), Type.Literal("reviewed"), Type.Literal("accepted"), Type.Literal("rejected")],
          {
            description: "Filter by review status. Omit to list all non-expired endpoints.",
          },
        ),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Maximum number of endpoints to return (default: 20).",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { siteUrl, sessionId, status, limit } = params as {
        siteUrl?: string;
        sessionId?: string;
        status?: "pending" | "reviewed" | "accepted" | "rejected";
        limit?: number;
      };

      try {
        if (!cfg.apiTap.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "ApiTap integration is disabled. Set apiTap.enabled = true in plugin config.",
              },
            ],
          };
        }

        const endpoints = apitapStore.list({
          siteUrl,
          sessionId,
          status,
          limit: limit ?? 20,
        });

        if (endpoints.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No discovered endpoints found. Run apitap_capture or apitap_peek to discover APIs.",
              },
            ],
            details: [],
          };
        }

        const lines = endpoints.map((ep, i) => {
          const expiry = ep.expiresAt ? ` | expires ${ep.expiresAt.slice(0, 10)}` : "";
          return (
            `${i + 1}. [${ep.status.toUpperCase()}] [${ep.method}] ${ep.endpoint}${expiry}\n` +
            `   Site: ${ep.siteUrl}\n` +
            `   ID: ${ep.id}\n` +
            `   Captured: ${ep.capturedAt.slice(0, 10)}`
          );
        });

        const summary = `Found ${endpoints.length} endpoint(s):\n\n` + lines.join("\n\n");

        return {
          content: [{ type: "text", text: summary }],
          details: endpoints,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "apitap",
          operation: "apitap-list",
          phase: "runtime",
        });
        throw err;
      }
    },
  });

  // -------------------------------------------------------------------------
  // apitap_to_skill — generate skill scaffold from an endpoint
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "apitap_to_skill",
    label: "ApiTap: Convert Endpoint to Skill Scaffold",
    description:
      "Convert a discovered API endpoint into an OpenClaw skill scaffold spec. " +
      "The scaffold includes endpoint details, parameter schema, sample response, and a curl example. " +
      "Present the scaffold for human review before enabling it as a skill. " +
      "Use the endpoint ID from apitap_list.",
    parameters: Type.Object({
      id: Type.String({
        description: "The endpoint ID from apitap_list.",
      }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { id } = params as { id: string };

      try {
        if (!cfg.apiTap.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "ApiTap integration is disabled. Set apiTap.enabled = true in plugin config.",
              },
            ],
          };
        }

        const endpoint = apitapStore.getById(id);
        if (!endpoint) {
          return {
            content: [{ type: "text", text: `Endpoint ${id} not found. Use apitap_list to see available endpoints.` }],
          };
        }

        // Parameters and sampleResponse are already parsed objects from the store
        const parameters = endpoint.parameters;
        const sampleResponse = endpoint.sampleResponse;

        const scaffold = service.buildSkillScaffold(
          endpoint.siteUrl,
          endpoint.endpoint,
          endpoint.method,
          parameters,
          sampleResponse,
        );

        // Mark as reviewed
        apitapStore.updateStatus(id, "reviewed");

        const paramLines = Object.entries(scaffold.parameters).map(
          ([k, v]) => `    ${k}: ${v.type}  # ${v.description}`,
        );

        const lines: string[] = [];
        lines.push(`Skill scaffold for [${scaffold.method}] ${scaffold.endpoint}:`);
        lines.push("");
        lines.push(`Skill name:  ${scaffold.skillName}`);
        lines.push(`Description: ${scaffold.description}`);
        lines.push(`Endpoint:    ${scaffold.endpoint}`);
        lines.push(`Method:      ${scaffold.method}`);
        lines.push("");
        if (paramLines.length > 0) {
          lines.push("Parameters:");
          lines.push(...paramLines);
          lines.push("");
        }
        lines.push("Sample response (truncated):");
        lines.push(scaffold.sampleResponse.slice(0, 500));
        lines.push("");
        lines.push("curl example:");
        lines.push(`  ${scaffold.curlExample}`);
        lines.push("");
        lines.push("Review this spec before enabling. Use apitap_list to accept/reject endpoints.");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: scaffold,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "apitap",
          operation: "apitap-to-skill",
          phase: "runtime",
        });
        throw err;
      }
    },
  });
}
