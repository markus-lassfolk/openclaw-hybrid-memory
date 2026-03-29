/**
 * Credential Tool Registrations
 *
 * Tool definitions for storing, retrieving, listing, and deleting credentials
 * in encrypted storage. Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { stringEnum } from "../utils/typebox.js";

import type { CredentialsDB } from "../backends/credentials-db.js";
import { CREDENTIAL_TYPES, type CredentialType, type HybridMemoryConfig } from "../config.js";
import { withErrorTracking } from "../utils/error-tracking.js";
import { CREDENTIAL_NOTES_MAX_CHARS, CREDENTIAL_URL_MAX_CHARS, SECONDS_PER_DAY } from "../utils/constants.js";

interface PluginContext {
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
          const urlTrim =
            typeof url === "string" && url.length > CREDENTIAL_URL_MAX_CHARS
              ? url.slice(0, CREDENTIAL_URL_MAX_CHARS)
              : url;
          const notesTrim =
            typeof notes === "string" && notes.length > CREDENTIAL_NOTES_MAX_CHARS
              ? notes.slice(0, CREDENTIAL_NOTES_MAX_CHARS)
              : notes;
          withErrorTracking(
            () => credentialsDb.store({ service, type, value, url: urlTrim, notes: notesTrim, expires }),
            {
              subsystem: "credentials",
              operation: "credential-store",
              phase: "runtime",
              backend: "sqlite",
            },
          )();
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
          const entry = withErrorTracking(() => credentialsDb.get(service, type), {
            subsystem: "credentials",
            operation: "credential-get",
            phase: "runtime",
            backend: "sqlite",
          })();
          if (!entry) {
            return {
              content: [
                {
                  type: "text",
                  text: `No credential found for service "${service}"${type ? ` (type: ${type})` : ""}.`,
                },
              ],
              details: { found: false },
            };
          }
          const warnDays = cfg.credentials.expiryWarningDays ?? 7;
          const nowSec = Math.floor(Date.now() / 1000);
          const expiresSoon = entry.expires != null && entry.expires - nowSec < warnDays * 24 * 3600;
          const secLeft = entry.expires != null ? entry.expires - nowSec : 0;
          const daysLeft = secLeft / SECONDS_PER_DAY;
          let expiryWarning = "";
          if (expiresSoon) {
            if (secLeft <= 0) {
              expiryWarning = " [WARNING: Credential has expired — rotate immediately]";
            } else if (daysLeft < 1) {
              expiryWarning = ` [WARNING: Expires in ${Math.ceil(secLeft / 3600)} hours — consider rotating]`;
            } else {
              expiryWarning = ` [WARNING: Expires in ${Math.ceil(daysLeft)} days — consider rotating]`;
            }
          }
          return {
            content: [
              {
                type: "text",
                text: [
                  `Credential for ${entry.service} (${entry.type}) retrieved.${expiryWarning}`,
                  "",
                  "Credential value (shown here for use in this turn; omitted from structured `details` to reduce log/dashboard leakage — #890):",
                  entry.value,
                ].join("\n"),
              },
            ],
            details: {
              service: entry.service,
              type: entry.type,
              url: entry.url,
              expires: entry.expires,
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
        description:
          "List stored credentials (service/type/url only — no values). Use credential_get to retrieve a specific credential.",
        parameters: Type.Object({}),
        async execute() {
          if (!credentialsDb) throw new Error("Credentials store not available");
          const items = withErrorTracking(() => credentialsDb.list(), {
            subsystem: "credentials",
            operation: "credential-list",
            phase: "runtime",
            backend: "sqlite",
          })();
          if (items.length === 0) {
            return {
              content: [{ type: "text", text: "No credentials stored." }],
              details: { count: 0, items: [] },
            };
          }
          const lines = items.map(
            (i) =>
              `- ${i.service} (${i.type})${i.url ? ` @ ${i.url}` : ""}${i.expires ? ` [expires: ${new Date(i.expires * 1000).toISOString()}]` : ""}`,
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
        description:
          "Delete a stored credential by service name. Optionally specify type to delete only that credential type.",
        parameters: Type.Object({
          service: Type.String({ description: "Service name" }),
          type: Type.Optional(stringEnum(CREDENTIAL_TYPES as unknown as readonly string[])),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { service, type } = params as { service: string; type?: CredentialType };
          if (!credentialsDb) throw new Error("Credentials store not available");
          const deleted = withErrorTracking(() => credentialsDb.delete(service, type), {
            subsystem: "credentials",
            operation: "credential-delete",
            phase: "runtime",
            backend: "sqlite",
          })();
          if (!deleted) {
            return {
              content: [
                { type: "text", text: `No credential found for "${service}"${type ? ` (type: ${type})` : ""}.` },
              ],
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
