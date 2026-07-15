/**
 * Integration tests for scripts/post-upgrade.sh (#2130, #2134 QA follow-up).
 *
 * Runs the real script with a fake `openclaw` binary on PATH, so the gateway
 * stop/reinstall/start sequence executes for real without touching an actual gateway.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(import.meta.dirname, "..", "..", "..", "scripts", "post-upgrade.sh");

function writeFakeBin(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("scripts/post-upgrade.sh (#2130, #2134 QA follow-up)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "post-upgrade-"));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const openclawHome = join(tmp, "oc-home");
    const pluginDir = join(openclawHome, "extensions", "openclaw-hybrid-memory");
    mkdirSync(pluginDir, { recursive: true });
    const gatewayLog = join(tmp, "gateway.log");
    writeFileSync(gatewayLog, "");

    writeFakeBin(
      bin,
      "openclaw",
      `if [ "$1" = "gateway" ] && [ "$2" = "stop" ]; then echo "stop" >>"${gatewayLog}"; exit 0; fi
if [ "$1" = "gateway" ] && [ "$2" = "start" ]; then echo "start" >>"${gatewayLog}"; exit 0; fi
echo "fake openclaw: unexpected args: $*" >&2
exit 2`,
    );

    return { bin, openclawHome, pluginDir, gatewayLog };
  }

  it("restarts the gateway on a successful npm install", () => {
    const { bin, openclawHome, gatewayLog } = setup();
    writeFakeBin(bin, "npm", `if [ "$1" = "install" ]; then exit 0; fi\nexit 2`);

    const result = spawnSync("bash", [SCRIPT_PATH], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: openclawHome },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(gatewayLog, "utf-8").trim().split("\n")).toEqual(["stop", "start"]);
  });

  it("still restarts the gateway when npm install fails, instead of leaving it stopped indefinitely (#2134 QA follow-up)", () => {
    const { bin, openclawHome, gatewayLog } = setup();
    writeFakeBin(
      bin,
      "npm",
      `if [ "$1" = "install" ]; then echo "simulated npm install failure" >&2; exit 1; fi\nexit 2`,
    );

    const result = spawnSync("bash", [SCRIPT_PATH], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: openclawHome },
    });

    expect(result.status).not.toBe(0);
    // The gateway must have been both stopped AND restarted, not left stopped.
    expect(readFileSync(gatewayLog, "utf-8").trim().split("\n")).toEqual(["stop", "start"]);
  });
});
