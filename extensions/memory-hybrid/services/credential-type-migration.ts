/**
 * Legacy credential type normalization (e.g. invalid type=url rows).
 */

import type { CredentialType } from "../config.js";

/** Non-secret placeholder for endpoint-only rows migrated from legacy type=url. */
export const ENDPOINT_ONLY_CREDENTIAL_VALUE = "endpoint-url-only";

const MERGE_INTO_SIBLING_TYPES: CredentialType[] = ["bearer", "token", "api_key", "password"];

/** Strip optional `url:` prefix from legacy type=url credential values. */
export function extractUrlFromLegacyCredentialValue(value: string): string {
  const trimmed = value.trim();
  const prefixed = /^url:\s*(.+)$/i.exec(trimmed);
  return (prefixed?.[1] ?? trimmed).trim();
}

export function planLegacyUrlCredentialMigration(input: {
  service: string;
  decryptedValue: string;
  existingUrl: string | null;
  existingNotes: string | null;
  siblingTypesPresent: Set<string>;
}): {
  action: "merge_into_sibling" | "convert_to_other" | "merge_into_other" | "noop";
  endpointUrl?: string;
  siblingType?: CredentialType;
  notes?: string | null;
} {
  const endpointUrl = (input.existingUrl?.trim() || extractUrlFromLegacyCredentialValue(input.decryptedValue)).trim();
  if (!endpointUrl) {
    return { action: "noop" };
  }

  for (const siblingType of MERGE_INTO_SIBLING_TYPES) {
    if (input.siblingTypesPresent.has(siblingType)) {
      return { action: "merge_into_sibling", endpointUrl, siblingType };
    }
  }

  if (input.siblingTypesPresent.has("other")) {
    return { action: "merge_into_other", endpointUrl };
  }

  const notes = [input.existingNotes?.trim(), "Migrated from legacy vault type=url (endpoint moved to url field)."]
    .filter(Boolean)
    .join(" ");

  return {
    action: "convert_to_other",
    endpointUrl,
    notes: notes || null,
  };
}
