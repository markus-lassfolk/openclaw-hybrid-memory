#!/usr/bin/env node
/**
 * Rebuild native modules (better-sqlite3, @lancedb/lancedb) after install.
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
    console.error(`  Retry: cd ${root} && npm rebuild better-sqlite3 @lancedb/lancedb`);
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

let ok1 = true;
if (needsRebuild("better-sqlite3")) {
  console.log("Rebuilding better-sqlite3...");
  ok1 = run("npm rebuild better-sqlite3", "better-sqlite3");
} else {
  console.log("better-sqlite3 bindings OK — skipping rebuild");
}

let ok2 = true;
if (needsRebuild("@lancedb/lancedb")) {
  console.log("Rebuilding @lancedb/lancedb...");
  ok2 = run("npm rebuild @lancedb/lancedb", "@lancedb/lancedb");
} else {
  console.log("@lancedb/lancedb bindings OK — skipping rebuild");
}

if (!ok1 || !ok2) {
  process.exit(1);
}
