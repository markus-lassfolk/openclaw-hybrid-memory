#!/usr/bin/env node
/**
 * Rebuild native modules (@lancedb/lancedb) after install.
 * Skips rebuild when the module already loads successfully (warm cache).
 * Exits 1 on failure with a clear message — no silent failures.
 */
// @security-note Direct child_process use is required here during install-time script execution
// where our TS wrappers are not yet compiled or guaranteed available.
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
// Native modules that need a platform rebuild after install.
const REQUIRED_NATIVE_MODULES = ["@lancedb/lancedb"];
// Pure-JS runtime modules that must merely be PRESENT (no rebuild). apache-arrow
// is a peer dependency of @lancedb/lancedb; if an older/oddly-resolved tree left
// it out, ensure it's installed so the plugin can load (issue #2116).
const REQUIRED_RUNTIME_MODULES = ["apache-arrow"];

function run(cmd, desc) {
  try {
    execSync(cmd, { cwd: root, stdio: "inherit" });
    return true;
  } catch (err) {
    console.error(`\n✗ ${desc} failed.`);
    console.error("  The plugin requires native modules built for your platform.");
    console.error("  Ensure you have: C++ toolchain, Python 3, node-gyp");
    console.error(`  Retry: cd ${root} && npm rebuild @lancedb/lancedb`);
    return false;
  }
}

function isInstalled(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

function ensureInstalled(moduleName) {
  if (isInstalled(moduleName)) return true;
  console.log(`${moduleName} not found — installing...`);
  return run(`npm install --no-save --ignore-scripts ${moduleName}`, `${moduleName} install`);
}

function needsRebuild(moduleName) {
  try {
    require(moduleName);
    return false;
  } catch {
    return true;
  }
}

let ok = true;
for (const moduleName of REQUIRED_NATIVE_MODULES) {
  if (!ensureInstalled(moduleName)) {
    ok = false;
    continue;
  }
  if (needsRebuild(moduleName)) {
    console.log(`Rebuilding ${moduleName}...`);
    ok = run(`npm rebuild ${moduleName}`, moduleName) && ok;
  } else {
    console.log(`${moduleName} bindings OK — skipping rebuild`);
  }
}

// Pure-JS runtime modules: ensure present, never rebuild.
for (const moduleName of REQUIRED_RUNTIME_MODULES) {
  if (isInstalled(moduleName)) {
    console.log(`${moduleName} present — OK`);
  } else if (!ensureInstalled(moduleName)) {
    ok = false;
  }
}

if (!ok) {
  process.exit(1);
}
