#!/usr/bin/env node
/**
 * Guard the CI storage policy: dependency installers cache npm's download store,
 * never installed node_modules trees. Keep this dependency-free so Workflow
 * Sanity can run it before package installation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readWorkflow = (relativePath) => readFileSync(resolve(repoRoot, relativePath), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
};

const ci = readWorkflow(".github/workflows/ci.yml");
const release = readWorkflow(".github/workflows/release.yml");
const workflows = [
  [".github/workflows/ci.yml", ci],
  [".github/workflows/release.yml", release],
];

for (const [name, content] of workflows) {
  assert(!/uses:\s*actions\/cache@/u.test(content), `${name} must not archive node_modules with actions/cache`);
  assert(!/^\s*path:\s+.*node_modules/mu.test(content), `${name} must not cache a node_modules path`);
}

const npmCacheSteps = (ci.match(/^\s+cache:\s+npm\s*$/gmu) ?? []).length;
assert(npmCacheSteps === 11, `CI must configure npm caching for all 11 dependency-installing jobs (found ${npmCacheSteps})`);
assert(
  ci.includes("extensions/memory-hybrid/package-lock.json\n            extensions/memory-hybrid/graph-app/package-lock.json"),
  "graph-app cache must depend on both plugin and graph-app lockfiles",
);
assert(
  /^\s+cache:\s+npm\s*$\n\s+cache-dependency-path:\s+extensions\/memory-hybrid\/package-lock\.json/mu.test(release),
  "release publish job must use npm cache keyed by the plugin lockfile",
);

console.log("OK: CI/release dependency caches use npm downloads, not node_modules archives");
