#!/usr/bin/env node
/**
 * Pre-publish verification for openclaw-hybrid-memory.
 * Ensures: postinstall present, and all modules imported by index.ts are
 * included in package.json "files" and exist on disk (avoids broken publish
 * with modular index but missing lifecycle/tools/setup dirs).
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let failed = false;

// 1. postinstall required for native deps
if (!pkg.scripts?.postinstall) {
  console.error("FAIL: postinstall missing from package.json - published package will not rebuild native deps");
  failed = true;
} else {
  console.log("OK: postinstall present");
}

// 2. Collect relative imports from index.ts (from "./foo.js" or './bar/baz.js')
const indexPath = path.join(root, "index.ts");
const indexContent = fs.readFileSync(indexPath, "utf8");
const importRegex = /from\s+["'](\.\/[^"']+)["']/g;
const importedPaths = new Set();
let m;
while ((m = importRegex.exec(indexContent)) !== null) {
  const spec = m[1];
  if (spec.startsWith("./")) {
    // Normalize to source path: .js -> .ts
    const rel = spec.slice(2).replace(/\.js$/, ".ts");
    importedPaths.add(rel);
  }
}

// 3. Which "files" entries cover a given path? (exact match or directory prefix)
const files = pkg.files || [];
function isCovered(relPath) {
  if (files.includes(relPath)) return true;
  const dir = relPath.includes("/") ? relPath.split("/")[0] : null;
  if (dir && files.includes(dir)) return true;
  return false;
}

// 4. Check each imported path is covered and exists
const missingFromFiles = [];
const missingFromDisk = [];
for (const rel of [...importedPaths].sort()) {
  if (!isCovered(rel)) missingFromFiles.push(rel);
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) missingFromDisk.push(rel);
}

if (missingFromFiles.length > 0) {
  console.error("FAIL: The following modules are imported by index.ts but are NOT included in package.json \"files\":");
  missingFromFiles.forEach((p) => console.error("  - " + p));
  console.error("  Add the missing path or its parent directory (e.g. \"lifecycle\", \"setup\", \"tools\") to \"files\".");
  failed = true;
} else {
  console.log("OK: all index.ts imports are covered by package.json \"files\"");
}

if (missingFromDisk.length > 0) {
  console.error("FAIL: The following imported paths do not exist on disk:");
  missingFromDisk.forEach((p) => console.error("  - " + p));
  failed = true;
} else {
  console.log("OK: all imported files exist on disk");
}

if (failed) process.exit(1);
console.log("verify-publish: all checks passed");
