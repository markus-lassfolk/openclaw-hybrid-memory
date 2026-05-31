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

  it("preserves internal whitespace so surface text remains offset-compatible", () => {
    expect(
      canonicalizeEntityMention({ label: "SERVICE", surfaceText: "Home   Assistant", confidence: 0.9 }),
    ).toMatchObject({
      accepted: true,
      surfaceText: "Home   Assistant",
      normalizedSurface: "home assistant",
    });
  });

  it("reclassifies o-series and gpt-4o model names", () => {
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "gpt-4o",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "gpt-4o" });
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "gpt-4o-mini",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "gpt-4o-mini" });
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "o3",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "o3" });
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "o3-mini",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "o3-mini" });
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "o1-pro",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "o1-pro" });
  });

  it("preserves codex suffixes in GPT model canonicalization", () => {
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "gpt-5-codex",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "gpt-5-codex" });
    expect(
      canonicalizeEntityMention({
        label: "ORG",
        surfaceText: "gpt-5.3-codex",
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: true, label: "MODEL", normalizedSurface: "gpt-5.3-codex" });
  });

  it("does not force non-model o2 mentions into MODEL", () => {
    expect(canonicalizeEntityMention({ label: "ORG", surfaceText: "O2 Arena", confidence: 0.9 })).toMatchObject({
      accepted: true,
      label: "ORG",
      normalizedSurface: "o2 arena",
    });
  });
});
