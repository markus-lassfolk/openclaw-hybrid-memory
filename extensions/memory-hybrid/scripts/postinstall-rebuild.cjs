#!/usr/bin/env node
/**
 * Rebuild native modules (better-sqlite3, @lancedb/lancedb) after install.
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

console.log("Rebuilding native modules for openclaw-hybrid-memory...");
const ok1 = run("npm rebuild better-sqlite3", "better-sqlite3");
const ok2 = run("npm rebuild @lancedb/lancedb", "@lancedb/lancedb");

if (!ok1 || !ok2) {
  process.exit(1);
}
console.log("Native modules rebuilt successfully.");
