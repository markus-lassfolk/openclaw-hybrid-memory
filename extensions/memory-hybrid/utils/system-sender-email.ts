/**
 * Detect system/notification-sender email addresses (noreply@, robot@, mailer-daemon@, etc.)
 * that should never be treated as a person's or organization's own contact email — e.g. a
 * payment-notification email that mentions a company is not that company's email address (#2062).
 *
 * Shared between structured field extraction (services/fact-extraction.ts,
 * utils/contact-profile-patterns.ts) and contradiction detection (backends/facts-db/contradictions.ts)
 * so a blocklisted sender address is treated consistently everywhere: never assigned as a fact's
 * `key=email` value, and never allowed to compete as one side of a contradiction.
 */
const SYSTEM_SENDER_EMAIL_RE = /\b(?:no-?reply|robot|mailer-daemon|notifications?|bounce|postmaster)@/i;

export function isSystemSenderEmail(value: string | null | undefined): boolean {
  return typeof value === "string" && SYSTEM_SENDER_EMAIL_RE.test(value);
}
