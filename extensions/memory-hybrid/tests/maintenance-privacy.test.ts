import { describe, expect, it } from "vitest";
import {
  type MaintenancePrivacyRedactionConfig,
  maybeRedactMaintenanceFactText,
  redactMaintenancePrivateText,
} from "../utils/maintenance-privacy.js";

const DISABLED: MaintenancePrivacyRedactionConfig = {
  enabled: false,
  exemptCategories: ["entity"],
  exemptKeys: ["email", "phone", "mobile"],
};

const ENABLED: MaintenancePrivacyRedactionConfig = {
  enabled: true,
  exemptCategories: ["entity"],
  exemptKeys: ["email", "phone", "mobile"],
};

describe("redactMaintenancePrivateText", () => {
  it("replaces emails, home paths, and private IPs", () => {
    const out = redactMaintenancePrivateText("Contact jane@example.com at /home/jane or 192.168.1.5");
    expect(out).toBe("Contact [redacted-email] at [private-path] or [private-ip]");
  });
});

describe("maybeRedactMaintenanceFactText (#2055)", () => {
  it("does not redact when disabled (default) even for non-exempt category/key", () => {
    const text = "Contact jane@example.com";
    expect(maybeRedactMaintenanceFactText(text, DISABLED, { category: "other", key: "note" })).toBe(text);
  });

  it("redacts when enabled and no exemption matches", () => {
    const text = "Contact jane@example.com";
    expect(maybeRedactMaintenanceFactText(text, ENABLED, { category: "other", key: "note" })).toBe(
      "Contact [redacted-email]",
    );
  });

  it("exempts an exempted category even when enabled", () => {
    const text = "Contact jane@example.com";
    expect(maybeRedactMaintenanceFactText(text, ENABLED, { category: "entity", key: "note" })).toBe(text);
  });

  it("exempts an exempted key even when enabled", () => {
    const text = "jane@example.com";
    expect(maybeRedactMaintenanceFactText(text, ENABLED, { category: "other", key: "email" })).toBe(text);
  });

  it("redacts when enabled and no context is provided", () => {
    const text = "jane@example.com";
    expect(maybeRedactMaintenanceFactText(text, ENABLED)).toBe("[redacted-email]");
  });

  it("exempts an exempted key case-insensitively (LLM-emitted key casing is not normalized)", () => {
    const text = "jane@example.com";
    expect(maybeRedactMaintenanceFactText(text, ENABLED, { category: "other", key: "Email" })).toBe(text);
    expect(maybeRedactMaintenanceFactText(text, ENABLED, { category: "other", key: "PHONE" })).toBe(text);
  });
});
