import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { PLUGIN_ID } from "../../utils/constants.js";
import { npxExecutable } from "./workspace.js";

export const MANUAL_UPGRADE_DOC_URL =
  "https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/UPGRADE-PLUGIN.md#manual-upgrade-copy-from-repo";

export type PluginConfigSchemaValidation = {
  ok: boolean;
  errors: string[];
};

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
};

function schemaAllowsAdditionalProperties(schema: JsonSchemaNode | undefined): boolean {
  if (!schema) return true;
  return schema.additionalProperties !== false;
}

/** Lightweight JSON-schema check for unknown keys (matches OpenClaw gateway rejection). */
export function validatePluginConfigAgainstSchema(
  config: unknown,
  rootSchema: JsonSchemaNode | undefined,
  pathPrefix = "",
): PluginConfigSchemaValidation {
  const errors: string[] = [];
  if (config === null || config === undefined) {
    return { ok: true, errors };
  }
  if (!rootSchema) return { ok: true, errors };

  const types = Array.isArray(rootSchema.type) ? rootSchema.type : rootSchema.type ? [rootSchema.type] : [];
  const isObject = types.length === 0 || types.includes("object");
  if (isObject && typeof config === "object" && !Array.isArray(config)) {
    const record = config as Record<string, unknown>;
    const props = rootSchema.properties ?? {};
    const allowExtra = schemaAllowsAdditionalProperties(rootSchema);
    for (const key of Object.keys(record)) {
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (!(key in props)) {
        if (!allowExtra) {
          errors.push(`${pathPrefix || "config"}: must not have additional properties: "${key}"`);
        }
        continue;
      }
      const nested = validatePluginConfigAgainstSchema(record[key], props[key], childPath);
      errors.push(...nested.errors);
    }
    return { ok: errors.length === 0, errors };
  }

  if (rootSchema.items && Array.isArray(config)) {
    for (let i = 0; i < config.length; i++) {
      const nested = validatePluginConfigAgainstSchema(config[i], rootSchema.items, `${pathPrefix}[${i}]`);
      errors.push(...nested.errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function loadPluginManifestSchema(manifestPath: string): JsonSchemaNode | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { configSchema?: JsonSchemaNode };
    return manifest.configSchema;
  } catch {
    return undefined;
  }
}

export function readHybridMemPluginConfigFromOpenclawJson(
  openclawJsonPath = join(homedir(), ".openclaw", "openclaw.json"),
): unknown {
  if (!existsSync(openclawJsonPath)) return undefined;
  try {
    const root = JSON.parse(readFileSync(openclawJsonPath, "utf-8")) as {
      plugins?: { entries?: Record<string, { config?: unknown }> };
    };
    return root.plugins?.entries?.[PLUGIN_ID]?.config;
  } catch {
    return undefined;
  }
}

export type UpgradeConfigPreflightResult = {
  currentValid: boolean;
  targetValid: boolean;
  currentErrors: string[];
  targetErrors: string[];
  canProceedWithUpgrade: boolean;
  message?: string;
};

function extractManifestFromNpmPack(version: string): { manifestPath: string; cleanup: () => void } | undefined {
  const tmpDir = mkdtempSync(join(tmpdir(), "mh-upgrade-preflight-"));
  const pack = spawnSync("npm", ["pack", `${PLUGIN_ID}@${version}`], {
    cwd: tmpDir,
    encoding: "utf-8",
    shell: false,
  });
  if (pack.status !== 0) return undefined;
  const tgz = readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) return undefined;
  const extractDir = join(tmpDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", join(tmpDir, tgz), "-C", extractDir, "--strip-components=1"], {
    shell: false,
  });
  if (tar.status !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    return undefined;
  }
  const manifestPath = join(extractDir, "openclaw.plugin.json");
  if (!existsSync(manifestPath)) {
    rmSync(tmpDir, { recursive: true, force: true });
    return undefined;
  }
  return {
    manifestPath,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Compare installed vs target plugin schema against live openclaw.json plugin config (#2000). */
export function preflightUpgradePluginConfig(opts: {
  installedPluginDir: string;
  targetVersion: string;
  pluginConfig?: unknown;
}): UpgradeConfigPreflightResult {
  const pluginConfig = opts.pluginConfig ?? readHybridMemPluginConfigFromOpenclawJson();
  const currentSchema = loadPluginManifestSchema(join(opts.installedPluginDir, "openclaw.plugin.json"));
  const current = validatePluginConfigAgainstSchema(pluginConfig, currentSchema);

  const packed = extractManifestFromNpmPack(opts.targetVersion);
  if (!packed) {
    return {
      currentValid: current.ok,
      targetValid: false,
      currentErrors: current.errors,
      targetErrors: ["Could not fetch target plugin manifest for preflight"],
      canProceedWithUpgrade: current.ok,
      message: current.ok
        ? undefined
        : `Config fails current plugin schema. Could not verify target schema; use manual upgrade: npx -y openclaw-hybrid-memory-install ${opts.targetVersion}. See ${MANUAL_UPGRADE_DOC_URL}`,
    };
  }
  try {
    const targetSchema = loadPluginManifestSchema(packed.manifestPath);
    const target = validatePluginConfigAgainstSchema(pluginConfig, targetSchema);
    const canProceed = current.ok || target.ok;
    let message: string | undefined;
    if (!current.ok && target.ok) {
      message = `Config rejected by installed plugin schema but accepted by ${opts.targetVersion}; proceeding with upgrade.`;
    } else if (!current.ok && !target.ok) {
      message = `Config fails both installed and target (${opts.targetVersion}) plugin schemas. Manual upgrade may still be required after fixing config. See ${MANUAL_UPGRADE_DOC_URL}`;
    }
    return {
      currentValid: current.ok,
      targetValid: target.ok,
      currentErrors: current.errors,
      targetErrors: target.errors,
      canProceedWithUpgrade: canProceed,
      message,
    };
  } finally {
    packed.cleanup();
  }
}

export function formatManualUpgradeFallback(version: string): string {
  return `When openclaw hybrid-mem is unavailable (invalid plugin config), run: npx -y openclaw-hybrid-memory-install ${version}. See ${MANUAL_UPGRADE_DOC_URL}`;
}

export function runStandaloneUpgradeInstall(version: string, extensionsParentDir: string): { ok: boolean; error?: string } {
  const r = spawnSync(npxExecutable(), ["-y", "openclaw-hybrid-memory-install", version], {
    stdio: "inherit",
    cwd: homedir(),
    shell: false,
    env: { ...process.env, OPENCLAW_EXTENSIONS_DIR: extensionsParentDir },
  });
  if (r.status !== 0) {
    return {
      ok: false,
      error: `Standalone install failed (exit ${r.status ?? "unknown"}). ${formatManualUpgradeFallback(version)}`,
    };
  }
  return { ok: true };
}
