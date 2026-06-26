import { describe, expect, it } from "vitest";
import { stripInvalidOpenClawCoreKeys } from "../cli/install/config-merge.js";
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

  it("pins compaction to a cheap mini model by default", () => {
    const defaults = buildInstallDefaults() as {
      agents?: {
        defaults?: {
          compaction?: Record<string, unknown>;
        };
      };
    };
    expect(defaults.agents?.defaults?.compaction?.model).toBe("minimax/MiniMax-M2.7");
  });

  it("does not write OpenClaw-invalid flushEveryCompaction into memoryFlush", () => {
    const defaults = buildInstallDefaults() as {
      agents?: {
        defaults?: {
          compaction?: {
            memoryFlush?: Record<string, unknown>;
          };
        };
      };
    };
    expect(defaults.agents?.defaults?.compaction?.memoryFlush).not.toHaveProperty("flushEveryCompaction");
  });
});

describe("stripInvalidOpenClawCoreKeys", () => {
  it("removes flushEveryCompaction from existing configs", () => {
    const config = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              enabled: true,
              flushEveryCompaction: true,
            },
          },
        },
      },
    };
    expect(stripInvalidOpenClawCoreKeys(config)).toBe(true);
    expect(config.agents.defaults.compaction.memoryFlush).not.toHaveProperty("flushEveryCompaction");
    expect(config.agents.defaults.compaction.memoryFlush.enabled).toBe(true);
  });

  it("returns false when no invalid keys are present", () => {
    const config = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: { enabled: true },
          },
        },
      },
    };
    expect(stripInvalidOpenClawCoreKeys(config)).toBe(false);
  });
});
