#!/usr/bin/env node
/**
 * Ensure native dependency (@lancedb/lancedb) is both installed and loadable.
 * On upgrades, package manager behavior can leave the dependency absent or with
 * stale native bindings. We first attempt a targeted install when missing, then
 * rebuild when present but unloadable.
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const moduleName = "@lancedb/lancedb";

function run(cmd, desc) {
  try {
    execSync(cmd, { cwd: root, stdio: "inherit" });
    return true;
  } catch {
    console.error(`\n✗ ${desc} failed.`);
    console.error("  The plugin requires native modules built for your platform.");
    console.error("  Ensure you have: C++ toolchain, Python 3, node-gyp");
    console.error(`  Retry: cd ${root} && npm install ${moduleName} && npm rebuild ${moduleName}`);
    return false;
  }
}

function inspectModule(name) {
  try {
    const resolved = require.resolve(name, { paths: [root] });
    try {
      require(name);
      return { installed: true, loadable: true, resolved };
    } catch (error) {
      return { installed: true, loadable: false, resolved, error };
    }
  } catch (error) {
    return { installed: false, loadable: false, error };
  }
}

let state = inspectModule(moduleName);
if (!state.installed) {
  console.log(`${moduleName} missing after install — attempting targeted install...`);
  if (!run(`npm install ${moduleName}`, `${moduleName} install`)) process.exit(1);
  state = inspectModule(moduleName);
}

if (!state.loadable) {
  console.log(`Rebuilding ${moduleName}...`);
  if (!run(`npm rebuild ${moduleName}`, `${moduleName} rebuild`)) process.exit(1);
  state = inspectModule(moduleName);
}

if (!state.loadable) {
  console.error(`\n✗ ${moduleName} is still not loadable after install/rebuild.`);
  if (state.error) console.error(state.error);
  process.exit(1);
}

console.log(`${moduleName} bindings OK — ready`);
