/**
 * Tests for Issue #280: ACP provenance tracking for council reviews.
 * Covers utils/provenance.ts and config parsing for maintenance.council.
 */

import { describe, it, expect } from "vitest";
import {
  getProvenanceHeaders,
  formatProvenanceReceipt,
  buildProvenanceMetadata,
  generateTraceId,
  buildCouncilSessionKey,
} from "../utils/provenance.js";
import { hybridConfigSchema } from "../config.js";

// ---------------------------------------------------------------------------
// generateTraceId
// ---------------------------------------------------------------------------

describe("generateTraceId", () => {
  it("returns a string matching 'trace-<8 hex chars>'", () => {
    const id = generateTraceId();
    expect(id).toMatch(/^trace-[0-9a-f]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, generateTraceId));
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// buildCouncilSessionKey
// ---------------------------------------------------------------------------

describe("buildCouncilSessionKey", () => {
  it("combines prefix and suffix", () => {
    const key = buildCouncilSessionKey("council-review", "283");
    expect(key).toBe("council-review-283");
  });

  it("generates random suffix when none given", () => {
    const key = buildCouncilSessionKey("council-review");
    expect(key).toMatch(/^council-review-[0-9a-f]{8}$/);
  });

  it("trims whitespace from suffix", () => {
    const key = buildCouncilSessionKey("council-review", "  pr-42  ");
    expect(key).toBe("council-review-pr-42");
  });

  it("uses random suffix when empty string passed", () => {
    const key = buildCouncilSessionKey("council-review", "");
    expect(key).toMatch(/^council-review-[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// getProvenanceHeaders
// ---------------------------------------------------------------------------

describe("getProvenanceHeaders", () => {
  it("always includes X-Trace-Id and X-Session-Key", () => {
    const headers = getProvenanceHeaders("council-review-test");
    expect(headers).toHaveProperty("X-Trace-Id");
    expect(headers["X-Trace-Id"]).toMatch(/^trace-[0-9a-f]{8}$/);
    expect(headers["X-Session-Key"]).toBe("council-review-test");
  });

  it("uses provided traceId when given", () => {
    const headers = getProvenanceHeaders("session-key", { traceId: "trace-deadbeef" });
    expect(headers["X-Trace-Id"]).toBe("trace-deadbeef");
  });

  it("includes X-Council-Member when given", () => {
    const headers = getProvenanceHeaders("sk", { councilMember: "🔮 Gemini" });
    expect(headers["X-Council-Member"]).toBe("🔮 Gemini");
  });

  it("includes X-Parent-Session when given", () => {
    const headers = getProvenanceHeaders("sk", { parentSession: "main" });
    expect(headers["X-Parent-Session"]).toBe("main");
  });

  it("omits optional headers when not given", () => {
    const headers = getProvenanceHeaders("sk");
    expect(headers).not.toHaveProperty("X-Council-Member");
    expect(headers).not.toHaveProperty("X-Parent-Session");
  });

  it("returns plain string values (no objects)", () => {
    const headers = getProvenanceHeaders("sk", { councilMember: "Claude", parentSession: "main" });
    for (const val of Object.values(headers)) {
      expect(typeof val).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// formatProvenanceReceipt
// ---------------------------------------------------------------------------

describe("formatProvenanceReceipt", () => {
  it("includes trace-id and session key in receipt", () => {
    const receipt = formatProvenanceReceipt("trace-abc12345", "council-review-283");
    expect(receipt).toContain("trace-id=trace-abc12345");
    expect(receipt).toContain("session=council-review-283");
  });

  it("includes an ISO timestamp", () => {
    const receipt = formatProvenanceReceipt("trace-abc12345", "sk");
    expect(receipt).toMatch(/at=\d{4}-\d{2}-\d{2}T/);
  });

  it("starts with markdown separator", () => {
    const receipt = formatProvenanceReceipt("trace-abc12345", "sk");
    expect(receipt).toMatch(/^---\n\*Provenance:/);
  });
});

// ---------------------------------------------------------------------------
// buildProvenanceMetadata
// ---------------------------------------------------------------------------

describe("buildProvenanceMetadata", () => {
  it("mode='none' returns null headers and null receipt", () => {
    const { headers, receipt } = buildProvenanceMetadata("none", "sk");
    expect(headers).toBeNull();
    expect(receipt).toBeNull();
  });

  it("mode='meta' returns headers but no receipt", () => {
    const { headers, receipt } = buildProvenanceMetadata("meta", "sk");
    expect(headers).not.toBeNull();
    expect(receipt).toBeNull();
    expect(headers?.["X-Session-Key"]).toBe("sk");
  });

  it("mode='receipt' returns no headers but includes receipt", () => {
    const { headers, receipt } = buildProvenanceMetadata("receipt", "sk");
    expect(headers).toBeNull();
    expect(receipt).not.toBeNull();
    expect(receipt).toContain("session=sk");
  });

  it("mode='meta+receipt' returns both headers and receipt", () => {
    const { headers, receipt } = buildProvenanceMetadata("meta+receipt", "sk");
    expect(headers).not.toBeNull();
    expect(receipt).not.toBeNull();
  });

  it("uses provided traceId consistently across headers and receipt", () => {
    const { headers, receipt } = buildProvenanceMetadata("meta+receipt", "sk", {
      traceId: "trace-cafebabe",
    });
    expect(headers?.["X-Trace-Id"]).toBe("trace-cafebabe");
    expect(receipt).toContain("trace-id=trace-cafebabe");
  });

  it("passes councilMember and parentSession to headers", () => {
    const { headers } = buildProvenanceMetadata("meta+receipt", "sk", {
      councilMember: "🔮 Gemini",
      parentSession: "main",
    });
    expect(headers?.["X-Council-Member"]).toBe("🔮 Gemini");
    expect(headers?.["X-Parent-Session"]).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Config: maintenance.council parsing
// ---------------------------------------------------------------------------

describe("config maintenance.council parsing", () => {
  it("defaults to provenance='meta+receipt' and sessionKeyPrefix='council-review'", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
      lanceDbPath: "/tmp/test-lance",
      sqlitePath: "/tmp/test.db",
    });
    expect(cfg.maintenance.council.provenance).toBe("meta+receipt");
    expect(cfg.maintenance.council.sessionKeyPrefix).toBe("council-review");
  });

  it("accepts valid provenance modes", () => {
    for (const mode of ["meta+receipt", "meta", "receipt", "none"] as const) {
      const cfg = hybridConfigSchema.parse({
        embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
        lanceDbPath: "/tmp/test-lance",
        sqlitePath: "/tmp/test.db",
        maintenance: { council: { provenance: mode } },
      });
      expect(cfg.maintenance.council.provenance).toBe(mode);
    }
  });

  it("falls back to 'meta+receipt' for invalid provenance mode", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
      lanceDbPath: "/tmp/test-lance",
      sqlitePath: "/tmp/test.db",
      maintenance: { council: { provenance: "invalid-mode" } },
    });
    expect(cfg.maintenance.council.provenance).toBe("meta+receipt");
  });

  it("accepts custom sessionKeyPrefix", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
      lanceDbPath: "/tmp/test-lance",
      sqlitePath: "/tmp/test.db",
      maintenance: { council: { sessionKeyPrefix: "pr-review" } },
    });
    expect(cfg.maintenance.council.sessionKeyPrefix).toBe("pr-review");
  });

  it("ignores whitespace-only sessionKeyPrefix and uses default", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
      lanceDbPath: "/tmp/test-lance",
      sqlitePath: "/tmp/test.db",
      maintenance: { council: { sessionKeyPrefix: "   " } },
    });
    expect(cfg.maintenance.council.sessionKeyPrefix).toBe("council-review");
  });
});
