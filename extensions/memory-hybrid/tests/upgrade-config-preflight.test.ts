import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  loadPluginManifestSchema,
  validatePluginConfigAgainstSchema,
} from "../cli/install/upgrade-config-preflight.js";

const hybridRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(hybridRoot, "openclaw.plugin.json");

/** Maeve-style graph block rejected by older schemas (#1997 / #2000). */
const MAEVE_GRAPH_CONFIG = {
  embedding: {
    provider: "openai",
    apiKey: "sk-test-key-that-is-long-enough-for-validation",
    model: "text-embedding-3-small",
  },
  graph: {
    enabled: true,
    autoLink: true,
    autoLinkStrength: 0.7,
    coOccurrenceWeight: 0.3,
    autoSupersede: true,
    hubScorePenalty: null,
  },
};

describe("upgrade config preflight (#2000)", () => {
  it("validatePluginConfigAgainstSchema accepts Maeve graph keys on current manifest", () => {
    const schema = loadPluginManifestSchema(manifestPath);
    const result = validatePluginConfigAgainstSchema(MAEVE_GRAPH_CONFIG, schema);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validatePluginConfigAgainstSchema rejects unknown graph keys when schema disallows extras", () => {
    const schema = loadPluginManifestSchema(manifestPath);
    const graphSchema = schema?.properties?.graph;
    expect(graphSchema).toBeDefined();
    const legacyGraphSchema = {
      ...graphSchema,
      properties: Object.fromEntries(
        Object.entries(graphSchema?.properties ?? {}).filter(([key]) => key !== "coOccurrenceWeight"),
      ),
    };
    const legacySchema = {
      ...schema,
      properties: {
        ...schema?.properties,
        graph: legacyGraphSchema,
      },
    };
    const result = validatePluginConfigAgainstSchema(MAEVE_GRAPH_CONFIG, legacySchema);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("coOccurrenceWeight"))).toBe(true);
  });

  it("current openclaw.plugin.json includes graph keys from Maeve production config", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      configSchema?: { properties?: { graph?: { properties?: Record<string, unknown> } } };
    };
    const graphKeys = Object.keys(manifest.configSchema?.properties?.graph?.properties ?? {});
    for (const key of ["coOccurrenceWeight", "autoSupersede", "hubScorePenalty", "autoLinkStrength"]) {
      expect(graphKeys, `missing graph.${key} in openclaw.plugin.json`).toContain(key);
    }
  });
});
