import { describe, expect, it } from "vitest";

import { canonicalizeEntityMention } from "../utils/entity-mention-quality.js";

describe("canonicalizeEntityMention", () => {
  it("reclassifies model and service/tool/project names", () => {
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "Gemini 3.1 Pro",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "gemini-3.1-pro" });
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "GitHub",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "SERVICE", normalizedSurface: "github" });
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "gh",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "TOOL", normalizedSurface: "gh" });
  });

  it("rejects low confidence and generic/numeric junk", () => {
    expect(canonicalizeEntityMention({ label: "PERSON", surfaceText: "Markus", confidence: 0.7 })).toMatchObject({
      accepted: false,
      reason: "low_confidence",
    });
    expect(canonicalizeEntityMention({ label: "ORG", surfaceText: "api", confidence: 0.9 })).toMatchObject({
      accepted: false,
      reason: "generic_term",
    });
    expect(canonicalizeEntityMention({ label: "ORG", surfaceText: "1775246301", confidence: 0.9 })).toMatchObject({
      accepted: false,
      reason: "numeric",
    });
  });

  it("keeps acronym allowlist values", () => {
    expect(canonicalizeEntityMention({ label: "ORG", surfaceText: "HA", confidence: 0.9 })).toMatchObject({
      accepted: true,
      label: "SERVICE",
      normalizedSurface: "home assistant",
    });
  });
});
