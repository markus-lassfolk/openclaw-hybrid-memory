#!/usr/bin/env node
/**
 * Merge deploy/openclaw.memory-snippet.json and openclaw.model-tokens-snippet.json
 * into ~/.openclaw/openclaw.json (deep merge, skips _comment keys).
 * Usage: node scripts/merge-config-snippets.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OPENCLAW_DIR = join(process.env.HOME || process.env.USERPROFILE, ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const DRY_RUN = process.argv.includes("--dry-run");

function deepMerge(target, source, skipKeys = ["_comment"]) {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    if (skipKeys.includes(key)) continue;
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      deepMerge(tgtVal, srcVal, skipKeys);
    } else if (tgtVal === undefined) {
      target[key] = srcVal;
    }
  }
}

function loadJson(path) {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

const memoryPath = join(REPO_ROOT, "deploy", "openclaw.memory-snippet.json");
const modelTokensPath = join(REPO_ROOT, "deploy", "openclaw.model-tokens-snippet.json");

let config = {};
if (existsSync(CONFIG_PATH)) {
  config = loadJson(CONFIG_PATH);
  console.log("Loaded existing", CONFIG_PATH);
} else {
  console.log("No existing config; starting from empty object.");
}

const memorySnippet = loadJson(memoryPath);
const modelTokensSnippet = loadJson(modelTokensPath);

deepMerge(config, memorySnippet);
deepMerge(config, modelTokensSnippet);

const out = JSON.stringify(config, null, 2);

if (DRY_RUN) {
  console.log("--dry-run: would write to", CONFIG_PATH);
  console.log(out.slice(0, 500) + "\n...");
  process.exit(0);
}

mkdirSync(OPENCLAW_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, out, "utf-8");
console.log("Written:", CONFIG_PATH);
