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

function getVersionRange() {
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf8"));
  return pkg.dependencies?.[moduleName] || "";
}

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

function needsRebuild(state) {
  if (!state.installed) return true;
  return !state.loadable;
}

let state = inspectModule(moduleName);
if (!state.installed) {
  console.log(`${moduleName} missing after install — attempting targeted install...`);
  const versionRange = getVersionRange();
  const installSpec = versionRange ? `${moduleName}@${versionRange}` : moduleName;
  if (!run(`npm install --no-save ${installSpec}`, `${moduleName} install`)) process.exit(1);
  state = inspectModule(moduleName);
}

if (!needsRebuild(state)) {
  console.log(`${moduleName} already loadable — skipping rebuild`);
  process.exit(0);
}

console.log(`Rebuilding ${moduleName}...`);
if (!run(`npm rebuild ${moduleName}`, `${moduleName} rebuild`)) process.exit(1);
state = inspectModule(moduleName);

if (needsRebuild(state)) {
  console.error(`\n✗ ${moduleName} is still not loadable after install/rebuild.`);
  if (state.error) console.error(state.error);
  process.exit(1);
}

console.log(`${moduleName} bindings OK — ready`);
