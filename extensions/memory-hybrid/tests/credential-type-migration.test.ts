import { describe, expect, it } from "vitest";
import {
  ENDPOINT_ONLY_CREDENTIAL_VALUE,
  extractUrlFromLegacyCredentialValue,
  planLegacyUrlCredentialMigration,
} from "../services/credential-type-migration.js";
import { assertValidCredentialType, auditCredentialType } from "../services/credential-validation.js";

describe("credential type validation", () => {
  it("rejects url as credential type", () => {
    expect(() => assertValidCredentialType("url")).toThrow(/not in `type`/i);
    expect(auditCredentialType("url")).toContain("legacy_invalid_type");
  });

  it("accepts standard credential types", () => {
    expect(() => assertValidCredentialType("bearer")).not.toThrow();
    expect(auditCredentialType("bearer")).toEqual([]);
  });
});

describe("legacy type=url migration planning", () => {
  it("extracts url from value with optional prefix", () => {
    expect(extractUrlFromLegacyCredentialValue("url: https://api.example.com")).toBe("https://api.example.com");
    expect(extractUrlFromLegacyCredentialValue("https://api.example.com")).toBe("https://api.example.com");
  });

  it("merges into sibling bearer when present", () => {
    const plan = planLegacyUrlCredentialMigration({
      service: "my-api",
      decryptedValue: "https://api.example.com",
      existingUrl: null,
      existingNotes: null,
      siblingTypesPresent: new Set(["bearer", "url"]),
    });
    expect(plan.action).toBe("merge_into_sibling");
    expect(plan.siblingType).toBe("bearer");
    expect(plan.endpointUrl).toBe("https://api.example.com");
  });

  it("converts to other when no sibling exists", () => {
    const plan = planLegacyUrlCredentialMigration({
      service: "my-api",
      decryptedValue: "https://api.example.com",
      existingUrl: null,
      existingNotes: null,
      siblingTypesPresent: new Set(["url"]),
    });
    expect(plan.action).toBe("convert_to_other");
    expect(plan.endpointUrl).toBe("https://api.example.com");
    expect(plan.notes).toMatch(/legacy vault type=url/i);
  });

  it("uses endpoint-only placeholder constant", () => {
    expect(ENDPOINT_ONLY_CREDENTIAL_VALUE.length).toBeGreaterThanOrEqual(12);
  });
});
