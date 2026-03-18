#!/usr/bin/env node
/**
 * Rebuild native modules (@lancedb/lancedb) after install.
 * Skips rebuild when the module already loads successfully (warm cache).
 * Exits 1 on failure with a clear message — no silent failures.
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

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

function needsRebuild(moduleName) {
  try {
    require(moduleName);
    return false;
  } catch {
    return true;
  }
}

let ok = true;
if (needsRebuild("@lancedb/lancedb")) {
  console.log("Rebuilding @lancedb/lancedb...");
  ok = run("npm rebuild @lancedb/lancedb", "@lancedb/lancedb");
} else {
  console.log("@lancedb/lancedb bindings OK — skipping rebuild");
}

if (!ok) {
  process.exit(1);
}
