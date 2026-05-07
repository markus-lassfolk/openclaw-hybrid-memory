import { describe, expect, it } from "vitest";
import { parseStoreConfig } from "../config/parsers/core.js";
import { resolveDedupeProfile } from "../services/dedupe-policy.js";

describe("store source dedupe profiles", () => {
  it("parses default and per-source profiles", () => {
    const cfg = parseStoreConfig({
      store: {
        fuzzyDedupe: true,
        defaultProfile: { vectorThreshold: 0.95, lexicalJaccard: 0.9, onDuplicate: "skip" },
        sourceProfiles: {
          "implicit-feedback": { lexicalJaccard: 0.8, maxPerDay: 50, onDuplicate: "boost", boostBy: 0.05 },
          "seed:*": { onDuplicate: "store" },
        },
      },
    });

    expect(cfg.defaultProfile?.vectorThreshold).toBe(0.95);
    expect(cfg.sourceProfiles?.["implicit-feedback"]?.maxPerDay).toBe(50);
  });

  it("resolves exact, glob, and fallback profiles", () => {
    const store = parseStoreConfig({
      store: {
        defaultProfile: { vectorThreshold: 0.95, onDuplicate: "skip" },
        sourceProfiles: {
          "implicit-feedback": { lexicalJaccard: 0.8, maxPerDay: 50, onDuplicate: "boost" },
          "seed:*": { onDuplicate: "store" },
        },
      },
    });

    expect(resolveDedupeProfile("implicit-feedback", store)).toMatchObject({
      vectorThreshold: 0.95,
      lexicalJaccard: 0.8,
      maxPerDay: 50,
      onDuplicate: "boost",
    });
    expect(resolveDedupeProfile("seed:initial", store).onDuplicate).toBe("store");
    expect(resolveDedupeProfile("distillation", store)).toMatchObject({ vectorThreshold: 0.95, onDuplicate: "skip" });
  });
});
