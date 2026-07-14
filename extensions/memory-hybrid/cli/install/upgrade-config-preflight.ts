import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { PLUGIN_ID } from "../../utils/constants.js";
import { npxExecutable, NPM_INSTALL_TIMEOUT_MS } from "./workspace.js";

export const MANUAL_UPGRADE_DOC_URL =
  "https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/UPGRADE-PLUGIN.md#manual-upgrade-copy-from-repo";

/**
 * Standalone upgrade when OpenClaw cannot load hybrid-mem (schema drift / invalid config).
 *
 * Uses the published `openclaw-hybrid-memory-install` package (source:
 * `packages/openclaw-hybrid-memory-install`). It npm-packs the target version into
 * `OPENCLAW_EXTENSIONS_DIR/openclaw-hybrid-memory` (default `~/.openclaw/extensions`),
 * which is exactly the extensions-canonical tree the gateway loads. The previously
 * referenced `openclaw-hybrid-mem-upgrade` package was never published to npm (404),
 * so `hybrid-mem upgrade` and every "manual upgrade" fallback message pointed at a
 * command that could not run (#2021).
 */
export const STANDALONE_UPGRADE_PACKAGE = "openclaw-hybrid-memory-install";
export const STANDALONE_UPGRADE_CMD = `npx -y ${STANDALONE_UPGRADE_PACKAGE}`;

export const NPM_PACK_PREFLIGHT_TIMEOUT_MS = 120_000;

export type PluginConfigSchemaValidation = {
  ok: boolean;
  errors: string[];
};

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
};

function schemaAllowsAdditionalProperties(schema: JsonSchemaNode | undefined): boolean {
  if (!schema) return true;
  return schema.additionalProperties !== false;
}

/**
 * Lightweight JSON-schema check focused on OpenClaw gateway rejection patterns:
 * unknown keys (additionalProperties) and missing required properties.
 */
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
    const required = rootSchema.required ?? [];
    for (const key of required) {
      if (!(key in record)) {
        const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        errors.push(`${childPath}: missing required property "${key}"`);
      }
    }
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
  targetSchemaVerified: boolean;
  currentErrors: string[];
  targetErrors: string[];
  canProceedWithUpgrade: boolean;
  message?: string;
};

/** Pure decision logic for upgrade preflight (testable without npm pack). */
export function evaluateUpgradeConfigPreflight(opts: {
  current: PluginConfigSchemaValidation;
  target: PluginConfigSchemaValidation;
  targetSchemaVerified: boolean;
  targetVersion: string;
}): Pick<UpgradeConfigPreflightResult, "canProceedWithUpgrade" | "message"> {
  const { current, target, targetSchemaVerified, targetVersion } = opts;

  if (!targetSchemaVerified) {
    return {
      canProceedWithUpgrade: current.ok,
      message: current.ok
        ? undefined
        : `Config fails current plugin schema. Could not verify target schema; use manual upgrade: ${STANDALONE_UPGRADE_CMD} ${targetVersion}. See ${MANUAL_UPGRADE_DOC_URL}`,
    };
  }

  const canProceed = target.ok;
  let message: string | undefined;
  if (current.ok && !target.ok) {
    message = `Config accepted by installed plugin but rejected by target (${targetVersion}); refusing upgrade to avoid gateway crash after install. See ${MANUAL_UPGRADE_DOC_URL}`;
  } else if (!current.ok && target.ok) {
    message = `Config rejected by installed plugin schema but accepted by ${targetVersion}; proceeding with upgrade.`;
  } else if (!current.ok && !target.ok) {
    message = `Config fails both installed and target (${targetVersion}) plugin schemas. Fix config or use manual upgrade: ${STANDALONE_UPGRADE_CMD} ${targetVersion}. See ${MANUAL_UPGRADE_DOC_URL}`;
  }
  return { canProceedWithUpgrade: canProceed, message };
}

function extractManifestFromNpmPack(version: string): { manifestPath: string; cleanup: () => void } | undefined {
  const tmpDir = mkdtempSync(join(tmpdir(), "mh-upgrade-preflight-"));
  const pack = spawnSync("npm", ["pack", `${PLUGIN_ID}@${version}`], {
    cwd: tmpDir,
    encoding: "utf-8",
    shell: false,
    timeout: NPM_PACK_PREFLIGHT_TIMEOUT_MS,
  });
  if (pack.status !== 0) return undefined;
  const tgz = readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) return undefined;
  const extractDir = join(tmpDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", join(tmpDir, tgz), "-C", extractDir, "--strip-components=1"], {
    shell: false,
    timeout: NPM_PACK_PREFLIGHT_TIMEOUT_MS,
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
    const decision = evaluateUpgradeConfigPreflight({
      current,
      target: { ok: false, errors: ["Could not fetch target plugin manifest for preflight"] },
      targetSchemaVerified: false,
      targetVersion: opts.targetVersion,
    });
    return {
      currentValid: current.ok,
      targetValid: false,
      targetSchemaVerified: false,
      currentErrors: current.errors,
      targetErrors: ["Could not fetch target plugin manifest for preflight"],
      canProceedWithUpgrade: decision.canProceedWithUpgrade,
      message: decision.message,
    };
  }
  try {
    const targetSchema = loadPluginManifestSchema(packed.manifestPath);
    const target = validatePluginConfigAgainstSchema(pluginConfig, targetSchema);
    const decision = evaluateUpgradeConfigPreflight({
      current,
      target,
      targetSchemaVerified: true,
      targetVersion: opts.targetVersion,
    });
    return {
      currentValid: current.ok,
      targetValid: target.ok,
      targetSchemaVerified: true,
      currentErrors: current.errors,
      targetErrors: target.errors,
      canProceedWithUpgrade: decision.canProceedWithUpgrade,
      message: decision.message,
    };
  } finally {
    packed.cleanup();
  }
}

export function formatManualUpgradeFallback(version: string): string {
  return `When openclaw hybrid-mem is unavailable (invalid plugin config), run: ${STANDALONE_UPGRADE_CMD} ${version}. See ${MANUAL_UPGRADE_DOC_URL}`;
}

export function runStandaloneUpgradeInstall(
  version: string,
  extensionsParentDir: string,
): { ok: boolean; error?: string } {
  const r = spawnSync(npxExecutable(), ["-y", STANDALONE_UPGRADE_PACKAGE, version], {
    stdio: "inherit",
    cwd: homedir(),
    shell: false,
    env: { ...process.env, OPENCLAW_EXTENSIONS_DIR: extensionsParentDir },
    timeout: NPM_INSTALL_TIMEOUT_MS,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      error: `Standalone install failed (exit ${r.status ?? "unknown"}). ${formatManualUpgradeFallback(version)}`,
    };
  }
  return { ok: true };
}
