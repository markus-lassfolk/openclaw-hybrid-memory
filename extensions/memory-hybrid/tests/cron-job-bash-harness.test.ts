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
    expect(bash).toContain('export HM_RUN_ID="$RUN_ID"');
    expect(bash).toContain('HM_VALIDATION_JSON="${DAY_DIR}/${HM_JOB}-${RUN_ID}.validation.json"');
    expect(bash).toContain('HM_SUMMARY="${DAY_DIR}/${HM_JOB}-${RUN_ID}.summary.json"');
    expect(bash).toContain('HM_REQUIRED_STEPS=("prune")');
    expect(bash).toContain('local step_ec="${PIPESTATUS[0]}"');
    expect(bash).toContain("failed(?:_[A-Za-z0-9_-]+)?");
    expect(bash).toContain('hm_step "prune" openclaw hybrid-mem prune --verbose');
    expect(bash).toContain('local timeout_raw="${STEP_TIMEOUT_SECONDS:-0}"');
    expect(bash).toContain('if [ "$timeout_secs" -gt 0 ]; then');
    expect(bash).toContain('timeout "$timeout_secs" "${cmd[@]}" 2>&1 | tee -a "$HM_LOG" "$step_output"');
    expect(bash).toContain("openclaw --version");
    expect(bash).toContain(
      'openclaw hybrid-mem validate-cron-exit --exit-path "$HM_EXIT" --log-path "$HM_LOG" --summary-path "$HM_SUMMARY" --required-steps',
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

  it("tells the agent what to do when no top-level exec tool is available (#1961 dead-end fix)", () => {
    const msg = buildHybridMemCronTaskMessage("sensor-sweep", {
      steps: [{ name: "t1", cmd: "openclaw hybrid-mem sensor-sweep --tier 1" }],
    });
    expect(msg).toContain("do NOT fall back to tool_call/ToolSearch even once");
    expect(msg).toContain("TOOLING_BLOCKED: <one-sentence reason>");
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

  it("records validate-cron-exit exit=2 in HM_EXIT for semantic-only failures", () => {
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
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "distill" ]; then
  echo "distill stored=5 sessions=3 batchFailures=2 semantic=partial"
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then
  echo '{"maintenanceStatus":"failed","semanticStatus":"degraded","recommendedExitCode":2}'
  exit 2
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "distill", cmd: "openclaw hybrid-mem distill --verbose" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: home },
    });

    expect(result.status).toBe(2);
    const exitDir = join(home, "logs", "cron-hybrid-mem");
    const exitPath = readdirSync(exitDir)
      .filter((name) => name.endsWith(".exit.txt"))
      .map((name) => join(exitDir, name))[0];
    expect(exitPath).toBeDefined();
    const exitContents = readFileSync(exitPath, "utf-8");
    expect(exitContents).toContain("validate-cron-exit exit=2 status=failed reason=maintenance_failed");
    expect(result.stdout + result.stderr).toContain("FAILED: nightly-memory-sweep");
  });

  it("treats semantic no-op status markers as failures when HYBRID_MEM_STRICT_SEMANTICS=1", () => {
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
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "reflect-meta" ]; then
  echo "Implicit-feedback collapse summary: scanned 10387, collapsed 0, status=no_changes"
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then
  echo '{"maintenanceStatus":"failed"}'
  exit 1
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("weekly-implicit-feedback-collapse", [
      { name: "reflect-meta-collapse", cmd: "openclaw hybrid-mem reflect-meta --collapse-implicit-feedback" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENCLAW_HOME: home,
        HYBRID_MEM_STRICT_SEMANTICS: "1",
      },
    });

    expect(result.status).toBe(2);
    const exitDir = join(home, "logs", "cron-hybrid-mem");
    const exitPath = readdirSync(exitDir)
      .filter((name) => name.endsWith(".exit.txt"))
      .map((name) => join(exitDir, name))[0];
    expect(exitPath).toBeDefined();
    const exitContents = readFileSync(exitPath, "utf-8");
    expect(exitContents).toContain("reflect-meta-collapse exit=2 status=failed reason=failed_semantic_no_changes");
    expect(result.stdout + result.stderr).toContain("FAILED: weekly-implicit-feedback-collapse");
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

  it("tolerates extract-daily exit=1 in nightly-memory-sweep and continues downstream steps", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "resolve-ran.txt");
    const exitCapture = join(tmp, "exit-captured.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "prune" ]; then
  echo "pruned"
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "extract-daily" ]; then
  echo "extract-daily failure simulation"
  exit 1
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "resolve-contradictions" ]; then
  echo "downstream-ran" > ${JSON.stringify(marker)}
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
  cp "$exit_path" ${JSON.stringify(exitCapture)}
  if grep -q "extract-daily exit=1" "$exit_path" && grep -q "resolve-contradictions exit=0" "$exit_path"; then
    echo '{"maintenanceStatus":"partial","failedSteps":["extract-daily"]}'
    exit 1
  fi
  echo '{"maintenanceStatus":"failed"}'
  exit 1
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "prune", cmd: "openclaw hybrid-mem prune --verbose" },
      { name: "extract-daily", cmd: "openclaw hybrid-mem extract-daily --days 7 --verbose" },
      { name: "resolve-contradictions", cmd: "openclaw hybrid-mem resolve-contradictions --auto --verbose" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: home },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(marker, "utf-8")).toContain("downstream-ran");
    const exitContents = readFileSync(exitCapture, "utf-8");
    expect(exitContents).toContain("extract-daily exit=1 status=failed reason=tolerated_extract_daily_exit_1");
    expect(exitContents).toContain("resolve-contradictions exit=0");
    const exitDir = join(home, "logs", "cron-hybrid-mem");
    const finalExitPath = readdirSync(exitDir)
      .filter((name) => name.endsWith(".exit.txt"))
      .map((name) => join(exitDir, name))[0];
    expect(finalExitPath).toBeDefined();
    const finalExitContents = readFileSync(finalExitPath, "utf-8");
    expect(finalExitContents).toContain("validate-cron-exit exit=1 status=failed reason=maintenance_partial");
    expect(result.stdout + result.stderr).toContain(
      "WARNING: nightly-memory-sweep tolerated extract-daily exit=1; continuing downstream steps, final status delegated to validate-cron-exit",
    );
    expect(result.stdout + result.stderr).toContain("PARTIAL: nightly-memory-sweep");
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

  it("captures bare status=failed from self-correction-run CLI output as step reason", () => {
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
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "self-correction-run" ]; then
  echo "Error: simulated first-batch LLM API failure status=failed"
  exit 1
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then
  echo '{"maintenanceStatus":"failed"}'
  exit 1
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

    expect(result.status).toBe(1);
    const exitDir = join(home, "logs", "cron-hybrid-mem");
    const exitPath = readdirSync(exitDir)
      .filter((name) => name.endsWith(".exit.txt"))
      .map((name) => join(exitDir, name))[0];
    expect(exitPath).toBeDefined();
    const exitContents = readFileSync(exitPath, "utf-8");
    expect(exitContents).toContain("self-correct exit=1 status=failed reason=failed");
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

  it("adds --force to distill when forced rerun env is enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "distill-args.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "distill" ]; then
  printf '%s\n' "$*" > ${JSON.stringify(marker)}
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"success"}'; exit 0; fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "distill", cmd: "openclaw hybrid-mem distill --days 1 --verbose" },
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
    expect(readFileSync(marker, "utf-8")).toContain("distill --days 1 --verbose --force");
  });

  it("adds --force to extract-daily when forced rerun env is enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "extract-daily-args.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "extract-daily" ]; then
  printf '%s\n' "$*" > ${JSON.stringify(marker)}
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"success"}'; exit 0; fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "extract-daily", cmd: "openclaw hybrid-mem extract-daily --days 7 --verbose" },
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
    expect(readFileSync(marker, "utf-8")).toContain("extract-daily --days 7 --verbose --force");
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

  it("adds --force to extract-daily when forced rerun env is enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const marker = join(tmp, "extract-daily-args.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "extract-daily" ]; then
  printf '%s\n' "$*" > ${JSON.stringify(marker)}
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"success"}'; exit 0; fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "extract-daily", cmd: "openclaw hybrid-mem extract-daily --days 7 --verbose" },
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
    expect(readFileSync(marker, "utf-8")).toContain("extract-daily --days 7 --verbose --force");
  });

  it("optional step failure does not abort subsequent steps (chain continues)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-cron-harness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "oc-home");
    spawnSync("mkdir", ["-p", bin, home]);
    const secondStepMarker = join(tmp, "second-step-ran.txt");
    const fakeOpenclaw = join(bin, "openclaw");
    writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "OpenClaw fake"; exit 0; fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "extract-daily" ]; then
  echo "extract-daily failed"
  exit 1
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "resolve-contradictions" ]; then
  echo "resolve-contradictions ran" > ${JSON.stringify(secondStepMarker)}
  exit 0
fi
if [ "\${1:-}" = "hybrid-mem" ] && [ "\${2:-}" = "validate-cron-exit" ]; then echo '{"maintenanceStatus":"partial"}'; exit 1; fi
echo "unexpected openclaw args: $*" >&2
exit 2
`,
    );
    chmodSync(fakeOpenclaw, 0o755);

    const bash = buildHybridMemCronBashBody("nightly-memory-sweep", [
      { name: "extract-daily", cmd: "openclaw hybrid-mem extract-daily --days 7 --verbose", optional: true },
      { name: "resolve-contradictions", cmd: "openclaw hybrid-mem resolve-contradictions --auto --verbose" },
    ]);
    const result = spawnSync("bash", ["-c", bash], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCLAW_HOME: home },
    });

    // Chain should NOT be aborted by the optional step failure; validate-cron-exit returns partial exit=1.
    expect(result.status).toBe(1);
    // The subsequent required step must have run.
    expect(readFileSync(secondStepMarker, "utf-8")).toContain("resolve-contradictions ran");
    // The failure must still be recorded in exit ledger for visibility.
    const exitDir = join(home, "logs", "cron-hybrid-mem");
    const exitPath = readdirSync(exitDir)
      .filter((name) => name.endsWith(".exit.txt"))
      .map((name) => join(exitDir, name))[0];
    expect(exitPath).toBeDefined();
    const exitContents = readFileSync(exitPath, "utf-8");
    expect(exitContents).toContain("extract-daily exit=1 status=failed");
    expect(exitContents).toContain("resolve-contradictions exit=0");
  });
});
