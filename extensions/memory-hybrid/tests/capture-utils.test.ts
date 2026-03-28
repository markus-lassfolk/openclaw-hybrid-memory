/**
 * Unit tests for services/capture-utils.ts (Issue #559).
 * Covers all short-circuit paths in shouldCapture and all category branches in detectCategory.
 */

import { describe, it, expect } from "vitest";
import { shouldCapture, detectCategory } from "../services/capture-utils.js";
import {
  getCategoryDecisionRegex,
  getCategoryPreferenceRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
} from "../utils/language-keywords.js";
import { getMemoryTriggers } from "../services/auto-capture.js";

// ---------------------------------------------------------------------------
// shouldCapture
// ---------------------------------------------------------------------------

describe("shouldCapture", () => {
  const MAX_CHARS = 500;
  const TRIGGERS = getMemoryTriggers();

  it("rejects text below minimum length (< 10 chars)", () => {
    expect(shouldCapture("short", MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(shouldCapture("", MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text above captureMaxChars", () => {
    const long = "remember ".repeat(100); // well over 500 chars, contains trigger
    expect(shouldCapture(long, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text containing <relevant-memories>", () => {
    const text = "please remember this <relevant-memories>something</relevant-memories>";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects XML-like text (starts with < and contains </)", () => {
    expect(shouldCapture("<tool_result>I prefer dark mode</tool_result>", MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects markdown-formatted text (contains ** and newline-dash)", () => {
    const text = "**remember this**\n- bullet one\n- bullet two";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects emoji-heavy text (more than 3 emojis)", () => {
    const text = "I remember 🎉 you prefer 🚀 the dark 🌙 side 🦄";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("accepts text with exactly 3 emojis and a trigger", () => {
    const text = "I prefer 🎉 dark 🚀 mode 🌙 always";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("rejects text matching a sensitive pattern (password)", () => {
    const text = "remember that the password is hunter2";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (api key)", () => {
    const text = "remember the api_key for this service";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (secret)", () => {
    const text = "remember the client secret value for this application";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (bearer keyword)", () => {
    const text = "remember the bearer token for the API access here";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (authorization header)", () => {
    const text = "remember the authorization header value for the gateway";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (credentials keyword)", () => {
    const text = "remember the credentials for the home assistant system";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text with no trigger match", () => {
    const text = "this text has no memory trigger at all in it here";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("accepts text that matches a trigger and passes all filters", () => {
    expect(shouldCapture("I prefer dark mode when coding", MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("accepts text matching a second trigger", () => {
    expect(shouldCapture("please remember to use tabs not spaces", MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("accepts text matching 'my name is' trigger", () => {
    expect(shouldCapture("my name is Claude and I like TypeScript", MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("is case-insensitive for trigger match", () => {
    expect(shouldCapture("I PREFER uppercase sometimes", MAX_CHARS, TRIGGERS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectCategory
// ---------------------------------------------------------------------------

describe("detectCategory", () => {
  const decisionRegex = getCategoryDecisionRegex();
  const preferenceRegex = getCategoryPreferenceRegex();
  const entityRegex = getCategoryEntityRegex();
  const factRegex = getCategoryFactRegex();

  it("returns 'decision' for text matching decision keywords", () => {
    expect(
      detectCategory(
        "I decided to use TypeScript for this project",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("decision");
  });

  it("returns 'decision' for 'went with' keyword", () => {
    expect(
      detectCategory("we went with Postgres for the database", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });

  it("returns 'preference' for text matching preference keywords", () => {
    expect(
      detectCategory(
        "I prefer dark mode when working at night",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("preference");
  });

  it("returns 'decision' for 'always use' keyword", () => {
    expect(
      detectCategory("I always use two spaces for indentation", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });

  it("returns 'entity' for text containing a phone-like pattern", () => {
    // +10 digits triggers the phone regex in detectCategory
    expect(
      detectCategory("call me at +12025551234 anytime", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("entity");
  });

  it("returns 'entity' for text with email-like pattern", () => {
    expect(
      detectCategory(
        "reach me at user@example.com for details",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("entity");
  });

  it("returns 'entity' for text matching entity regex", () => {
    expect(
      detectCategory("the project is called Acme Corp", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("entity");
  });

  it("returns 'fact' for text matching fact keywords", () => {
    expect(
      detectCategory("the capital of France is Paris", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("fact");
  });

  it("returns 'fact' for 'has' pattern", () => {
    expect(
      detectCategory(
        "the framework has many features and capabilities",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("fact");
  });

  it("returns 'other' when no category pattern matches", () => {
    expect(
      detectCategory(
        "something entirely generic without keywords",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("other");
  });

  it("decision takes priority over preference when both match", () => {
    expect(
      detectCategory("I decided I prefer tabs over spaces", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });

  it("is case-insensitive (uses lowercased text internally)", () => {
    expect(
      detectCategory("We DECIDED to deploy on Friday", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });
});
