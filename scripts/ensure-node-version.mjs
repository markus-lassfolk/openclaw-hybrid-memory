#!/usr/bin/env node
/**
 * Fail fast when the active Node runtime is below package.json engines (>=22.16.0).
 * Used by npm pre* hooks; for subprocess re-exec use run-with-supported-node.mjs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN = [22, 16, 0];

function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function readRequiredFromPackageJson() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const pkg = JSON.parse(readFileSync(join(root, "extensions", "memory-hybrid", "package.json"), "utf-8"));
    const engines = pkg.engines?.node;
    if (typeof engines === "string") {
      const m = />=\s*(\d+)\.(\d+)\.(\d+)/.exec(engines);
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  } catch {
    /* use MIN default */
  }
  return MIN;
}

const required = readRequiredFromPackageJson();
const minLabel = `${required[0]}.${required[1]}.${required[2]}`;

function meetsRequired(version) {
  const parts = parseVersion(version);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] > required[i]) return true;
    if (parts[i] < required[i]) return false;
  }
  return true;
}

if (!meetsRequired(process.version)) {
  console.error(
    [
      `Node ${process.version} is too old for openclaw-hybrid-memory (requires >= ${minLabel}).`,
      `Active binary: ${process.execPath}`,
      "",
      "This repo targets Node 22.16+ (node:sqlite). On WSL/Linux with Node 22 installed:",
      "  /usr/bin/node --version",
      "",
      "If Cursor prepends its bundled Node 20, use the repo wrapper for tests:",
      "  cd extensions/memory-hybrid && npm test",
      "",
      "Or activate Node 22 before running commands:",
      "  export PATH=\"/usr/bin:$PATH\"   # after removing .cursor-server from PATH",
      "  nvm use                          # if using nvm and .nvmrc",
    ].join("\n"),
  );
  process.exit(1);
}
