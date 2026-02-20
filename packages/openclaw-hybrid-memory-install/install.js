#!/usr/bin/env node
/**
 * Standalone installer for openclaw-hybrid-memory.
 * Use when OpenClaw config validation fails (e.g. "plugin not found").
 * Run: npx -y openclaw-hybrid-memory-install
 * Fix broken credentials config (without loading plugin): npx -y openclaw-hybrid-memory-install fix-config
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.argv[2] === "fix-config") {
  require(path.join(__dirname, "fix-config.js"));
  process.exit(0);
}

const os = require("os");
const version = process.argv[2] || "latest";
const extDir =
  process.env.OPENCLAW_EXTENSIONS_DIR ||
  path.join(os.homedir(), ".openclaw", "extensions");
const pluginDir = path.join(extDir, "openclaw-hybrid-memory");
const tmpDir = path.join(
  os.tmpdir(),
  `openclaw-plugin-install-${process.pid}`
);

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts });
}

try {
  console.log(`Installing openclaw-hybrid-memory@${version} to ${pluginDir}\n`);

  console.log("Removing existing plugin...");
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true });
  }

  console.log("Fetching via npm pack...");
  fs.mkdirSync(tmpDir, { recursive: true });
  run(`npm pack openclaw-hybrid-memory@${version}`, { cwd: tmpDir });

  const tgz = fs.readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack did not produce a .tgz file");

  console.log("Extracting...");
  fs.mkdirSync(pluginDir, { recursive: true });
  const tgzPath = path.join(tmpDir, tgz);
  run(`tar -xzf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(pluginDir)} --strip-components=1`);

  console.log("Installing deps and rebuilding native modules...");
  run("npm install --omit=dev", { cwd: pluginDir });

  console.log("Cleaning up...");
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(
    "\nDone. Restart the gateway: openclaw gateway stop && openclaw gateway start"
  );
} catch (err) {
  console.error("Install failed:", err.message);
  process.exit(1);
}
