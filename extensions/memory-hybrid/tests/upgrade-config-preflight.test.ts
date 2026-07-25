import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  loadPluginManifestSchema,
  validatePluginConfigAgainstSchema,
} from "../cli/install/upgrade-config-preflight.js";
import { parseDreamingConfig } from "../config/parsers/dreaming.js";
import { hybridConfigSchema } from "../config.js";
import { pluginLogger } from "../utils/logger.js";

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

  it("accepts and losslessly maps the legacy dreaming fixture that previously blocked gateway boot", () => {
    const legacy = JSON.parse(
      readFileSync(join(hybridRoot, "tests", "fixtures", "legacy-dreaming-config.json"), "utf8"),
    ) as Record<string, unknown>;
    const schema = loadPluginManifestSchema(manifestPath);
    expect(validatePluginConfigAgainstSchema(legacy, schema)).toEqual({ ok: true, errors: [] });

    const parsed = hybridConfigSchema.parse(legacy);
    expect(parsed.nightlyCycle.schedule).toBe("15 3 * * *");
    expect(parsed.nightlyCycle.model).toBe("azure-foundry/gpt-4.1-mini");
    expect(parsed.dreaming.compose).toEqual(["distill", "reflect", "consolidate"]);
  });

  it("accepts unmappable legacy dreaming keys and emits actionable migration warning", () => {
    const legacy = JSON.parse(
      readFileSync(join(hybridRoot, "tests", "fixtures", "legacy-dreaming-config.json"), "utf8"),
    ) as Record<string, unknown>;
    const schema = loadPluginManifestSchema(manifestPath);
    expect(validatePluginConfigAgainstSchema(legacy, schema)).toEqual({ ok: true, errors: [] });

    const warn = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    try {
      expect(() => parseDreamingConfig(legacy)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("execution, phases, verboseLogging"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("No lossless runtime mapping exists for"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("AUTONOMOUS-DREAMING.md#legacy-config-compatibility"));
    } finally {
      warn.mockRestore();
    }
  });

  it("declares legacy execution and verboseLogging types in the manifest", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      configSchema?: { properties?: { dreaming?: { properties?: Record<string, { type?: string }> } } };
    };
    const properties = manifest.configSchema?.properties?.dreaming?.properties;
    expect(properties?.execution?.type).toBe("string");
    expect(properties?.verboseLogging?.type).toBe("boolean");
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
