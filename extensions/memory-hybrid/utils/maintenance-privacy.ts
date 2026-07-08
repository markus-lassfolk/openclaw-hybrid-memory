/**
 * Redact private paths and emails before persisting maintenance-extracted text.
 */

const HOME_PATH_RE = /\/(?:home|Users)\/[^\s/]+(?:\/[^\s)\]}>"']*)?/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PRIVATE_IP_RE = /\b192\.168\.\d{1,3}\.\d{1,3}\b/g;

export function redactMaintenancePrivateText(text: string): string {
  return text
    .replace(HOME_PATH_RE, "[private-path]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PRIVATE_IP_RE, "[private-ip]");
}

/** Config gate for {@link maybeRedactMaintenanceFactText} (see config/types/maintenance.ts). */
export interface MaintenancePrivacyRedactionConfig {
  enabled: boolean;
  exemptCategories: string[];
  exemptKeys: string[];
}

/** Category/key of the fact being stored, used to honor per-fact redaction exemptions. */
export interface MaintenanceFactRedactionContext {
  category?: string | null;
  key?: string | null;
}

/**
 * Redact `text` per `redaction` before it is written to a stored fact's `text`/`value` — but only
 * when `redaction.enabled` is true and the fact's category/key isn't exempted (#2055). A missing/
 * partial `redaction` (e.g. an older or hand-built config object) is treated as disabled, not as an
 * error.
 *
 * Default is disabled: this is a personal-memory system, and emails/IPs/paths are usually exactly
 * what an operator wants remembered (recall of `[redacted-email]` is useless, and it creates false
 * "ambiguous" pairs against the same contact's real address stored via `memory_store`). Actual
 * secrets (passwords, API keys) already go through the separate, deliberately opt-in credential
 * vault — this regex-based scrub was never the thing protecting those.
 */
export function maybeRedactMaintenanceFactText(
  text: string,
  redaction: MaintenancePrivacyRedactionConfig | null | undefined,
  context: MaintenanceFactRedactionContext = {},
): string {
  if (!redaction?.enabled) return text;
  if (context.category && redaction.exemptCategories?.includes(context.category)) return text;
  // Case-insensitive: fact.key casing is LLM-emitted (e.g. "Email"), not normalized before this
  // is called, while exemptKeys defaults to lowercase ("email", "phone", "mobile").
  const keyLower = context.key?.toLowerCase();
  if (keyLower && redaction.exemptKeys?.some((k) => k.toLowerCase() === keyLower)) return text;
  return redactMaintenancePrivateText(text);
}
