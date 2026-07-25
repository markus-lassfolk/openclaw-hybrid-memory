const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const installer = path.resolve(__dirname, "..", "install.js");

function makeTarball(root, includesManifest) {
  const packageDir = path.join(root, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  if (includesManifest) fs.writeFileSync(path.join(packageDir, "package.json"), '{"name":"fixture-plugin","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(packageDir, "openclaw.plugin.json"), '{"id":"openclaw-hybrid-memory"}\n');
  const tarball = path.join(root, includesManifest ? "valid.tgz" : "missing-manifest.tgz");
  execFileSync("tar", ["-czf", tarball, "package"], { cwd: root });
  return tarball;
}

function runInstaller(tarball) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-installer-test-"));
  const extensions = path.join(root, ".openclaw", "extensions");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env node
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "pack") { fs.copyFileSync(process.env.FIXTURE_TARBALL, path.join(process.cwd(), "fixture.tgz")); process.exit(0); }
if (args[0] === "install") {
  if (!fs.existsSync(path.join(process.cwd(), "package.json"))) { console.error("ENOENT: missing package.json"); process.exit(42); }
  fs.appendFileSync(process.env.NPM_CALL_LOG, args.join(" ") + "\\n");
  for (const dep of ["@lancedb/lancedb", "apache-arrow"]) { const p = path.join(process.cwd(), "node_modules", ...dep.split("/")); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, "package.json"), "{}"); }
  process.exit(0);
}
process.exit(91);
`);
  fs.chmodSync(path.join(bin, "npm"), 0o755);
  const npmLog = path.join(root, "npm.log");
  const result = spawnSync(process.execPath, [installer, "fixture"], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_EXTENSIONS_DIR: extensions, FIXTURE_TARBALL: tarball, NPM_CALL_LOG: npmLog, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  return { root, extensions, npmLog, result };
}

test("installs an npm-packed package only after staging its manifest outside extensions", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-installer-fixture-"));
  const run = runInstaller(makeTarball(fixture, true));
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(fs.existsSync(path.join(run.extensions, "openclaw-hybrid-memory", "package.json")));
  assert.match(fs.readFileSync(run.npmLog, "utf8"), /install --omit=dev/);
  assert.deepEqual(fs.readdirSync(run.extensions), ["openclaw-hybrid-memory"]);
  assert.deepEqual(fs.readdirSync(path.join(run.root, ".openclaw", ".cache")), []);
});

test("fails before npm install when a packed package lacks package.json", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-installer-fixture-"));
  const run = runInstaller(makeTarball(fixture, false));
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /Package manifest is missing from staged package/);
  assert.equal(fs.existsSync(run.npmLog), false);
  assert.deepEqual(fs.readdirSync(run.extensions), []);
  assert.deepEqual(fs.readdirSync(path.join(run.root, ".openclaw", ".cache")), []);
});
