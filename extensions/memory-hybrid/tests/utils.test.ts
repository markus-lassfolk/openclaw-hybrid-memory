import { describe, it, expect } from "vitest";
import { _testing } from "../index.js";

const {
  normalizeTextForDedupe,
  normalizedHash,
  extractTags,
  serializeTags,
  parseTags,
  tagsContains,
  parseSourceDate,
  estimateTokens,
  estimateTokensForDisplay,
  classifyDecay,
  calculateExpiry,
  extractStructuredFields,
  detectCategory,
  detectCredentialPatterns,
  extractCredentialMatch,
  isCredentialLike,
  inferServiceFromText,
  isStructuredForConsolidation,
  normalizeSuggestedLabel,
  unionFind,
  getRoot,
} = _testing;

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

describe("normalizeTextForDedupe", () => {
  it("trims and lowercases", () => {
    expect(normalizeTextForDedupe("  Hello World  ")).toBe("hello world");
  });

  it("collapses multiple whitespace", () => {
    expect(normalizeTextForDedupe("a   b\t\nc")).toBe("a b c");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTextForDedupe("")).toBe("");
  });
});

describe("normalizedHash", () => {
  it("returns consistent hex hash", () => {
    const h1 = normalizedHash("Hello World");
    const h2 = normalizedHash("  hello   world  ");
    expect(h1).toBe(h2);
  });

  it("different text produces different hash", () => {
    expect(normalizedHash("alpha")).not.toBe(normalizedHash("beta"));
  });

  it("is a 64-character hex string (SHA-256)", () => {
    expect(normalizedHash("test")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Tag extraction & serialization
// ---------------------------------------------------------------------------

describe("extractTags", () => {
  it("detects nibe in text", () => {
    expect(extractTags("The Nibe S1255 heat pump")).toContain("nibe");
  });

  it("detects zigbee", () => {
    expect(extractTags("Zigbee coordinator setup")).toContain("zigbee");
  });

  it("detects z-wave with or without hyphen", () => {
    expect(extractTags("Z-Wave mesh network")).toContain("z-wave");
    expect(extractTags("zwave stick")).toContain("z-wave");
  });

  it("detects auth patterns", () => {
    expect(extractTags("Authentication flow")).toContain("auth");
    expect(extractTags("authorization token")).toContain("auth");
  });

  it("detects home assistant", () => {
    expect(extractTags("Home Assistant integration")).toContain("homeassistant");
  });

  it("includes entity in tag search", () => {
    expect(extractTags("some text", "nibe")).toContain("nibe");
  });

  it("returns empty for no matches", () => {
    expect(extractTags("plain generic text")).toEqual([]);
  });

  it("deduplicates tags", () => {
    const tags = extractTags("nibe Nibe NIBE");
    const nibeCount = tags.filter((t) => t === "nibe").length;
    expect(nibeCount).toBe(1);
  });

  it("detects multiple tags from one text", () => {
    const tags = extractTags("Nibe heat pump with Zigbee sensors via Home Assistant");
    expect(tags).toContain("nibe");
    expect(tags).toContain("zigbee");
    expect(tags).toContain("homeassistant");
  });
});

describe("serializeTags", () => {
  it("joins tags with comma", () => {
    expect(serializeTags(["nibe", "zigbee"])).toBe("nibe,zigbee");
  });

  it("returns null for empty array", () => {
    expect(serializeTags([])).toBeNull();
  });
});

describe("parseTags", () => {
  it("splits comma-separated string", () => {
    expect(parseTags("nibe,zigbee,auth")).toEqual(["nibe", "zigbee", "auth"]);
  });

  it("trims and lowercases", () => {
    expect(parseTags(" Nibe , ZigBee ")).toEqual(["nibe", "zigbee"]);
  });

  it("returns empty for null", () => {
    expect(parseTags(null)).toEqual([]);
  });

  it("returns empty for undefined", () => {
    expect(parseTags(undefined)).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(parseTags("")).toEqual([]);
  });

  it("filters out empty segments", () => {
    expect(parseTags("nibe,,,,zigbee")).toEqual(["nibe", "zigbee"]);
  });
});

describe("tagsContains", () => {
  it("finds tag in comma-separated string", () => {
    expect(tagsContains("nibe,zigbee,auth", "zigbee")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(tagsContains("Nibe,Zigbee", "nibe")).toBe(true);
  });

  it("returns false for missing tag", () => {
    expect(tagsContains("nibe,zigbee", "docker")).toBe(false);
  });

  it("returns false for null/empty", () => {
    expect(tagsContains(null, "nibe")).toBe(false);
    expect(tagsContains("", "nibe")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSourceDate
// ---------------------------------------------------------------------------

describe("parseSourceDate", () => {
  it("parses ISO date string (YYYY-MM-DD) as UTC midnight", () => {
    const result = parseSourceDate("2025-06-15");
    expect(result).toBe(Math.floor(Date.UTC(2025, 5, 15) / 1000));
  });

  it("parses ISO datetime string", () => {
    const result = parseSourceDate("2025-06-15T12:00:00");
    expect(result).toBe(Math.floor(Date.UTC(2025, 5, 15) / 1000));
  });

  it("passes through positive unix timestamps", () => {
    expect(parseSourceDate(1700000000)).toBe(1700000000);
  });

  it("returns null for zero", () => {
    expect(parseSourceDate(0)).toBeNull();
  });

  it("returns null for negative", () => {
    expect(parseSourceDate(-100)).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseSourceDate(null)).toBeNull();
    expect(parseSourceDate(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSourceDate("")).toBeNull();
  });

  it("parses numeric string as unix timestamp", () => {
    expect(parseSourceDate("1700000000")).toBe(1700000000);
  });

  it("returns null for garbage string", () => {
    expect(parseSourceDate("not-a-date")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns roughly length/4", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("rounds up", () => {
    expect(estimateTokens("abc")).toBe(1);
  });

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateTokensForDisplay", () => {
  it("returns 0 for empty or whitespace", () => {
    expect(estimateTokensForDisplay("")).toBe(0);
    expect(estimateTokensForDisplay("   ")).toBe(0);
  });

  it("counts short words as at least 1 token each", () => {
    expect(estimateTokensForDisplay("I am")).toBe(2);
    expect(estimateTokensForDisplay("a")).toBe(1);
  });

  it("gives higher count for long words than length/4", () => {
    const long = "internationalization";
    expect(estimateTokensForDisplay(long)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Decay classification
// ---------------------------------------------------------------------------

describe("classifyDecay", () => {
  it("returns permanent for known permanent keys", () => {
    expect(classifyDecay(null, "name", null, "")).toBe("permanent");
    expect(classifyDecay(null, "email", null, "")).toBe("permanent");
    expect(classifyDecay(null, "api_key", null, "")).toBe("permanent");
  });

  it("returns permanent for decision/convention entities", () => {
    expect(classifyDecay("decision", null, null, "")).toBe("permanent");
    expect(classifyDecay("convention", null, null, "")).toBe("permanent");
  });

  it("returns permanent for decision-like text", () => {
    expect(classifyDecay(null, null, null, "decided to use Vitest")).toBe("permanent");
    expect(classifyDecay(null, null, null, "architecture choice")).toBe("permanent");
    expect(classifyDecay(null, null, null, "always use TypeScript")).toBe("permanent");
  });

  it("returns session for session-like keys", () => {
    expect(classifyDecay(null, "current_file", null, "")).toBe("session");
    expect(classifyDecay(null, "temp_variable", null, "")).toBe("session");
  });

  it("returns session for session-like text", () => {
    expect(classifyDecay(null, null, null, "currently debugging the auth module")).toBe("session");
    expect(classifyDecay(null, null, null, "right now working on tests")).toBe("session");
  });

  it("returns active for task/wip keys", () => {
    expect(classifyDecay(null, "task", null, "")).toBe("active");
    expect(classifyDecay(null, "wip_feature", null, "")).toBe("active");
    expect(classifyDecay(null, "sprint_goal", null, "")).toBe("active");
  });

  it("returns active for task-like text", () => {
    expect(classifyDecay(null, null, null, "working on memory tests")).toBe("active");
    expect(classifyDecay(null, null, null, "todo: fix the prune logic")).toBe("active");
  });

  it("returns checkpoint for checkpoint keys", () => {
    expect(classifyDecay(null, "checkpoint_v1", null, "")).toBe("checkpoint");
    expect(classifyDecay(null, "preflight_check", null, "")).toBe("checkpoint");
  });

  it("defaults to stable when no patterns match", () => {
    expect(classifyDecay(null, null, null, "general information")).toBe("stable");
    expect(classifyDecay("user", "color", "blue", "user likes blue")).toBe("stable");
  });
});

describe("calculateExpiry", () => {
  it("returns null for permanent class", () => {
    expect(calculateExpiry("permanent")).toBeNull();
  });

  it("returns fromTimestamp + TTL for non-permanent", () => {
    const base = 1000000;
    const result = calculateExpiry("stable", base);
    expect(result).toBe(base + 90 * 24 * 3600);
  });

  it("returns fromTimestamp + TTL for session", () => {
    const base = 1000000;
    expect(calculateExpiry("session", base)).toBe(base + 24 * 3600);
  });
});

// ---------------------------------------------------------------------------
// Structured field extraction
// ---------------------------------------------------------------------------

describe("extractStructuredFields", () => {
  it("extracts decision with rationale", () => {
    const result = extractStructuredFields(
      "decided to use Vitest because it has native ESM support",
      "decision",
    );
    expect(result.entity).toBe("decision");
    expect(result.key).toContain("Vitest");
    expect(result.value).toContain("ESM");
  });

  it("extracts choice (X over Y)", () => {
    const result = extractStructuredFields(
      "prefer Vitest over Jest because of speed",
      "preference",
    );
    expect(result.entity).toBe("decision");
    expect(result.key).toContain("over");
  });

  it("extracts rule (always/never)", () => {
    const result = extractStructuredFields(
      "always use strict TypeScript",
      "preference",
    );
    expect(result.entity).toBe("convention");
    expect(result.value).toBe("always");
  });

  it("extracts possessive (my X is Y)", () => {
    const result = extractStructuredFields(
      "My favorite color is blue",
      "preference",
    );
    expect(result.entity).toBe("user");
    expect(result.key).toBe("favorite color");
    expect(result.value).toBe("blue");
  });

  it("extracts preference (I prefer X)", () => {
    const result = extractStructuredFields(
      "I prefer dark mode",
      "preference",
    );
    expect(result.entity).toBe("user");
    expect(result.key).toBe("prefer");
    expect(result.value).toBe("dark mode");
  });

  it("extracts email", () => {
    const result = extractStructuredFields(
      "Contact me at john@example.com",
      "entity",
    );
    expect(result.key).toBe("email");
    expect(result.value).toBe("john@example.com");
  });

  it("extracts phone number", () => {
    const result = extractStructuredFields(
      "Call me at +1234567890123",
      "entity",
    );
    expect(result.key).toBe("phone");
    expect(result.value).toBe("+1234567890123");
  });

  it("returns nulls for unstructured text", () => {
    const result = extractStructuredFields(
      "The weather is nice today",
      "fact",
    );
    expect(result.entity).toBeNull();
    expect(result.key).toBeNull();
    expect(result.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectCategory
// ---------------------------------------------------------------------------

describe("detectCategory", () => {
  it("detects decisions", () => {
    expect(detectCategory("decided to use Vitest")).toBe("decision");
    expect(detectCategory("chose TypeScript over JavaScript")).toBe("decision");
    expect(detectCategory("always use ESLint")).toBe("decision");
  });

  it("detects preferences", () => {
    expect(detectCategory("I prefer dark mode")).toBe("preference");
    expect(detectCategory("I love coding")).toBe("preference");
    expect(detectCategory("I hate bugs")).toBe("preference");
  });

  it("detects entities", () => {
    expect(detectCategory("Email is john@example.com")).toBe("entity");
    expect(detectCategory("Phone +1234567890")).toBe("entity");
  });

  it("detects facts", () => {
    expect(detectCategory("born in 1990")).toBe("fact");
    expect(detectCategory("lives in Stockholm")).toBe("fact");
    expect(detectCategory("works at OpenClaw")).toBe("fact");
  });

  it("defaults to other", () => {
    expect(detectCategory("random text xyz")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Credential detection
// ---------------------------------------------------------------------------

describe("detectCredentialPatterns", () => {
  it("detects OpenAI-style API keys", () => {
    const results = detectCredentialPatterns("My key is sk-1234567890abcdefghijklmn");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("api_key");
  });

  it("detects GitHub PAT", () => {
    const results = detectCredentialPatterns("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].hint).toContain("GitHub");
  });

  it("detects Slack tokens", () => {
    const results = detectCredentialPatterns("xoxb-1234567890-abcdef");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].hint).toContain("Slack");
  });

  it("returns empty for no credentials", () => {
    expect(detectCredentialPatterns("nothing special here")).toEqual([]);
  });
});

describe("isCredentialLike", () => {
  it("returns true for entity = credentials", () => {
    expect(isCredentialLike("some text", "Credentials", null, null)).toBe(true);
  });

  it("returns true for api_key key", () => {
    expect(isCredentialLike("text", null, "api_key", null)).toBe(true);
  });

  it("returns true for long value starting with sk-", () => {
    expect(isCredentialLike("text", null, null, "sk-abcdef123456")).toBe(true);
  });

  it("returns true for sensitive pattern in text", () => {
    expect(isCredentialLike("my password is secret123")).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isCredentialLike("the weather is nice")).toBe(false);
  });
});

describe("inferServiceFromText", () => {
  it("infers github", () => {
    expect(inferServiceFromText("ghp_abc123 for GitHub")).toBe("github");
  });

  it("infers openai", () => {
    expect(inferServiceFromText("sk-proj-abc for OpenAI")).toBe("openai");
  });

  it("infers slack", () => {
    expect(inferServiceFromText("xoxb-token for Slack")).toBe("slack");
  });

  it("infers home-assistant", () => {
    expect(inferServiceFromText("HA token for Home Assistant")).toBe("home-assistant");
  });

  it("defaults to imported", () => {
    expect(inferServiceFromText("random text")).toBe("imported");
  });
});

// ---------------------------------------------------------------------------
// isStructuredForConsolidation
// ---------------------------------------------------------------------------

describe("isStructuredForConsolidation", () => {
  it("returns true for IP address", () => {
    expect(isStructuredForConsolidation("Server at 192.168.1.1", null, null)).toBe(true);
  });

  it("returns true for email", () => {
    expect(isStructuredForConsolidation("john@example.com", null, null)).toBe(true);
  });

  it("returns true for phone-like number", () => {
    expect(isStructuredForConsolidation("+1234567890123", null, null)).toBe(true);
  });

  it("returns true for UUID", () => {
    expect(isStructuredForConsolidation("id: 550e8400-e29b-41d4-a716-446655440000", null, null)).toBe(true);
  });

  it("returns true for sensitive key names", () => {
    expect(isStructuredForConsolidation("value", null, "email")).toBe(true);
    expect(isStructuredForConsolidation("value", null, "api_key")).toBe(true);
    expect(isStructuredForConsolidation("value", "password", null)).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isStructuredForConsolidation("User prefers dark mode", "user", "preference")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

describe("unionFind / getRoot", () => {
  it("groups connected nodes into same root", () => {
    const parent = unionFind(["a", "b", "c"], [["a", "b"]]);
    expect(getRoot(parent, "a")).toBe(getRoot(parent, "b"));
  });

  it("keeps disconnected nodes separate", () => {
    const parent = unionFind(["a", "b", "c"], [["a", "b"]]);
    expect(getRoot(parent, "c")).not.toBe(getRoot(parent, "a"));
  });

  it("handles transitive edges", () => {
    const parent = unionFind(
      ["a", "b", "c"],
      [["a", "b"], ["b", "c"]],
    );
    expect(getRoot(parent, "a")).toBe(getRoot(parent, "c"));
  });

  it("handles empty edges", () => {
    const parent = unionFind(["a", "b"], []);
    expect(getRoot(parent, "a")).toBe("a");
    expect(getRoot(parent, "b")).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// normalizeSuggestedLabel
// ---------------------------------------------------------------------------

describe("normalizeSuggestedLabel", () => {
  it("trims and lowercases", () => {
    expect(normalizeSuggestedLabel("  Workflow  ")).toBe("workflow");
  });

  it("replaces spaces with underscores", () => {
    expect(normalizeSuggestedLabel("home automation")).toBe("home_automation");
  });

  it("keeps existing underscores", () => {
    expect(normalizeSuggestedLabel("home_automation")).toBe("home_automation");
  });

  it("replaces non-alphanumeric (except _ and -) with underscore", () => {
    expect(normalizeSuggestedLabel("test!@#$%label")).toBe("test_label");
  });

  it("collapses multiple underscores", () => {
    expect(normalizeSuggestedLabel("a___b____c")).toBe("a_b_c");
  });

  it("preserves hyphens", () => {
    expect(normalizeSuggestedLabel("a-b-c")).toBe("a-b-c");
  });

  it("returns empty for 'other'", () => {
    expect(normalizeSuggestedLabel("other")).toBe("");
  });

  it("returns empty for labels over 40 chars", () => {
    expect(normalizeSuggestedLabel("a".repeat(41))).toBe("");
  });
});
