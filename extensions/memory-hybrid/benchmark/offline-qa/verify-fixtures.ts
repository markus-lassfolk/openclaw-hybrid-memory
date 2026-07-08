#!/usr/bin/env node
/**
 * Verify offline QA fixtures against full run-all requirements.
 *
 * Usage:
 *   npm run offline-qa:verify
 *   npm run offline-qa:verify -- --sandbox   # also check sandbox layout
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_SPECS,
  OFFLINE_QA_SUBSET_STEPS,
  RUN_ALL_STEPS,
  type FixtureSpec,
  type FixtureTier,
} from "./fixture-requirements.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "../..");
const QA_ROOT = join(PLUGIN_ROOT, ".offline-qa");
const RAW = join(QA_ROOT, "raw");
const SANDBOX = join(QA_ROOT, "sandbox");

type CheckResult = {
  spec: FixtureSpec;
  present: boolean;
  bytes?: number;
  sandboxPresent?: boolean;
};

/** True when `memDir` exists and contains at least one YYYY-MM-DD.md daily log file. */
export function sandboxHasDailyLogs(memDir: string): boolean {
  return existsSync(memDir) && readdirSync(memDir).some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
}

function existsPath(base: string, rel: string): { ok: boolean; bytes?: number } {
  const p = join(base, rel);
  if (!existsSync(p)) return { ok: false };
  const st = statSync(p);
  return { ok: true, bytes: st.isDirectory() ? undefined : st.size };
}

function countSessions(base: string): number {
  const agents = join(base, ".openclaw/agents");
  if (!existsSync(agents)) {
    const sessionsRoot = join(base, "sessions");
    if (!existsSync(sessionsRoot)) return 0;
    let n = 0;
    for (const agent of readdirSync(sessionsRoot)) {
      const dir = join(sessionsRoot, agent);
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(".jsonl")) n++;
        }
      } catch {
        /* skip */
      }
    }
    return n;
  }
  let n = 0;
  for (const agent of readdirSync(agents)) {
    const dir = join(agents, agent, "sessions");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".jsonl")) n++;
    }
  }
  return n;
}

function countDailyLogs(base: string, rel: string): number {
  const dir = join(base, rel);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).length;
}

function main(): void {
  const checkSandbox = process.argv.includes("--sandbox");
  const tiers: FixtureTier[] = ["required", "recommended", "optional", "forbidden"];

  console.log("# Offline QA fixture verification\n");
  console.log(`Raw:     ${RAW}`);
  if (checkSandbox) console.log(`Sandbox: ${SANDBOX}`);
  console.log("");

  const results: CheckResult[] = [];
  for (const spec of FIXTURE_SPECS) {
    if (spec.id === "daily-logs-memory-dir") {
      const memDir = join(RAW, "memory/daily-logs");
      const wsDir = join(RAW, "workspace/memory");
      const count = countDailyLogs(RAW, "memory/daily-logs") + countDailyLogs(RAW, "workspace/memory");
      const present = count > 0 || existsPath(RAW, "workspace/memory").ok;
      results.push({
        spec,
        present,
        sandboxPresent: checkSandbox ? sandboxHasDailyLogs(join(SANDBOX, ".openclaw/memory")) : undefined,
      });
      continue;
    }
    const raw = existsPath(RAW, spec.rawPath);
    const sandbox = checkSandbox && spec.sandboxPath ? existsPath(SANDBOX, spec.sandboxPath) : undefined;
    results.push({
      spec,
      present: raw.ok,
      bytes: raw.bytes,
      sandboxPresent: sandbox?.ok,
    });
  }

  for (const tier of tiers) {
    const items = results.filter((r) => r.spec.tier === tier);
    if (items.length === 0) continue;
    console.log(`## ${tier.toUpperCase()}\n`);
    for (const r of items) {
      const icon = r.spec.tier === "forbidden" ? (r.present ? "⛔ LEAK" : "✓ absent") : r.present ? "✓" : "✗";
      const size = r.bytes !== undefined ? ` (${formatBytes(r.bytes)})` : "";
      const sb = checkSandbox && r.spec.sandboxPath ? (r.sandboxPresent ? " [sandbox ✓]" : " [sandbox ✗]") : "";
      console.log(`${icon} ${r.spec.id}${size}${sb}`);
      console.log(`    path: raw/${r.spec.rawPath}`);
      console.log(`    used by: ${r.spec.usedBy.join(", ")}`);
      if (r.spec.notes) console.log(`    note: ${r.spec.notes}`);
    }
    console.log("");
  }

  const sessionCountRaw = countSessions(RAW);
  const sessionCountSandbox = checkSandbox ? countSessions(SANDBOX) : sessionCountRaw;
  console.log("## Sessions\n");
  console.log(`  raw agents: ${listAgents(RAW)}`);
  console.log(`  session JSONL files: ${sessionCountRaw}${checkSandbox ? ` (sandbox: ${sessionCountSandbox})` : ""}`);
  console.log("");

  const requiredMissing = results.filter((r) => r.spec.tier === "required" && !r.present);
  const recommendedMissing = results.filter((r) => r.spec.tier === "recommended" && !r.present);
  const forbiddenPresent = results.filter((r) => r.spec.tier === "forbidden" && r.present);

  console.log("## Full run-all coverage\n");
  console.log(`  Steps in run-all: ${RUN_ALL_STEPS.length}`);
  console.log(`  Steps in offline-qa subset runner: ${OFFLINE_QA_SUBSET_STEPS.length}`);
  console.log(`  Missing for full run-all via openclaw: use \`openclaw hybrid-mem run-all\` after fixing gaps below`);
  console.log("");

  console.log("## Summary\n");
  if (requiredMissing.length === 0) {
    console.log("✓ All REQUIRED fixtures present in raw/");
  } else {
    console.log(`✗ Missing REQUIRED (${requiredMissing.length}):`);
    for (const r of requiredMissing) console.log(`  - ${r.spec.id} (${r.spec.rawPath})`);
  }
  if (recommendedMissing.length > 0) {
    console.log(`⚠ Missing RECOMMENDED (${recommendedMissing.length}):`);
    for (const r of recommendedMissing) console.log(`  - ${r.spec.id}`);
  }
  if (forbiddenPresent.length > 0) {
    console.log(`⛔ FORBIDDEN files present — remove before committing:`);
    for (const r of forbiddenPresent) console.log(`  - ${r.spec.rawPath}`);
  }

  const dailyInMemory = checkSandbox && sandboxHasDailyLogs(join(SANDBOX, ".openclaw/memory"));
  if (!dailyInMemory && checkSandbox) {
    console.log(
      "⚠ extract-daily: no YYYY-MM-DD.md in sandbox .openclaw/memory/ (needs setup copy from workspace/memory)",
    );
  }

  process.exit(requiredMissing.length > 0 || forbiddenPresent.length > 0 ? 1 : 0);
}

function listAgents(base: string): string {
  const sessions = join(base, "sessions");
  if (!existsSync(sessions)) return "(none)";
  return readdirSync(sessions).join(", ");
}

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
