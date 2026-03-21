#!/usr/bin/env node
/**
 * Ensure native dependency (@lancedb/lancedb) is both installed and loadable.
 * On upgrades, package manager behavior can leave the dependency absent or with
 * missing platform package (optional dep) or stale native bindings.
 */
const { execFileSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const moduleName = "@lancedb/lancedb";

function getVersionRange() {
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf8"));
  return pkg.dependencies?.[moduleName] || "";
}

function run(args, desc) {
  try {
    execFileSync("npm", args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
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

function needsRebuild(moduleName) {
  try {
    require(moduleName);
    return false;
  } catch {
    return true;
  }
}

function isMissingPlatformBinaryError(error) {
  if (!error) return false;
  const msg = String(error.stack || error.message || error);
  return (
    /MODULE_NOT_FOUND|Cannot find module/i.test(msg) &&
    (/[@/]lancedb[/\\]lancedb-(darwin|linux|win32)/i.test(msg) ||
      /@lancedb\/lancedb-(darwin|linux|win32)/i.test(msg) ||
      /lancedb\..+\.node/i.test(msg))
  );
}

function needsInstall(state) {
  if (!state.installed) return true;
  if (state.loadable) return false;
  return isMissingPlatformBinaryError(state.error);
}

let state = inspectModule(moduleName);
if (needsInstall(state)) {
  if (!state.installed) {
    console.log(`${moduleName} missing after install — attempting targeted install...`);
  } else {
    console.log(`${moduleName} platform binary appears missing — attempting targeted install...`);
  }
  const versionRange = getVersionRange();
  const installSpec = versionRange ? `${moduleName}@${versionRange}` : moduleName;
  if (!run(["install", "--no-save", installSpec], `${moduleName} install`)) process.exit(1);
  state = inspectModule(moduleName);
}

if (!needsRebuild(moduleName)) {
  console.log(`${moduleName} already loadable — skipping rebuild`);
  process.exit(0);
}

console.log(`Rebuilding ${moduleName}...`);
if (!run(["rebuild", moduleName], `${moduleName} rebuild`)) process.exit(1);
state = inspectModule(moduleName);

if (needsRebuild(moduleName)) {
  console.error(`\n✗ ${moduleName} is still not loadable after install/rebuild.`);
  if (state.error) console.error(state.error);
  process.exit(1);
}

console.log(`${moduleName} bindings OK — ready`);
