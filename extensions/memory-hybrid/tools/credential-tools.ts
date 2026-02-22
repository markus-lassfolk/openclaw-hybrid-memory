/**
 * Credential Tool Registrations
 *
 * Tool definitions for storing, retrieving, listing, and deleting credentials
 * in encrypted storage. Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import type { CredentialsDB } from "../backends/credentials-db.js";
import { CREDENTIAL_TYPES, type CredentialType, type HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { SECONDS_PER_DAY } from "../utils/constants.js";

export interface PluginContext {
  credentialsDb: CredentialsDB | null;
  cfg: HybridMemoryConfig;
  api: ClawdbotPluginApi;
}

export function registerCredentialTools(ctx: PluginContext, api: ClawdbotPluginApi): void {
  const { credentialsDb, cfg } = ctx;

  if (cfg.credentials.enabled && credentialsDb) {
    api.registerTool(
      {
        name: "credential_store",
        label: "Store Credential",
        description:
          "Store a credential (API key, token, password, SSH key, etc.) in encrypted storage. Use exact service names for reliable retrieval.",
        parameters: Type.Object({
          service: Type.String({ description: "Service name (e.g. 'home-assistant', 'github', 'openai')" }),
          type: stringEnum(CREDENTIAL_TYPES as unknown as readonly string[]),
          value: Type.String({ description: "The secret value (token, password, API key)" }),
          url: Type.Optional(Type.String({ description: "Optional URL or endpoint" })),
          notes: Type.Optional(Type.String({ description: "Optional notes" })),
          expires: Type.Optional(Type.Number({ description: "Optional Unix timestamp when credential expires" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { service, type, value, url, notes, expires } = params as {
            service: string;
            type: CredentialType;
            value: string;
            url?: string;
            notes?: string;
            expires?: number | null;
          };
          if (!credentialsDb) throw new Error("Credentials store not available");
          try {
            credentialsDb.store({ service, type, value, url, notes, expires });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "credentials",
              operation: "credential-store",
              phase: "runtime",
              backend: "sqlite",
            });
            throw err;
          }
          return {
            content: [{ type: "text", text: `Stored credential for ${service} (${type}).` }],
            details: { service, type },
          };
        },
      },
      { name: "credential_store" },
    );

    api.registerTool(
      {
        name: "credential_get",
        label: "Get Credential",
        description:
          "Retrieve a credential by service name. Exact lookup — no fuzzy search. Specify type to disambiguate when multiple credential types exist for a service.",
        parameters: Type.Object({
          service: Type.String({ description: "Service name (e.g. 'home-assistant', 'github')" }),
          type: Type.Optional(stringEnum(CREDENTIAL_TYPES as unknown as readonly string[])),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { service, type } = params as { service: string; type?: CredentialType };
          if (!credentialsDb) throw new Error("Credentials store not available");
          let entry;
          try {
            entry = credentialsDb.get(service, type);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "credentials",
              operation: "credential-get",
              phase: "runtime",
              backend: "sqlite",
            });
            throw err;
          }
          if (!entry) {
            return {
              content: [{ type: "text", text: `No credential found for service "${service}"${type ? ` (type: ${type})` : ""}.` }],
              details: { found: false },
            };
          }
          const warnDays = cfg.credentials.expiryWarningDays ?? 7;
          const nowSec = Math.floor(Date.now() / 1000);
          const expiresSoon = entry.expires != null && entry.expires - nowSec < warnDays * 24 * 3600;
          const expiryWarning = expiresSoon
            ? ` [WARNING: Expires in ${Math.ceil((entry.expires! - nowSec) / SECONDS_PER_DAY)} days — consider rotating]`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Credential for ${entry.service} (${entry.type}) retrieved. Value available in tool result (details.value).${expiryWarning}`,
              },
            ],
            details: {
              service: entry.service,
              type: entry.type,
              url: entry.url,
              expires: entry.expires,
              value: entry.value,
              sensitiveFields: ["value"],
            },
          };
        },
      },
      { name: "credential_get" },
    );

    api.registerTool(
      {
        name: "credential_list",
        label: "List Credentials",
        description: "List stored credentials (service/type/url only — no values). Use credential_get to retrieve a specific credential.",
        parameters: Type.Object({}),
        async execute() {
          if (!credentialsDb) throw new Error("Credentials store not available");
          let items;
          try {
            items = credentialsDb.list();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "credentials",
              operation: "credential-list",
              phase: "runtime",
              backend: "sqlite",
            });
            throw err;
          }
          if (items.length === 0) {
            return {
              content: [{ type: "text", text: "No credentials stored." }],
              details: { count: 0, items: [] },
            };
          }
          const lines = items.map(
            (i) => `- ${i.service} (${i.type})${i.url ? ` @ ${i.url}` : ""}${i.expires ? ` [expires: ${new Date(i.expires * 1000).toISOString()}]` : ""}`,
          );
          return {
            content: [{ type: "text", text: `Stored credentials:\n${lines.join("\n")}` }],
            details: { count: items.length, items },
          };
        },
      },
      { name: "credential_list" },
    );

    api.registerTool(
      {
        name: "credential_delete",
        label: "Delete Credential",
        description: "Delete a stored credential by service name. Optionally specify type to delete only that credential type.",
        parameters: Type.Object({
          service: Type.String({ description: "Service name" }),
          type: Type.Optional(stringEnum(CREDENTIAL_TYPES as unknown as readonly string[])),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { service, type } = params as { service: string; type?: CredentialType };
          if (!credentialsDb) throw new Error("Credentials store not available");
          let deleted;
          try {
            deleted = credentialsDb.delete(service, type);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "credentials",
              operation: "credential-delete",
              phase: "runtime",
              backend: "sqlite",
            });
            throw err;
          }
          if (!deleted) {
            return {
              content: [{ type: "text", text: `No credential found for "${service}"${type ? ` (type: ${type})` : ""}.` }],
              details: { deleted: false },
            };
          }
          return {
            content: [{ type: "text", text: `Deleted credential for ${service}${type ? ` (${type})` : ""}.` }],
            details: { deleted: true, service, type },
          };
        },
      },
      { name: "credential_delete" },
    );
  }
}
