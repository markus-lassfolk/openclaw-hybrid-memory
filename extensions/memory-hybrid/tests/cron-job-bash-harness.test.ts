import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HYBRID_MEM_CRON_ENV_SANITIZER_MARKER,
  buildHybridMemCronBashBody,
  buildHybridMemCronTaskMessage,
} from "../services/cron-job-bash-harness.js";

describe("cron-job-bash-harness", () => {
  it("buildHybridMemCronBashBody includes pipefail, logging paths, hm_step, and steps", () => {
    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "prune", cmd: "openclaw hybrid-mem prune --verbose" },
    ]);
    expect(bash).toContain("set -euo pipefail");
    expect(bash).toContain(HYBRID_MEM_CRON_ENV_SANITIZER_MARKER);
    expect(bash).toContain("env -u OPENCLAW_SKIP_HYBRID_MEMORY_CLI");
    expect(bash).toContain("-u OPENCLAW_HOME");
    expect(bash).toContain("-u OPENCLAW_CLI");
    expect(bash).toContain("-u OPENCLAW_SERVICE_KIND");
    expect(bash).toContain("-u OPENCLAW_SERVICE_MARKER");
    expect(bash).toContain('openclaw_bin="$(type -P openclaw)" || return 127');
    expect(bash).toContain('HM_LOG_BASE="$OW/logs/cron-hybrid-mem"');
    expect(bash).toContain('if [ -n "${OPENCLAW_HOME:-}" ]; then OW="$OPENCLAW_HOME"; else OW=~/.openclaw; fi');
    expect(bash).toContain('HM_EXIT="${HM_LOG_BASE}/${HM_JOB}-${RUN_ID}.exit.txt"');
    expect(bash).toContain('HM_REQUIRED_STEPS=("prune")');
    expect(bash).toContain('local ec="${PIPESTATUS[0]}"');
    expect(bash).toContain('hm_step "prune" openclaw hybrid-mem prune --verbose');
    expect(bash).toContain("openclaw --version");
    expect(bash).toContain(
      'openclaw hybrid-mem validate-cron-exit --exit-path "$HM_EXIT" --log-path "$HM_LOG" --required-steps',
    );
    expect(bash).toContain("trap 'ec=$?; trap - EXIT; hm_validate \"$ec\"; exit $?' EXIT");
  });

  it("buildHybridMemCronTaskMessage wraps bash and execution rules", () => {
    const msg = buildHybridMemCronTaskMessage("sensor-sweep", {
      preamble: "Preamble line.",
      steps: [{ name: "t1", cmd: "openclaw hybrid-mem sensor-sweep --tier 1" }],
    });
    expect(msg).toContain("Preamble line.");
    expect(msg).toContain("EXECUTION (durable logs + per-step exits)");
    expect(msg).toContain("```bash");
    expect(msg).toContain('hm_step "t1" openclaw hybrid-mem sensor-sweep --tier 1');
    expect(msg).toContain("The bash harness automatically runs `openclaw hybrid-mem validate-cron-exit`");
  });

  it("uses explicit required steps for validation while allowing skip variants", () => {
    const bash = buildHybridMemCronBashBody(
      "nightly-memory-sweep",
      [{ name: "distill-skipped", cmd: "bash -c 'echo disabled; exit 0'" }],
      ["distill"],
    );

    expect(bash).toContain('HM_REQUIRED_STEPS=("distill")');
    expect(bash).toContain('hm_step "distill-skipped" bash -c');
  });

  it("runs validate-cron-exit automatically and propagates missing required steps as non-zero", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    writeFileSync(join(tmp, "mkdir-placeholder"), "");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "validator-called.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "prune" ]; then echo "pruned"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then
  echo called > ${JSON.stringify(marker)}
  exit_path=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --exit-path) exit_path="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if grep -q "distill exit=0" "$exit_path"; then exit 0; fi
  echo '{"maintenanceStatus":"partial","missingSteps":["distill"]}'
  exit 1
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody(
      "nightly-memory-sweep",
      [{ name: "prune", cmd: "openclaw hybrid-mem prune --verbose" }],
      ["prune", "distill"],
    );
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: home },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(marker, "utf-8")).toContain("called");
    expect(result.stdout + result.stderr).toContain("validate-cron-exit");
  });

  it("runs validate-cron-exit automatically and keeps successful cron steps at exit zero", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "prune" ]; then echo "pruned"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"success"}'; exit 0; fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "prune", cmd: "openclaw hybrid-mem prune --verbose" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain('{"maintenanceStatus":"success"}');
  });
});
