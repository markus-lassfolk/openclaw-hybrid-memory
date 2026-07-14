#!/usr/bin/env node
/**
 * Single-source-of-truth version sync (issue #2115).
 *
 * `extensions/memory-hybrid/package.json#version` is the ONE authoritative
 * release version. Two other files must always match it but are easy to forget:
 *   - `extensions/memory-hybrid/openclaw.plugin.json#version` — read by the
 *     OpenClaw host for `plugins inspect`. When it drifts, operators see a
 *     version that contradicts `hybrid-mem version` / the gateway registration
 *     log (which read package.json via versionInfo.ts).
 *   - `packages/openclaw-hybrid-memory-install/package.json#version` — the
 *     standalone installer, published in lockstep at the same release tag.
 *
 * Release automation only runs `npm version` (package.json) — nothing wrote the
 * other two, so they silently drifted. This script is the write-side fix (run in
 * prepack and via `npm run sync:version`) and the check-side gate (`--check`,
 * used by verify-publish and CI).
 *
 * Usage:
 *   node scripts/sync-plugin-version.cjs           # write package.json.version into the targets
 *   node scripts/sync-plugin-version.cjs --check   # exit 1 if any target differs (no writes)
 */
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

const sourcePath = path.join(pluginRoot, "package.json");

/**
 * Targets that must always equal the plugin package.json version. Each declares
 * how to read/write its version so we can preserve the file's own formatting.
 */
const targets = [
  {
    label: "openclaw.plugin.json",
    file: path.join(pluginRoot, "openclaw.plugin.json"),
  },
  {
    label: "openclaw-hybrid-memory-install/package.json",
    file: path.join(repoRoot, "packages", "openclaw-hybrid-memory-install", "package.json"),
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Rewrite ONLY the top-level `version` string via a surgical text replacement so
 * the rest of the file is preserved byte-for-byte (never reformats arrays/indent
 * the way JSON.parse + JSON.stringify would). The top-level `version` key appears
 * near the top of each of these files, before any nested schema, so the first
 * `"version": "…"` occurrence is the top-level one.
 */
function writeVersion(file, version) {
  const raw = fs.readFileSync(file, "utf8");
  const re = /("version"\s*:\s*")([^"]*)(")/;
  if (!re.test(raw)) {
    throw new Error(`Could not locate a top-level "version" field in ${file}`);
  }
  const out = raw.replace(re, (_m, pre, _old, post) => `${pre}${version}${post}`);
  fs.writeFileSync(file, out, "utf8");
}

function main() {
  const check = process.argv.includes("--check");
  const sourceVersion = readJson(sourcePath).version;
  if (typeof sourceVersion !== "string" || sourceVersion.trim().length === 0) {
    console.error(`FAIL: could not read a version from ${sourcePath}`);
    process.exit(1);
  }

  const mismatches = [];
  const written = [];
  for (const target of targets) {
    if (!fs.existsSync(target.file)) {
      console.error(`FAIL: version-sync target missing: ${target.file}`);
      process.exit(1);
    }
    const current = readJson(target.file).version;
    if (current === sourceVersion) continue;
    if (check) {
      mismatches.push(`${target.label}: ${current} (expected ${sourceVersion})`);
    } else {
      writeVersion(target.file, sourceVersion);
      written.push(`${target.label}: ${current} -> ${sourceVersion}`);
    }
  }

  if (check) {
    if (mismatches.length > 0) {
      console.error(
        `FAIL: version drift — package.json is ${sourceVersion} but:\n  ${mismatches.join("\n  ")}\n` +
          "Run `npm run sync:version` (from extensions/memory-hybrid) to fix.",
      );
      process.exit(1);
    }
    console.log(`OK: all release-version literals match package.json (${sourceVersion})`);
    return;
  }

  if (written.length > 0) {
    console.log(`Synced version to ${sourceVersion}:\n  ${written.join("\n  ")}`);
  } else {
    console.log(`Versions already in sync (${sourceVersion})`);
  }
}

main();
