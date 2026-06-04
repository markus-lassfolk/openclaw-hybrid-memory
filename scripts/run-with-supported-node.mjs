#!/usr/bin/env node
/**
 * Run a command under a Node runtime that satisfies engines (>=22.16.0).
 * Re-execs via a supported binary when Cursor/cursor-server prepends Node 20.
 *
 * Usage: node scripts/run-with-supported-node.mjs <cmd> [args...]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN = [22, 16, 0];

function readRequiredMin() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "extensions", "memory-hybrid", "package.json"), "utf-8"));
    const engines = pkg.engines?.node;
    if (typeof engines === "string") {
      const m = />=\s*(\d+)\.(\d+)\.(\d+)/.exec(engines);
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  } catch {
    /* default */
  }
  return MIN;
}

const REQUIRED = readRequiredMin();

function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function meetsMinimum(version, min = REQUIRED) {
  const parts = parseVersion(version);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] > min[i]) return true;
    if (parts[i] < min[i]) return false;
  }
  return true;
}

function versionOfNodeBinary(nodePath) {
  if (!existsSync(nodePath)) return null;
  const r = spawnSync(nodePath, ["-p", "process.version"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

function nvmCandidateFromNvmrc() {
  const nvmDir = process.env.NVM_DIR || join(process.env.HOME ?? "", ".nvm");
  const nvmrcPath = join(root, ".nvmrc");
  if (!existsSync(nvmrcPath)) return null;
  const version = readFileSync(nvmrcPath, "utf-8").trim();
  if (!version) return null;
  const candidate = join(nvmDir, "versions", "node", `v${version}`, "bin", "node");
  return existsSync(candidate) ? candidate : null;
}

function collectCandidates() {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  push(process.env.OPENCLAW_NODE_PATH);
  push(process.env.PREFERRED_NODE_PATH);
  push(nvmCandidateFromNvmrc());

  // Prefer Node 22 from system install (matches .nvmrc / CI) before other majors.
  push("/usr/bin/node");
  push("/usr/local/bin/node");

  const pathEntries = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry && !entry.includes(".cursor-server"));
  for (const dir of pathEntries) {
    push(join(dir, "node"));
  }

  return out;
}

function resolveSupportedNode() {
  if (meetsMinimum(process.version) && !process.execPath.includes(".cursor-server")) {
    return process.execPath;
  }

  const preferredMajor22 = [];
  const otherSupported = [];

  for (const candidate of collectCandidates()) {
    const version = versionOfNodeBinary(candidate);
    if (!version || !meetsMinimum(version)) continue;
    const major = parseVersion(version)?.[0] ?? 0;
    if (major === 22) preferredMajor22.push({ candidate, version });
    else otherSupported.push({ candidate, version });
  }

  if (preferredMajor22.length > 0) return preferredMajor22[0].candidate;
  if (otherSupported.length > 0) return otherSupported[0].candidate;
  return null;
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("Usage: node scripts/run-with-supported-node.mjs <cmd> [args...]");
  process.exit(1);
}

const nodeBin = resolveSupportedNode();
if (!nodeBin) {
  console.error(
    `No Node >= ${REQUIRED.join(".")} found. Install Node 22.16+ (see .nvmrc) or set OPENCLAW_NODE_PATH.`,
  );
  process.exit(1);
}

function localBinPath() {
  const cwd = process.cwd();
  const local = join(cwd, "node_modules", ".bin");
  return existsSync(local) ? local : null;
}

function spawnEnv(nodeBin) {
  const nodeDir = dirname(nodeBin);
  const localBin = localBinPath();
  const pathParts = [
    localBin,
    nodeDir,
    ...(process.env.PATH ?? "").split(":").filter((entry) => entry && !entry.includes(".cursor-server")),
  ].filter(Boolean);
  return { ...process.env, PATH: [...new Set(pathParts)].join(":") };
}

if (nodeBin !== process.execPath) {
  const forwarded = spawnSync(nodeBin, [process.argv[1], cmd, ...args], {
    stdio: "inherit",
    env: spawnEnv(nodeBin),
  });
  process.exit(forwarded.status ?? 1);
}

const result = spawnSync(cmd, args, { stdio: "inherit", env: spawnEnv(nodeBin), shell: false });
process.exit(result.status ?? 1);
