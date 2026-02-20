#!/usr/bin/env node
/**
 * Fix plugin config when validation fails (e.g. "credentials: must be object").
 * Run without loading the plugin: npx -y openclaw-hybrid-memory-install fix-config
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const PLUGIN_ID = "openclaw-hybrid-memory";
const configPath =
  process.env.OPENCLAW_CONFIG_PATH ||
  path.join(os.homedir(), ".openclaw", "openclaw.json");

function main() {
  if (!fs.existsSync(configPath)) {
    console.error("Config not found:", configPath);
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (e) {
    console.error("Could not read config:", e.message);
    process.exit(1);
  }
  let root;
  try {
    root = JSON.parse(raw);
  } catch (e) {
    console.error("Invalid JSON in config:", e.message);
    process.exit(1);
  }
  const plugins = root.plugins;
  if (!plugins || typeof plugins !== "object") {
    console.log("No plugins section; nothing to fix.");
    return;
  }
  const entries = plugins.entries;
  if (!entries || typeof entries !== "object" || !entries[PLUGIN_ID]) {
    console.log("Plugin entry not found; nothing to fix.");
    return;
  }
  const entry = entries[PLUGIN_ID];
  if (!entry.config || typeof entry.config !== "object") {
    console.log("Plugin has no config object; nothing to fix.");
    return;
  }
  const cred = entry.config.credentials;
  if (cred !== true && cred !== false) {
    console.log("credentials is already an object or missing; nothing to fix.");
    return;
  }
  entry.config.credentials = { enabled: !!cred };
  try {
    fs.writeFileSync(configPath, JSON.stringify(root, null, 2), "utf-8");
  } catch (e) {
    console.error("Could not write config:", e.message);
    process.exit(1);
  }
  console.log("Fixed: credentials was boolean, set to { enabled: " + !!cred + " }.");
  console.log("Run: openclaw hybrid-mem verify");
}

main();
