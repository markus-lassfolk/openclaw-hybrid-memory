import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    expect(bash).not.toContain("-u OPENCLAW_HOME");
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
    expect(bash).toContain('local timeout_raw="${STEP_TIMEOUT_SECONDS:-0}"');
    expect(bash).toContain('if [ "$timeout_secs" -gt 0 ]; then');
    expect(bash).toContain('timeout "$timeout_secs" "${cmd[@]}" 2>&1 | tee -a "$HM_LOG" "$step_output"');
    expect(bash).toContain("openclaw --version");
    expect(bash).toContain(
      'openclaw hybrid-mem validate-cron-exit --exit-path "$HM_EXIT" --log-path "$HM_LOG" --required-steps',
    );
    expect(bash).toContain("trap 'ec=$?; trap - EXIT; hm_validate \"$ec\"; exit $?' EXIT");
    expect(bash).toContain("trap 'trap - TERM INT HUP QUIT; hm_validate 143; exit $?' TERM INT");
    expect(bash).toContain("trap 'trap - TERM INT HUP QUIT; hm_validate 129; exit $?' HUP");
    expect(bash).toContain("trap 'trap - TERM INT HUP QUIT; hm_validate 131; exit $?' QUIT");
    expect(bash).toContain("trap 'signal_during_validate=143' TERM INT");
    expect(bash).toContain("trap 'signal_during_validate=129' HUP");
    expect(bash).toContain("trap 'signal_during_validate=131' QUIT");
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

  it("lists sanitized required step names in the task message to match HM_EXIT labels", () => {
    const msg = buildHybridMemCronTaskMessage("job", {
      steps: [{ name: "step one", cmd: "echo ok" }],
    });
    expect(msg).toContain('required steps ["step_one"]');
    expect(msg).toContain('hm_step "step_one" echo ok');
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
    expect(result.stdout + result.stderr).toContain("PARTIAL: nightly-memory-sweep");
  });

  it("writes parseable validation ledger status values", () => {
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
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"partial"}'; exit 1; fi
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
    const exitDir = join(home, "logs", "cron-hybrid-mem");
    const exitPath = readdirSync(exitDir)
      .filter((name) => name.endsWith(".exit.txt"))
      .map((name) => join(exitDir, name))[0];
    expect(exitPath).toBeDefined();
    const exitContents = readFileSync(exitPath, "utf-8");
    expect(exitContents).toContain("validate-cron-exit exit=1 status=failed reason=maintenance_partial");
    expect(exitContents).not.toContain("status=partial");
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
    expect(result.stdout + result.stderr).toContain("SUCCESS: nightly-memory-sweep");
  });

  it("still writes HM_EXIT + runs validate-cron-exit when a required hm_step fails under errexit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "validator-called.txt");
    const exitCapture = join(tmp, "exit-captured.txt");
    const shouldNotRun = join(tmp, "unexpected-second-step.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "prune" ]; then
  echo "prune failed"
  exit 17
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "distill" ]; then
  echo ran > ${JSON.stringify(shouldNotRun)}
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then
  echo called > ${JSON.stringify(marker)}
  exit_path=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --exit-path) exit_path="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$exit_path" ${JSON.stringify(exitCapture)}
  echo '{"maintenanceStatus":"failed","failedSteps":["prune"]}'
  exit 1
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "prune", cmd: "openclaw hybrid-mem prune --verbose" },
      { name: "distill", cmd: "openclaw hybrid-mem distill --verbose" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: home },
    });

    expect(result.status).toBe(17);
    expect(readFileSync(marker, "utf-8")).toContain("called");
    const exitContents = readFileSync(exitCapture, "utf-8");
    expect(exitContents).toContain("prune exit=17 status=failed reason=nonzero_exit");
    expect(exitContents).not.toContain("distill");
    expect(result.stdout + result.stderr).not.toContain("distill --verbose");
    expect(() => readFileSync(shouldNotRun, "utf-8")).toThrow();
    expect(result.stdout + result.stderr).toContain("validate-cron-exit");
    expect(result.stdout + result.stderr).toContain("FAILED: nightly-memory-sweep");
  });

  it("records self-correction cooldown skips as status=skipped in HM_EXIT", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "exit-captured.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "self-correction-run" ]; then
  echo "Skipping self-correction-run: cooldown active. status=skipped_cooldown"
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then
  exit_path=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --exit-path) exit_path="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$exit_path" ${JSON.stringify(marker)}
  echo '{"maintenanceStatus":"skipped"}'
  exit 0
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-self-correction", [
      { name: "self-correct", cmd: "openclaw hybrid-mem self-correction-run" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: home },
    });

    expect(result.status).toBe(0);
    const exitContents = readFileSync(marker, "utf-8");
    expect(exitContents).toContain("self-correct exit=0 status=skipped reason=skipped_cooldown");
  });

  it("skips timeout wrapper when STEP_TIMEOUT_SECONDS=0", () => {
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
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENCLAW_HOME: home,
        STEP_TIMEOUT_SECONDS: "0",
      },
    });

    expect(result.status).toBe(0);
  });

  it("adds --force to guarded extraction commands when forced rerun env is enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "extract-procedures-args.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "extract-procedures" ]; then
  printf '%s\n' "$*" > ${JSON.stringify(marker)}
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"success"}'; exit 0; fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("weekly-extract-procedures", [
      { name: "extract-procedures", cmd: "openclaw hybrid-mem extract-procedures --days 7 --verbose" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENCLAW_HOME: home,
        HYBRID_MEM_CLI_JOB_GUARD_WINDOW_MS: "0",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(marker, "utf-8")).toContain("extract-procedures --days 7 --verbose --force");
  });

  it("does not add --force to reflection commands when forced rerun env is enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "reflect-args.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "reflect" ]; then
  printf '%s\n' "$*" > ${JSON.stringify(marker)}
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"success"}'; exit 0; fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("weekly-reflection", [
      { name: "reflect", cmd: "openclaw hybrid-mem reflect --verbose" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENCLAW_HOME: home,
        HYBRID_MEM_QA_FORCE: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(marker, "utf-8")).toContain("reflect --verbose");
    expect(readFileSync(marker, "utf-8")).not.toContain("--force");
  });
});
