import { describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { buildInstallDefaults } = _testing;

describe("buildInstallDefaults", () => {
  it("does not pin memorySearch to a fixed provider or model", () => {
    const defaults = buildInstallDefaults() as {
      agents?: {
        defaults?: {
          memorySearch?: Record<string, unknown>;
        };
      };
    };

    expect(defaults.agents?.defaults?.memorySearch).toEqual({
      enabled: true,
      sources: ["memory"],
      sync: { onSessionStart: true, onSearch: true, watch: true },
      chunking: { tokens: 500, overlap: 50 },
      query: { maxResults: 8, minScore: 0.3, hybrid: { enabled: true } },
    });
    expect(defaults.agents?.defaults?.memorySearch).not.toHaveProperty("provider");
    expect(defaults.agents?.defaults?.memorySearch).not.toHaveProperty("model");
  });
});
