/**
 * Config CLI Handlers
 *
 * Implements the config-related CLI commands: config-view, config-set-help,
 * config-mode, and config-set. Also contains private helpers for reading and
 * writing the plugin's JSON config file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { hybridConfigSchema, PRESET_OVERRIDES, type ConfigMode } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { PLUGIN_ID, getRestartPendingPath } from "../utils/constants.js";
import type { HandlerContext } from "./handlers.js";
import type { ConfigCliResult, VerifyCliSink } from "./types.js";
import { getPluginConfigFromFile } from "./cmd-install.js";

const MAX_DESC_LEN = 280;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Validate config, write to disk, and write restart pending flag
 */
function validateAndWriteConfig(
  config: Record<string, unknown>,
  root: Record<string, unknown>,
  configPath: string,
  operation: string,
): { ok: true } | { ok: false; error: string } {
  try {
    hybridConfigSchema.parse(config);
  } catch (schemaErr: unknown) {
    capturePluginError(schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)), {
      subsystem: "cli",
      operation: "runConfigSetForCli:validation-" + operation,
    });
    return { ok: false, error: `Invalid config value: ${schemaErr}` };
  }
  try {
    writeFileSync(configPath, JSON.stringify(root, null, 2), "utf-8");
    writeFileSync(getRestartPendingPath(), "", "utf-8");
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runConfigSetForCli:write-" + operation });
    return { ok: false, error: `Could not write config: ${e}` };
  }
  return { ok: true };
}

/**
 * Set nested config value
 */
function setNested(obj: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    // Prevent prototype pollution via dangerous path segments
    if (p === "__proto__" || p === "constructor" || p === "prototype") {
      return false;
    }
    if (!(p in cur) || typeof (cur as any)[p] !== "object" || (cur as any)[p] === null) (cur as any)[p] = {};
    cur = (cur as any)[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  // Also prevent setting dangerous keys at the final segment
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    return false;
  }
  const v =
    value === "true" || value === "enabled"
      ? true
      : value === "false" || value === "disabled"
        ? false
        : value === "null"
          ? null
          : /^-?\d+$/.test(String(value))
            ? Number.parseInt(String(value), 10)
            : /^-?\d*\.\d+$/.test(String(value))
              ? Number.parseFloat(String(value))
              : value;
  (cur as any)[last] = v;
  return true;
}

/**
 * Get nested config value
 */
function getNested(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
  return cur;
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

/**
 * Config view — show current settings in a simple, scannable format.
 * Focus on what's on/off so users can understand and change via config-set.
 */
export function runConfigViewForCli(ctx: HandlerContext, sink: VerifyCliSink): void {
  const { cfg } = ctx;
  const log = sink.log;
  const noEmoji = process.env.HYBRID_MEM_NO_EMOJI === "1";
  const ON = noEmoji ? "[on]" : "on";
  const OFF = noEmoji ? "[off]" : "off";
  const on = (b: boolean) => (b ? ON : OFF);

  const modeLabel = cfg.mode && cfg.mode !== "custom" ? cfg.mode.charAt(0).toUpperCase() + cfg.mode.slice(1) : "Custom";
  log("Memory mode: " + modeLabel);
  log("Verbosity: " + (cfg.verbosity ?? "normal"));
  log("");

  log("Core");
  log("  Auto-capture: " + on(cfg.autoCapture));
  log("  Auto-recall: " + on(cfg.autoRecall.enabled));
  log("  Credentials vault: " + on(cfg.credentials.enabled));
  log("  Procedures: " + on(cfg.procedures.enabled));
  log("  Memory tiering: " + on(cfg.memoryTiering.enabled));
  log("  Graph (links between facts): " + on(cfg.graph.enabled));
  log("  Auto-classify: " + on(cfg.autoClassify.enabled));
  log("");

  log("Optional features");
  log("  Nightly dream cycle: " + on(cfg.nightlyCycle?.enabled ?? false));
  log("  Passive observer: " + on(cfg.passiveObserver?.enabled ?? false));
  log("  Reflection (patterns/rules): " + on(cfg.reflection.enabled));
  log("  Persona proposals: " + on(cfg.personaProposals.enabled));
  log("  Self-correction: " + on(!!cfg.selfCorrection));
  log("  Self-extension (tool proposals): " + on(cfg.selfExtension?.enabled ?? false));
  log("  Crystallization (skill proposals): " + on(cfg.crystallization?.enabled ?? false));
  log("  Extraction (multi-pass): " + on(!!cfg.extraction?.extractionPasses));
  log("  Active task (ACTIVE-TASK.md): " + on(cfg.activeTask.enabled));
  log("  Frustration detection: " + on(cfg.frustrationDetection.enabled));
  log("  Cross-agent learning: " + on(cfg.crossAgentLearning.enabled));
  log("  Tool effectiveness: " + on(cfg.toolEffectiveness.enabled));
  log("  Documents (MarkItDown): " + on(cfg.documents.enabled));
  log("  Provenance: " + on(cfg.provenance.enabled));
  log("  Error reporting: " + on(cfg.errorReporting?.enabled ?? false));
  log("  Cost tracking: " + on(cfg.costTracking?.enabled ?? false));
  log("");

  log("Advanced");
  log("  Query expansion: " + on(cfg.queryExpansion.enabled));
  log("  Retrieval directives: " + on(cfg.autoRecall.retrievalDirectives?.enabled ?? false));
  log("  Entity lookup: " + on(cfg.autoRecall.entityLookup.enabled));
  log("");

  log("To change a setting: openclaw hybrid-mem config-set <key> <value>");
  log("Example (toggle): openclaw hybrid-mem config-set nightlyCycle enabled");
  log("Help for a key: openclaw hybrid-mem help config-set <key>");
}

/**
 * Show help for config key
 */
export function runConfigSetHelpForCli(ctx: HandlerContext, key: string): ConfigCliResult {
  const k = key.trim();
  if (!k) return { ok: false, error: "Key is required (e.g. autoCapture, credentials.enabled)" };
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const out = getPluginConfigFromFile(configPath);
  if ("error" in out) return { ok: false, error: out.error };
  const current = getNested(out.config, k);
  const currentStr =
    current === undefined ? "(not set)" : typeof current === "string" ? current : JSON.stringify(current);
  let desc = "";
  try {
    const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pluginPath = join(extDir, "openclaw.plugin.json");
    if (existsSync(pluginPath)) {
      const plugin = JSON.parse(readFileSync(pluginPath, "utf-8")) as {
        uiHints?: Record<string, { help?: string; label?: string }>;
      };
      const hint = plugin.uiHints?.[k];
      if (hint?.help) {
        desc = hint.help.length > MAX_DESC_LEN ? hint.help.slice(0, MAX_DESC_LEN - 3) + "..." : hint.help;
      } else if (hint?.label) {
        desc = hint.label;
      }
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runConfigSetHelpForCli:read-hints" });
  }
  if (!desc) desc = "No description for this key.";
  const lines = [`${k} = ${currentStr}`, "", desc];
  return { ok: true, configPath, message: lines.join("\n") };
}

/**
 * Set config mode and apply the full preset so the file matches the preset (avoids "Custom" when parser sees overrides).
 */
export function runConfigModeForCli(ctx: HandlerContext, mode: string): ConfigCliResult {
  const valid: ConfigMode[] = ["local", "minimal", "enhanced", "complete"];
  if (!valid.includes(mode as ConfigMode)) {
    return { ok: false, error: `Invalid mode: ${mode}. Use one of: ${valid.join(", ")}` };
  }
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const out = getPluginConfigFromFile(configPath);
  if ("error" in out) return { ok: false, error: out.error };
  const preset = PRESET_OVERRIDES[mode as ConfigMode];
  for (const key of Object.keys(preset)) {
    const presetVal = preset[key];
    out.config[key] =
      typeof presetVal === "object" && presetVal !== null && !Array.isArray(presetVal)
        ? JSON.parse(JSON.stringify(presetVal))
        : presetVal;
  }
  out.config.mode = mode;
  const writeResult = validateAndWriteConfig(out.config, out.root, configPath, "mode");
  if (!writeResult.ok) return writeResult;
  return {
    ok: true,
    configPath,
    message: `Set mode to "${mode}" and wrote full preset to config. Restart the gateway, then run 'openclaw hybrid-mem config' — you should see "Memory mode: ${mode.charAt(0).toUpperCase() + mode.slice(1)}".`,
  };
}

/**
 * Set config value
 */
export function runConfigSetForCli(ctx: HandlerContext, key: string, value: string): ConfigCliResult {
  if (!key.trim())
    return {
      ok: false,
      error: "Key is required (e.g. nightlyCycle, extraction, credentials, errorReporting.botName, store.fuzzyDedupe)",
    };
  const k = key.trim();
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const out = getPluginConfigFromFile(configPath);
  if ("error" in out) return { ok: false, error: out.error };
  // When setting any errorReporting.* key, ensure errorReporting object exists and has required enabled/consent so schema validates
  if (k.startsWith("errorReporting.")) {
    let er = out.config.errorReporting as Record<string, unknown> | undefined;
    if (typeof er !== "object" || er === null) {
      er = { enabled: false, consent: false };
      out.config.errorReporting = er;
    }
    if (!("enabled" in er)) (er as Record<string, unknown>).enabled = false;
    if (!("consent" in er)) (er as Record<string, unknown>).consent = false;
  }
  // errorReporting must stay an object (schema); "config-set errorReporting true" → errorReporting.enabled + consent = true
  if (k === "errorReporting" && !k.includes(".")) {
    const boolVal = value === "true" || value === "enabled";
    let er = out.config.errorReporting as Record<string, unknown> | undefined;
    if (typeof er !== "object" || er === null) er = { enabled: false, consent: false };
    (er as Record<string, unknown>).enabled = boolVal;
    (er as Record<string, unknown>).consent = boolVal;
    out.config.errorReporting = er;
    const written = (er as Record<string, unknown>).enabled;
    const writeResult = validateAndWriteConfig(out.config, out.root, configPath, "errorReporting");
    if (!writeResult.ok) return writeResult;
    return {
      ok: true,
      configPath,
      message: `Set errorReporting.enabled and errorReporting.consent = ${written}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.`,
    };
  }
  // credentials must stay an object (schema); "config-set credentials true" → credentials.enabled = true
  if (k === "credentials" && !k.includes(".")) {
    const boolVal = value === "true" || value === "enabled";
    const cred = out.config.credentials as Record<string, unknown> | undefined;
    if (typeof cred !== "object" || cred === null) {
      out.config.credentials = { enabled: boolVal };
    } else {
      (out.config.credentials as Record<string, unknown>).enabled = boolVal;
    }
    const written = (out.config.credentials as Record<string, unknown>).enabled;
    const writeResult = validateAndWriteConfig(out.config, out.root, configPath, "credentials");
    if (!writeResult.ok) return writeResult;
    return {
      ok: true,
      configPath,
      message: `Set credentials.enabled = ${written}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.`,
    };
  }
  // Object toggles: "config-set <key> enabled|disabled" (or true|false, on|off) — sets <key>.enabled. No need for .enabled in the key.
  const valueLower = value.trim().toLowerCase();
  const enableValues = ["true", "enabled", "on", "1"];
  const disableValues = ["false", "disabled", "off", "0"];
  const objectToggles: Array<{ key: string; prop: string }> = [
    { key: "costTracking", prop: "enabled" },
    { key: "nightlyCycle", prop: "enabled" },
    { key: "passiveObserver", prop: "enabled" },
    { key: "selfExtension", prop: "enabled" },
    { key: "crystallization", prop: "enabled" },
    { key: "personaProposals", prop: "enabled" },
    { key: "reflection", prop: "enabled" },
    { key: "procedures", prop: "enabled" },
    { key: "graph", prop: "enabled" },
    { key: "wal", prop: "enabled" },
    { key: "aliases", prop: "enabled" },
    { key: "ambient", prop: "enabled" },
    { key: "documents", prop: "enabled" },
    { key: "workflowTracking", prop: "enabled" },
    { key: "queryExpansion", prop: "enabled" },
    { key: "reranking", prop: "enabled" },
    { key: "contextualVariants", prop: "enabled" },
    { key: "verification", prop: "enabled" },
    { key: "provenance", prop: "enabled" },
    { key: "graphRetrieval", prop: "enabled" },
    { key: "clusters", prop: "enabled" },
    { key: "gaps", prop: "enabled" },
    { key: "health", prop: "enabled" },
    { key: "memoryTiering", prop: "enabled" },
    { key: "reinforcement", prop: "enabled" },
    { key: "implicitFeedback", prop: "enabled" },
    { key: "closedLoop", prop: "enabled" },
    { key: "frustrationDetection", prop: "enabled" },
    { key: "crossAgentLearning", prop: "enabled" },
    { key: "toolEffectiveness", prop: "enabled" },
    { key: "futureDateProtection", prop: "enabled" },
    { key: "path", prop: "enabled" },
    { key: "activeTask", prop: "enabled" },
  ];
  for (const { key, prop } of objectToggles) {
    if (k === key && !k.includes(".")) {
      if (!enableValues.includes(valueLower) && !disableValues.includes(valueLower)) {
        return {
          ok: false,
          error: `Use "enabled" or "disabled" (or true/false, on/off). Example: openclaw hybrid-mem config-set ${key} enabled`,
        };
      }
      const toggleVal = enableValues.includes(valueLower);
      let obj = out.config[key] as Record<string, unknown> | undefined;
      if (typeof obj !== "object" || obj === null) obj = {};
      (obj as Record<string, unknown>)[prop] = toggleVal;
      out.config[key] = obj;
      const writeResult = validateAndWriteConfig(out.config, out.root, configPath, key);
      if (!writeResult.ok) return writeResult;
      return {
        ok: true,
        configPath,
        message: `Set ${key} = ${toggleVal ? "enabled" : "disabled"}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.`,
      };
    }
  }
  // extraction uses .extractionPasses not .enabled
  if (k === "extraction" && !k.includes(".")) {
    if (!enableValues.includes(valueLower) && !disableValues.includes(valueLower)) {
      return {
        ok: false,
        error: `Use "enabled" or "disabled". Example: openclaw hybrid-mem config-set extraction enabled`,
      };
    }
    const toggleVal = enableValues.includes(valueLower);
    const ext = out.config.extraction as Record<string, unknown> | undefined;
    const obj = typeof ext === "object" && ext !== null ? { ...ext } : {};
    (obj as Record<string, unknown>).extractionPasses = toggleVal;
    out.config.extraction = obj;
    const writeResult = validateAndWriteConfig(out.config, out.root, configPath, "extraction");
    if (!writeResult.ok) return writeResult;
    return {
      ok: true,
      configPath,
      message: `Set extraction = ${toggleVal ? "enabled" : "disabled"}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.`,
    };
  }
  // verbosity: must be one of the valid levels
  if (k === "verbosity") {
    const validVerbosity = ["silent", "quiet", "normal", "verbose"];
    if (!validVerbosity.includes(value)) {
      return { ok: false, error: `Invalid verbosity: "${value}". Use one of: ${validVerbosity.join(", ")}` };
    }
    out.config.verbosity = value;
    const writeResult = validateAndWriteConfig(out.config, out.root, configPath, "verbosity");
    if (!writeResult.ok) return writeResult;
    return {
      ok: true,
      configPath,
      message: `Set verbosity = "${value}". Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.`,
    };
  }
  // Enum-like keys: normalize value to lowercase so "Nano" → "nano" for schema validation
  const enumKeys: Record<string, string[]> = {
    "distill.extractionModelTier": ["nano", "default", "heavy"],
  };
  let valueToSet: unknown = value;
  if (enumKeys[k]) {
    const normalized = String(value).trim().toLowerCase();
    if (!enumKeys[k].includes(normalized)) {
      return { ok: false, error: `Invalid ${k}: "${value}". Use one of: ${enumKeys[k].join(", ")}` };
    }
    valueToSet = normalized;
  }
  if (!setNested(out.config, k, valueToSet)) {
    return { ok: false, error: `Invalid config key: ${key}` };
  }
  const written = getNested(out.config, k);
  const writtenStr = typeof written === "string" ? written : JSON.stringify(written);

  const writeResult = validateAndWriteConfig(out.config, out.root, configPath, "generic");
  if (!writeResult.ok) return writeResult;
  return {
    ok: true,
    configPath,
    message: `Set ${key} = ${writtenStr}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.`,
  };
}
