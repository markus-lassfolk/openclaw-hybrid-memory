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
