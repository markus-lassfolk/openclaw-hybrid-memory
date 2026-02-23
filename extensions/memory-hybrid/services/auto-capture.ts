/**
 * Auto-capture Filters
 *
 * Extracted from index.ts - functions for determining if content should be auto-captured
 */

import { getMemoryTriggerRegexes } from "../utils/language-keywords.js";
import { CREDENTIAL_NOTES_MAX_CHARS } from "../utils/constants.js";
import { truncateText } from "../utils/text.js";
import { validateCredentialValue, validateAndNormalizeServiceName } from "./credential-validation.js";

/** Memory triggers: English + dynamic languages from .language-keywords.json (see build-languages command). */
export function getMemoryTriggers(): RegExp[] {
  return getMemoryTriggerRegexes();
}

export const SENSITIVE_PATTERNS = [
  /password/i,
  /api.?key/i,
  /secret/i,
  /token\s+is/i,
  /\bssn\b/i,
  /credit.?card/i,
  /AKIA[0-9A-Z]{16}/, // AWS access keys
  /-----BEGIN .*PRIVATE KEY/, // Private key headers (RSA, EC, etc.)
  /:\/\/[^\s:@]+:[^\s@]+@[^\s/]+/, // Connection strings with embedded passwords (e.g., mongodb://user:pass@host) - Note: usernames with colons will fail
];

/** Patterns that suggest a credential value - for auto-detect prompt to store */
const CREDENTIAL_PATTERNS: Array<{ regex: RegExp; type: string; hint: string }> = [
  { regex: /Bearer\s+eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i, type: "bearer", hint: "Bearer/JWT token" },
  { regex: /sk-[A-Za-z0-9]{20,}/, type: "api_key", hint: "OpenAI-style API key (sk-...)" },
  { regex: /ghp_[A-Za-z0-9]{36}/, type: "api_key", hint: "GitHub personal access token" },
  { regex: /gho_[A-Za-z0-9]{36}/, type: "api_key", hint: "GitHub OAuth token" },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/, type: "token", hint: "Slack token" },
  { regex: /ssh\s+[\w@.-]+\s+[\w@.-]+/i, type: "ssh", hint: "SSH connection string" },
  { regex: /[\w.-]+@[\w.-]+\.\w+.*(?:password|passwd|token|key)\s*[:=]\s*\S+/i, type: "password", hint: "Credentials with host/email" },
];

export function detectCredentialPatterns(text: string): Array<{ type: string; hint: string }> {
  const found: Array<{ type: string; hint: string }> = [];
  const seen = new Set<string>();
  for (const { regex, type, hint } of CREDENTIAL_PATTERNS) {
    if (regex.test(text) && !seen.has(hint)) {
      seen.add(hint);
      found.push({ type, hint });
    }
  }
  return found;
}

/** First credential-like match in text; used to extract secret for vault. */
export function extractCredentialMatch(text: string): { type: string; secretValue: string } | null {
  for (const { regex, type } of CREDENTIAL_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      const secretValue = match[0].replace(/^Bearer\s+/i, "").trim();
      if (secretValue.length >= 8) return { type, secretValue };
    }
  }
  return null;
}

/** True if content should be treated as a credential (store in vault when enabled, else in memory). */
export function isCredentialLike(
  text: string,
  entity?: string | null,
  key?: string | null,
  value?: string | null,
): boolean {
  if ((entity ?? "").toLowerCase() === "credentials") return true;
  const k = (key ?? "").toLowerCase();
  const e = (entity ?? "").toLowerCase();
  if (["api_key", "password", "token", "secret", "bearer"].some((x) => k.includes(x) || e.includes(x)))
    return true;
  if (value && value.length >= 8 && /^(eyJ|sk-|ghp_|gho_|xox[baprs]-)/i.test(value)) return true;
  return CREDENTIAL_PATTERNS.some((p) => p.regex.test(text)) || SENSITIVE_PATTERNS.some((r) => r.test(text));
}

export const VAULT_POINTER_PREFIX = "vault:";

/** Options for tryParseCredentialForVault (e.g. from config). */
export type TryParseCredentialOptions = {
  /** When true, return null unless extractCredentialMatch found a pattern (reject value-only). */
  requirePatternMatch?: boolean;
};

/** Parse into vault entry when vault is enabled. Returns null if not credential-like or cannot derive service/secret. */
export function tryParseCredentialForVault(
  text: string,
  entity?: string | null,
  key?: string | null,
  value?: string | null,
  options?: TryParseCredentialOptions,
): { service: string; type: "token" | "password" | "api_key" | "ssh" | "bearer" | "other"; secretValue: string; url?: string; notes?: string } | null {
  if (!isCredentialLike(text, entity, key, value)) return null;
  const match = extractCredentialMatch(text);
  if (options?.requirePatternMatch && !match) return null;
  const secretValue = (value && value.length >= 8 ? value : match?.secretValue) ?? null;
  if (!secretValue) return null;
  const typeFromPattern = (match?.type ?? "other") as "token" | "password" | "api_key" | "ssh" | "bearer" | "other";
  const hasPatternMatch = !!match;
  const valueValidation = validateCredentialValue(secretValue, typeFromPattern, hasPatternMatch);
  if (!valueValidation.ok) return null;

  const service =
    (entity?.toLowerCase() === "credentials" ? key : null) ||
    key ||
    (entity && entity.toLowerCase() !== "credentials" ? entity : null) ||
    inferServiceFromText(text) ||
    "imported";
  const rawSlug = service.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "imported";
  const serviceSlug = validateAndNormalizeServiceName(rawSlug);
  if (serviceSlug === null) return null;

  return {
    service: serviceSlug,
    type: typeFromPattern,
    secretValue,
    notes: text.length <= CREDENTIAL_NOTES_MAX_CHARS ? text : truncateText(text, CREDENTIAL_NOTES_MAX_CHARS - 3, "..."),
  };
}

export function inferServiceFromText(text: string): string {
  const lower = text.toLowerCase();
  if (/home\s*assistant|ha\s*token|hass/i.test(lower)) return "home-assistant";
  if (/unifi|ubiquiti/i.test(lower)) return "unifi";
  if (/github|ghp_|gho_/i.test(lower)) return "github";
  if (/openai|sk-proj/i.test(lower)) return "openai";
  if (/twilio/i.test(lower)) return "twilio";
  if (/duckdns/i.test(lower)) return "duckdns";
  if (/slack|xox[baprs]/i.test(lower)) return "slack";
  return "imported";
}
