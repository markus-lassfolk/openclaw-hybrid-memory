/**
 * Direct unit coverage for the system-sender email blocklist (#2062).
 */

import { describe, expect, it } from "vitest";
import { isSystemSenderEmail } from "../utils/system-sender-email.js";

describe("isSystemSenderEmail", () => {
  it("detects the original blocklist forms", () => {
    expect(isSystemSenderEmail("noreply@vendor-example.com")).toBe(true);
    expect(isSystemSenderEmail("no-reply@vendor-example.com")).toBe(true);
    expect(isSystemSenderEmail("robot@notify-example.se")).toBe(true);
    expect(isSystemSenderEmail("mailer-daemon@example.com")).toBe(true);
    expect(isSystemSenderEmail("notification@example.com")).toBe(true);
    expect(isSystemSenderEmail("notifications@example.com")).toBe(true);
    expect(isSystemSenderEmail("bounce@example.com")).toBe(true);
    expect(isSystemSenderEmail("postmaster@example.com")).toBe(true);
  });

  it("detects the broadened no-reply variants", () => {
    expect(isSystemSenderEmail("no.reply@vendor-example.com")).toBe(true);
    expect(isSystemSenderEmail("no_reply@vendor-example.com")).toBe(true);
    expect(isSystemSenderEmail("donotreply@vendor-example.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSystemSenderEmail("NoReply@Vendor-Example.com")).toBe(true);
    expect(isSystemSenderEmail("DoNotReply@Vendor-Example.com")).toBe(true);
  });

  it("does not flag a genuine personal or role address", () => {
    expect(isSystemSenderEmail("jane.doe@example.com")).toBe(false);
    expect(isSystemSenderEmail("sam.patel@example.com")).toBe(false);
  });

  it("returns false for null/undefined/non-string input", () => {
    expect(isSystemSenderEmail(null)).toBe(false);
    expect(isSystemSenderEmail(undefined)).toBe(false);
  });
});
