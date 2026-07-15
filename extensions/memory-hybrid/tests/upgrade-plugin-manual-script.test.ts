/**
 * Integration tests for scripts/upgrade-plugin-manual.sh (#2130, #2134 QA follow-up).
 *
 * Runs the real script with fake `npm`, `mv`, and `openclaw` binaries on PATH, so the swap/rollback
 * logic and the leftover-cleanup trap execute for real, without touching the npm registry or an
 * actual OpenClaw gateway.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(import.meta.dirname, "..", "..", "..", "scripts", "upgrade-plugin-manual.sh");

function buildFixtureTgz(tmp: string): string {
  const pkgRoot = join(tmp, "pkg-src");
  const pkgDir = join(pkgRoot, "package");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "openclaw-hybrid-memory", version: "0.0.0-test" }),
  );
  writeFileSync(join(pkgDir, "NEW_VERSION_MARKER.txt"), "new version content\n");
  const tgzPath = join(tmp, "openclaw-hybrid-memory-0.0.0-test.tgz");
  execFileSync("tar", ["-czf", tgzPath, "-C", pkgRoot, "package"]);
  return tgzPath;
}

function writeFakeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("scripts/upgrade-plugin-manual.sh (#2130, #2134 QA follow-up)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "upgrade-plugin-manual-"));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const extDir = join(tmp, "extensions");
    mkdirSync(extDir, { recursive: true });
    const pluginDir = join(extDir, "openclaw-hybrid-memory");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "OLD_VERSION_MARKER.txt"), "old version content\n");

    const tgzPath = buildFixtureTgz(tmp);
    const gatewayLog = join(tmp, "gateway.log");
    writeFileSync(gatewayLog, "");

    writeFakeBin(
      bin,
      "npm",
      `if [ "$1" = "pack" ]; then
  cp "${tgzPath}" "./$(basename "${tgzPath}")"
  exit 0
fi
if [ "$1" = "install" ]; then
  exit 0
fi
echo "fake npm: unexpected args: $*" >&2
exit 2`,
    );
    writeFakeBin(
      bin,
      "openclaw",
      `if [ "$1" = "gateway" ] && [ "$2" = "stop" ]; then echo "stop" >>"${gatewayLog}"; exit 0; fi
if [ "$1" = "gateway" ] && [ "$2" = "start" ]; then echo "start" >>"${gatewayLog}"; exit 0; fi
echo "fake openclaw: unexpected args: $*" >&2
exit 2`,
    );

    return { bin, extDir, pluginDir, gatewayLog };
  }

  it("succeeds end-to-end: swaps in the new version and restarts the gateway", () => {
    const { bin, extDir, pluginDir, gatewayLog } = setup();

    const result = spawnSync("bash", [SCRIPT_PATH, "0.0.0-test"], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_EXTENSIONS_DIR: extDir },
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(pluginDir, "NEW_VERSION_MARKER.txt"))).toBe(true);
    expect(existsSync(join(pluginDir, "OLD_VERSION_MARKER.txt"))).toBe(false);
    expect(readFileSync(gatewayLog, "utf-8").trim().split("\n")).toEqual(["stop", "start"]);
    // No leftover staging/backup/tmp siblings from a successful run (staging is consumed by the
    // swap; backup is deliberately kept, so exactly one `.pre-upgrade-*` sibling is expected).
    const siblings = readdirSync(extDir);
    expect(siblings.some((f) => f.includes(".staging-"))).toBe(false);
  });

  it("rolls back to the previous version and restarts the gateway when the activation swap fails (#2134 QA follow-up)", () => {
    const { bin, extDir, pluginDir, gatewayLog } = setup();
    const mvCountFile = join(tmp, "mv-count");
    writeFileSync(mvCountFile, "0");
    // Fake `mv` fails on its 2nd invocation — the script calls `mv` exactly twice on the happy
    // path (backup, then activate-new-version); the 2nd call is the non-atomic swap step.
    writeFakeBin(
      bin,
      "mv",
      `count=$(cat "${mvCountFile}")
count=$((count + 1))
echo "$count" >"${mvCountFile}"
if [ "$count" = "2" ]; then
  echo "fake mv: simulated failure on call #$count" >&2
  exit 1
fi
exec /usr/bin/mv "$@"`,
    );

    const result = spawnSync("bash", [SCRIPT_PATH, "0.0.0-test"], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_EXTENSIONS_DIR: extDir },
    });

    expect(result.status).not.toBe(0);
    // The previous version must be restored at PLUGIN_DIR, not left missing.
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, "OLD_VERSION_MARKER.txt"))).toBe(true);
    expect(existsSync(join(pluginDir, "NEW_VERSION_MARKER.txt"))).toBe(false);
    // The gateway must be restarted even on the rollback path, not left stopped indefinitely.
    expect(readFileSync(gatewayLog, "utf-8").trim().split("\n")).toEqual(["stop", "start"]);
    // The leftover-cleanup trap must still remove the now-unused staging dir on this failure path.
    const siblings = readdirSync(extDir);
    expect(siblings.some((f) => f.includes(".staging-"))).toBe(false);
  });
});
