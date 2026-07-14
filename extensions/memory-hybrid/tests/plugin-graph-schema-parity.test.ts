import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GRAPH_CONFIG_INPUT_KEYS } from "../config/graph-config-schema-keys.js";

const hybridRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(hybridRoot, "openclaw.plugin.json");

type PluginManifest = {
  configSchema?: {
    properties?: {
      graph?: {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      };
    };
  };
  uiHints?: Record<string, unknown>;
};

function loadManifest(): PluginManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
}

/** Maeve-style graph block that previously crashed gateway config validation (#1997). */
const MAEVE_GRAPH_SAMPLE = {
  enabled: true,
  autoLink: true,
  autoLinkStrength: 0.7,
  autoLinkSimilarityThreshold: 0.7,
  autoLinkLimit: 3,
  maxTraversalDepth: 2,
  useInRecall: true,
  coOccurrenceWeight: 0.3,
  autoSupersede: true,
  strengthenOnRecall: false,
  hubDegreeCap: 500,
  hubScorePenalty: null,
} as const;

describe("plugin graph config schema parity", () => {
  it("openclaw.plugin.json graph.properties includes every parseGraphConfig input key", () => {
    const manifest = loadManifest();
    const graphSchema = manifest.configSchema?.properties?.graph;
    expect(graphSchema?.additionalProperties).toBe(false);

    const schemaKeys = new Set(Object.keys(graphSchema?.properties ?? {}));
    const missing = GRAPH_CONFIG_INPUT_KEYS.filter((key) => !schemaKeys.has(key));
    expect(missing, `add to openclaw.plugin.json graph.properties: ${missing.join(", ")}`).toEqual([]);
  });

  it("Maeve-style graph config keys are all declared (no additionalProperties rejection)", () => {
    const manifest = loadManifest();
    const schemaKeys = new Set(Object.keys(manifest.configSchema?.properties?.graph?.properties ?? {}));
    const unknown = Object.keys(MAEVE_GRAPH_SAMPLE).filter((key) => !schemaKeys.has(key));
    expect(unknown, `unknown graph keys would fail gateway validation: ${unknown.join(", ")}`).toEqual([]);
  });

  it("uiHints cover graph config keys shown in settings UI", () => {
    const manifest = loadManifest();
    const uiHints = manifest.uiHints ?? {};
    const labelKeys = ["graph.coOccurrenceWeight", "graph.autoSupersede", "graph.hubScorePenalty"] as const;
    for (const key of labelKeys) {
      expect(uiHints[key], `missing uiHints.${key}`).toBeDefined();
    }
  });
});
