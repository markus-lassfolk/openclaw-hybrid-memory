/**
 * auth-order.test.ts — Unit tests for OAuth-first auth profile ordering (issue #311).
 *
 * ## Coverage
 *
 * ### parseAuthConfig
 * - Returns undefined when auth section is absent, null, or not an object
 * - Returns undefined when auth.order is absent, not an object, or an array
 * - Returns undefined when all provider lists are empty (after filtering)
 * - Parses a single-provider auth.order with OAuth profiles
 * - Parses multi-provider auth.order with mixed OAuth + API key profiles
 * - Normalises provider keys to lowercase
 * - Trims whitespace from profile names
 * - Filters out non-string entries in profile lists
 * - Returns undefined for empty provider profile lists
 * - Handles the full OAuth-first example from the issue description
 *
 * ### hasOAuthProfiles
 * - API-key-only profiles ('<provider>:api', '<provider>:default') do NOT trigger OAuth routing
 * - At least one non-API-key profile triggers OAuth routing
 * - Empty profile list does NOT trigger OAuth routing
 * - undefined profile list does NOT trigger OAuth routing
 */

import { describe, it, expect } from "vitest";
import { parseAuthConfig } from "../config/parsers/core.js";
import { hasOAuthProfiles } from "../utils/auth.js";

// ---------------------------------------------------------------------------
// parseAuthConfig — absent / invalid inputs
// ---------------------------------------------------------------------------

describe("parseAuthConfig — absent or invalid inputs", () => {
  it("returns undefined when auth is absent", () => {
    expect(parseAuthConfig({})).toBeUndefined();
  });

  it("returns undefined when auth is null", () => {
    expect(parseAuthConfig({ auth: null })).toBeUndefined();
  });

  it("returns undefined when auth is a string", () => {
    expect(parseAuthConfig({ auth: "anthropic:claude-cli" })).toBeUndefined();
  });

  it("returns undefined when auth is an array", () => {
    expect(parseAuthConfig({ auth: ["anthropic:claude-cli"] })).toBeUndefined();
  });

  it("returns undefined when auth.order is absent", () => {
    expect(parseAuthConfig({ auth: {} })).toBeUndefined();
  });

  it("returns undefined when auth.order is null", () => {
    expect(parseAuthConfig({ auth: { order: null } })).toBeUndefined();
  });

  it("returns undefined when auth.order is an array", () => {
    expect(parseAuthConfig({ auth: { order: ["anthropic:claude-cli"] } })).toBeUndefined();
  });

  it("returns undefined when auth.order is a string", () => {
    expect(parseAuthConfig({ auth: { order: "anthropic:claude-cli" } })).toBeUndefined();
  });

  it("returns undefined when auth.order is an empty object", () => {
    // No providers configured — nothing to return
    const result = parseAuthConfig({ auth: { order: {} } });
    expect(result).toBeUndefined();
  });

  it("returns undefined when all provider profile lists are empty", () => {
    const result = parseAuthConfig({ auth: { order: { anthropic: [], openai: [] } } });
    expect(result).toBeUndefined();
  });

  it("returns undefined when all profiles are non-strings (filtered out)", () => {
    const result = parseAuthConfig({ auth: { order: { anthropic: [null, 42, true, {}] } } });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseAuthConfig — valid single-provider inputs
// ---------------------------------------------------------------------------

describe("parseAuthConfig — single provider", () => {
  it("parses anthropic auth.order with OAuth-first", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["anthropic:claude-cli", "anthropic:api"],
        },
      },
    });
    expect(result).toEqual({
      order: {
        anthropic: ["anthropic:claude-cli", "anthropic:api"],
      },
    });
  });

  it("parses openai auth.order with OAuth-first", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          openai: ["openai-codex", "openai:api"],
        },
      },
    });
    expect(result).toEqual({
      order: {
        openai: ["openai-codex", "openai:api"],
      },
    });
  });

  it("parses google auth.order with OAuth-first", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          google: ["google-gemini-cli", "google:default"],
        },
      },
    });
    expect(result).toEqual({
      order: {
        google: ["google-gemini-cli", "google:default"],
      },
    });
  });

  it("parses API-key-only auth.order (no OAuth)", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["anthropic:api"],
        },
      },
    });
    expect(result).toEqual({
      order: {
        anthropic: ["anthropic:api"],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// parseAuthConfig — multi-provider inputs
// ---------------------------------------------------------------------------

describe("parseAuthConfig — multi-provider (OAuth-first example from issue #311)", () => {
  it("parses the full OAuth-first config from the issue description", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["anthropic:claude-cli", "anthropic:api"],
          openai: ["openai-codex", "openai:api"],
          google: ["google-gemini-cli", "google:default"],
        },
      },
    });
    expect(result).toEqual({
      order: {
        anthropic: ["anthropic:claude-cli", "anthropic:api"],
        openai: ["openai-codex", "openai:api"],
        google: ["google-gemini-cli", "google:default"],
      },
    });
  });

  it("parses mixed OAuth + API providers", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["anthropic:claude-cli", "anthropic:api"],
          minimax: ["minimax-portal:minimax-cli"],
        },
      },
    });
    expect(result).toEqual({
      order: {
        anthropic: ["anthropic:claude-cli", "anthropic:api"],
        minimax: ["minimax-portal:minimax-cli"],
      },
    });
  });

  it("skips providers whose lists are entirely empty or non-string", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["anthropic:claude-cli"],
          openai: [],                      // empty — skipped
          google: [null, 123, undefined],  // all non-string — skipped
        },
      },
    });
    expect(result).toEqual({
      order: {
        anthropic: ["anthropic:claude-cli"],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// parseAuthConfig — normalisation
// ---------------------------------------------------------------------------

describe("parseAuthConfig — normalisation", () => {
  it("normalises provider keys to lowercase", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          Anthropic: ["anthropic:claude-cli", "anthropic:api"],
          OPENAI: ["openai-codex", "openai:api"],
          Google: ["google-gemini-cli", "google:default"],
        },
      },
    });
    expect(result?.order).toHaveProperty("anthropic");
    expect(result?.order).toHaveProperty("openai");
    expect(result?.order).toHaveProperty("google");
    expect(result?.order).not.toHaveProperty("Anthropic");
    expect(result?.order).not.toHaveProperty("OPENAI");
    expect(result?.order).not.toHaveProperty("Google");
  });

  it("trims whitespace from profile names", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["  anthropic:claude-cli  ", "anthropic:api"],
        },
      },
    });
    expect(result?.order?.anthropic).toEqual(["anthropic:claude-cli", "anthropic:api"]);
  });

  it("filters out empty-string profiles after trim", () => {
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["anthropic:claude-cli", "  ", "", "anthropic:api"],
        },
      },
    });
    expect(result?.order?.anthropic).toEqual(["anthropic:claude-cli", "anthropic:api"]);
  });

  it("ignores empty string provider keys", () => {
    // Object.entries coerces all keys to strings; empty-string keys can appear from JSON.parse edge cases.
    // parseAuthConfig trims and skips any provider key whose trimmed value is empty.
    const result = parseAuthConfig({
      auth: {
        order: {
          anthropic: ["anthropic:claude-cli"],
          "": ["openai-codex"],            // empty provider key — should be skipped
        },
      },
    });
    // Non-empty provider keys are preserved
    expect(result?.order?.anthropic).toEqual(["anthropic:claude-cli"]);
    // Empty-string provider key is dropped by parseAuthConfig
    expect(Object.keys(result?.order ?? {})).not.toContain("");
  });
});

// ---------------------------------------------------------------------------
// OAuth detection — exercises the shared hasOAuthProfiles utility
// imported from utils/auth.ts (same function used by init-databases.ts).
// ---------------------------------------------------------------------------

describe("OAuth profile detection logic", () => {

  it("returns false for undefined order", () => {
    expect(hasOAuthProfiles(undefined, "anthropic")).toBe(false);
  });

  it("returns false for empty order", () => {
    expect(hasOAuthProfiles([], "anthropic")).toBe(false);
  });

  it("returns false when only API-key profile is configured (anthropic:api)", () => {
    expect(hasOAuthProfiles(["anthropic:api"], "anthropic")).toBe(false);
  });

  it("returns false when only default profile is configured (google:default)", () => {
    expect(hasOAuthProfiles(["google:default"], "google")).toBe(false);
  });

  it("returns false when only API key profiles are configured", () => {
    expect(hasOAuthProfiles(["openai:api", "openai:default"], "openai")).toBe(false);
  });

  it("returns true when at least one OAuth profile is present (anthropic:claude-cli)", () => {
    expect(hasOAuthProfiles(["anthropic:claude-cli", "anthropic:api"], "anthropic")).toBe(true);
  });

  it("returns true when at least one OAuth profile is present (openai-codex)", () => {
    expect(hasOAuthProfiles(["openai-codex", "openai:api"], "openai")).toBe(true);
  });

  it("returns true when at least one OAuth profile is present (google-gemini-cli)", () => {
    expect(hasOAuthProfiles(["google-gemini-cli", "google:default"], "google")).toBe(true);
  });

  it("returns true for github-copilot token profile", () => {
    expect(hasOAuthProfiles(["github-copilot"], "openai")).toBe(true);
  });

  it("returns true for minimax OAuth profile", () => {
    expect(hasOAuthProfiles(["minimax-portal:minimax-cli", "minimax:api"], "minimax")).toBe(true);
  });

  it("returns true when OAuth profile is listed first (OAuth-first ordering)", () => {
    // Verify the intended order: OAuth profile first, API key as fallback
    const order = ["anthropic:claude-cli", "anthropic:api"];
    expect(hasOAuthProfiles(order, "anthropic")).toBe(true);
    expect(order[0]).toBe("anthropic:claude-cli"); // OAuth is first
    expect(order[1]).toBe("anthropic:api");         // API key is fallback
  });
});
