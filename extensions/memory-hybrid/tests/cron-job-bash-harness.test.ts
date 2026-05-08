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
    expect(bash).toContain('HM_LOG_BASE="$OW/logs/cron-hybrid-mem"');
    expect(bash).toContain('if [ -n "${OPENCLAW_HOME:-}" ]; then OW="$OPENCLAW_HOME"; else OW=~/.openclaw; fi');
    expect(bash).not.toContain("-u OPENCLAW_HOME");
    expect(bash).toContain('HM_EXIT="${HM_LOG_BASE}/${HM_JOB}-${RUN_ID}.exit.txt"');
    expect(bash).toContain('local ec="${PIPESTATUS[0]}"');
    expect(bash).toContain('hm_step "prune" openclaw hybrid-mem prune --verbose');
    expect(bash).toContain("openclaw --version");
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
  });
});
