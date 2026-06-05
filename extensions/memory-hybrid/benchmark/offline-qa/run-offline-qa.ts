#!/usr/bin/env node
/**
 * Offline QA orchestrator — run maintenance tasks against copied Maeve data.
 *
 * Usage:
 *   MINIMAX_API_KEY=... AZURE_OPENAI_API_KEY=... npm run offline-qa
 *   npm run offline-qa -- --skip-ab          # skip A/B matrix (LLM cost)
 *   npm run offline-qa -- --live             # write to work-copy DB (not raw)
 *   npm run offline-qa -- --setup            # re-run setup-sandbox.sh first
 *   npm run offline-qa -- --reuse-work       # skip clone; use sandbox-work
 *   npm run offline-qa -- --work-home PATH   # clone template to PATH for this run
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRunIdSlug } from "../../utils/dates.js";
import { hybridConfigSchema, resolveReflectionModelAndFallbacks, resolveReflectionThinkingMode } from "../../config.js";
import {
  runDistillForCli,
  runExtractReinforcementForCli,
  runSelfCorrectionRunForCli,
  type HandlerContext,
} from "../../cli/handlers.js";
import { detectCategory as detectCategoryUtil } from "../../services/capture-utils.js";
import {
  getCategoryDecisionRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
  getCategoryPreferenceRegex,
} from "../../utils/language-keywords.js";
import { closeOldDatabases, initializeDatabases } from "../../setup/init-databases.js";
import { runReflection } from "../../services/reflection.js";
import { loadCorpus, writeCorpusSnapshot } from "../ab-maintenance/corpus.js";
import { buildDecisionReport } from "../ab-maintenance/decide.js";
import type { AbRunResult } from "../ab-maintenance/types.js";
import { setEnv, getEnv } from "../../utils/env-manager.js";
import { spawnSync } from "../../utils/process-runner.js";
import type { QaPhaseResult, QaReport } from "./types.js";
import { loadOfflineQaSecrets } from "./load-secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "../..");
const QA_ROOT = join(PLUGIN_ROOT, ".offline-qa");
loadOfflineQaSecrets(QA_ROOT);
const RAW = join(QA_ROOT, "raw");
const SANDBOX_TEMPLATE = join(QA_ROOT, "sandbox");
const SANDBOX_WORK_DEFAULT = join(QA_ROOT, "sandbox-work");
const AB_FIXTURES = join(PLUGIN_ROOT, ".ab-fixtures");
const TIER_SNIPPET = join(__dirname, "../ab-maintenance/maeve-tier-snippet.json");

function parseArgs(argv: string[]): {
  skipAb: boolean;
  live: boolean;
  setup: boolean;
  verbose: boolean;
  reuseWork: boolean;
  workHome?: string;
} {
  const workHomeIdx = argv.indexOf("--work-home");
  return {
    skipAb: argv.includes("--skip-ab"),
    live: argv.includes("--live"),
    setup: argv.includes("--setup"),
    verbose: argv.includes("--verbose") || argv.includes("-v"),
    reuseWork: argv.includes("--reuse-work"),
    workHome: workHomeIdx >= 0 ? argv[workHomeIdx + 1] : undefined,
  };
}

function cloneSandbox(source: string, dest: string): void {
  console.log(`==> Cloning sandbox template → ${dest}`);
  mkdirSync(dest, { recursive: true });
  const r = spawnSync("rsync", ["-a", "--delete", `${source}/`, `${dest}/`], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`rsync clone failed with exit ${r.status}`);
  }
}

function runScript(script: string): void {
  const r = spawnSync("bash", [script], { stdio: "inherit", cwd: PLUGIN_ROOT });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function phase(name: string, fn: () => Promise<QaPhaseResult>): Promise<QaPhaseResult> {
  return fn().catch(
    (err): QaPhaseResult => ({
      name,
      ok: false,
      error: String(err),
      details: {},
    }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const timestamp = formatRunIdSlug();
  const outDir = join(QA_ROOT, "out", timestamp);
  mkdirSync(outDir, { recursive: true });

  const report: QaReport = {
    timestamp,
    live: args.live,
    phases: [],
    warnings: [],
  };

  if (args.setup || !existsSync(join(SANDBOX_TEMPLATE, ".openclaw/memory/facts.db"))) {
    console.log("==> Setting up sandbox template...");
    runScript(join(__dirname, "setup-sandbox.sh"));
  }

  let activeHome: string;
  if (args.reuseWork && !args.workHome) {
    if (!existsSync(join(SANDBOX_WORK_DEFAULT, ".openclaw/memory/facts.db"))) {
      runScript(join(__dirname, "clone-sandbox.sh"));
    }
    activeHome = SANDBOX_WORK_DEFAULT;
    report.warnings.push("Reusing sandbox-work without re-cloning — reset with npm run offline-qa:reset");
  } else {
    activeHome = args.workHome ?? join(outDir, "home");
    cloneSandbox(SANDBOX_TEMPLATE, activeHome);
  }

  // --- Preflight ---
  report.phases.push(
    await phase("preflight", async () => {
      const manifestPath = join(QA_ROOT, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error(`Missing ${manifestPath}. Run: bash benchmark/offline-qa/fetch-maeve-offline-qa.sh`);
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      const factsPath = join(activeHome, ".openclaw/memory/facts.db");
      if (!existsSync(factsPath)) {
        throw new Error(`Work copy facts.db missing at ${factsPath}`);
      }
      const sessionCount = countSessions(activeHome);
      if (sessionCount === 0) {
        report.warnings.push("No session JSONL in sandbox — distill/extract tasks will be empty.");
      }
      if (!getEnv("MINIMAX_API_KEY")?.trim()) {
        report.warnings.push("MINIMAX_API_KEY unset — A/B matrix and live LLM maintenance will be skipped.");
      }
      const embedKey = getEnv("AZURE_OPENAI_API_KEY")?.trim();
      if (!embedKey) {
        report.warnings.push("AZURE_OPENAI_API_KEY unset — embedding / vector store steps may fail.");
      }
      return {
        name: "preflight",
        ok: true,
        details: { manifest, sessionCount, factsDbBytes: statSync(factsPath).size, workHome: activeHome },
      };
    }),
  );

  // --- Corpus scan (no LLM) ---
  report.phases.push(
    await phase("corpus-scan", async () => {
      syncAbFixtures();
      const corpus = await loadCorpus(AB_FIXTURES, 40);
      const snapshotPath = join(AB_FIXTURES, "corpus-snapshot.json");
      writeCorpusSnapshot(corpus, snapshotPath);
      writeFileSync(join(outDir, "corpus-meta.json"), JSON.stringify(corpus.meta, null, 2));
      const lowSignal = corpus.meta.selfCorrectionIncidents < 3 && corpus.meta.reinforcementIncidents === 0;
      if (lowSignal) {
        report.warnings.push(
          `Low incident signal: SC=${corpus.meta.selfCorrectionIncidents} RE=${corpus.meta.reinforcementIncidents}. Consider fetching more session days.`,
        );
      }
      return {
        name: "corpus-scan",
        ok: true,
        details: corpus.meta,
      };
    }),
  );

  // --- A/B matrix (optional) ---
  if (!args.skipAb && getEnv("MINIMAX_API_KEY")?.trim()) {
    report.phases.push(
      await phase("ab-maintenance", async () => {
        console.log("==> Running A/B maintenance matrix (this calls MiniMax)...");
        const r = spawnSync("npm", ["run", "ab-maintenance"], {
          cwd: PLUGIN_ROOT,
          stdio: "inherit",
          env: { ...process.env, AB_REUSE_CORPUS: "1" },
        });
        if (r.status !== 0) {
          return { name: "ab-maintenance", ok: false, error: `exit ${r.status}`, details: {} };
        }
        const abOut = findLatestAbOut();
        let decisionSummary = "";
        if (abOut && existsSync(join(abOut, "metrics.json"))) {
          const metrics = JSON.parse(readFileSync(join(abOut, "metrics.json"), "utf-8")) as AbRunResult;
          decisionSummary = buildDecisionReport(metrics).summaryMd;
          writeFileSync(join(outDir, "ab-summary.md"), decisionSummary);
        }
        return {
          name: "ab-maintenance",
          ok: true,
          details: { abOutDir: abOut ?? null },
        };
      }),
    );
  }

  // --- Full maintenance tasks on work-copy DB ---
  const azureEmbedKey = getEnv("AZURE_OPENAI_API_KEY")?.trim();
  const minimaxKey = getEnv("MINIMAX_API_KEY")?.trim();
  if (azureEmbedKey || minimaxKey) {
    report.phases.push(
      await phase("maintenance-tasks", async () => {
        const memoryDir = join(activeHome, ".openclaw/memory");
        const workFacts = join(memoryDir, "facts.db");
        const workLance = join(memoryDir, "lancedb");

        const prevHome = getEnv("HOME");
        const prevUser = getEnv("USERPROFILE");
        setEnv("HOME", activeHome);
        setEnv("USERPROFILE", activeHome);

        let dbCtx: ReturnType<typeof initializeDatabases> | undefined;
        const taskResults: Record<string, unknown> = {};
        const dryRun = !args.live;
        const sink = {
          log: (s: string) => args.verbose && console.log(s),
          warn: (s: string) => console.warn(s),
        };

        try {
          const cfg = buildQaConfig(workFacts, workLance);
          const api = {
            resolvePath: (p: string) => (p.startsWith("/") ? p : join(activeHome, p.replace(/^\.\//, ""))),
            logger: { info: console.log, warn: console.warn, debug: () => {}, error: console.error },
            registerTool: () => {},
            registerService: () => {},
            registerCli: () => {},
            registerLifecycleHook: () => {},
            on: () => {},
            context: {},
            config: {},
          };
          dbCtx = initializeDatabases(cfg, api as never);
          const ctx: HandlerContext = {
            factsDb: dbCtx.factsDb,
            vectorDb: dbCtx.vectorDb,
            embeddings: dbCtx.embeddings,
            openai: dbCtx.openai,
            cfg,
            credentialsDb: null,
            aliasDb: dbCtx.aliasDb,
            wal: null,
            proposalsDb: null,
            identityReflectionStore: dbCtx.identityReflectionStore,
            personaStateStore: dbCtx.personaStateStore,
            crystallizationStore: dbCtx.crystallizationStore,
            resolvedSqlitePath: workFacts,
            resolvedLancePath: workLance,
            pluginId: "offline-qa",
            logger: { info: console.log, warn: console.warn },
            detectCategory: (text: string) =>
              detectCategoryUtil(
                text,
                getCategoryDecisionRegex(),
                getCategoryPreferenceRegex(),
                getCategoryEntityRegex(),
                getCategoryFactRegex(),
              ),
            costTracker: dbCtx.costTracker,
          };

          console.log(`==> Maintenance tasks (dryRun=${dryRun})...`);

          taskResults.distill = await runDistillForCli(
            ctx,
            { days: 3, dryRun, verbose: args.verbose, force: true },
            sink,
          );
          taskResults.extractReinforcement = await runExtractReinforcementForCli(ctx, {
            days: 7,
            dryRun,
            verbose: args.verbose,
            force: true,
          });
          taskResults.selfCorrection = await runSelfCorrectionRunForCli(ctx, {
            dryRun,
            force: true,
            verbose: args.verbose,
          });

          const reflectionModel = cfg.reflection?.model ?? cfg.llm?.default?.[0] ?? "minimax/MiniMax-M3";
          const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(
            cfg,
            "maintenance",
            reflectionModel,
          );
          taskResults.reflection = await runReflection(
            dbCtx.factsDb,
            dbCtx.vectorDb,
            dbCtx.embeddings,
            dbCtx.openai,
            {
              defaultWindow: cfg.reflection.defaultWindow,
              minObservations: cfg.reflection.minObservations,
              enabled: cfg.reflection.enabled,
            },
            {
              window: cfg.reflection?.defaultWindow ?? 7,
              dryRun,
              model: reflectionModel ?? defaultModel,
              verbose: args.verbose,
              fallbackModels,
              modelSource: "offline-qa",
              thinkingMode: resolveReflectionThinkingMode(cfg),
            },
            { info: console.log, warn: console.warn },
          );

          writeFileSync(join(outDir, "task-results.json"), JSON.stringify(taskResults, null, 2));

          const issues = collectTaskIssues(taskResults, dryRun);
          if (issues.length > 0) {
            report.warnings.push(...issues);
          }

          return {
            name: "maintenance-tasks",
            ok: !issues.some((i) => i.startsWith("ERROR:")),
            details: { dryRun, workHome: activeHome, taskSummary: summarizeTasks(taskResults) },
          };
        } finally {
          if (dbCtx) {
            try {
              closeOldDatabases(dbCtx);
            } catch {
              /* best effort */
            }
          }
          setEnv("HOME", prevHome);
          setEnv("USERPROFILE", prevUser);
        }
      }),
    );
  }

  // --- Optional: openclaw run-all dry-run via subprocess ---
  report.phases.push(
    await phase("openclaw-run-all", async () => {
      const openclaw = spawnSync("which", ["openclaw"], { encoding: "utf-8" });
      if (openclaw.status !== 0) {
        return {
          name: "openclaw-run-all",
          ok: true,
          details: { skipped: true, reason: "openclaw CLI not in PATH" },
        };
      }
      console.log(`==> openclaw hybrid-mem run-all --dry-run (HOME=${activeHome})...`);
      const nodeWrapper = join(PLUGIN_ROOT, "../../scripts/run-with-supported-node.mjs");
      const r = spawnSync(
        "node",
        [nodeWrapper, "openclaw", "hybrid-mem", "run-all", "--dry-run", ...(args.verbose ? ["-v"] : [])],
        {
          env: { ...process.env, HOME: activeHome, USERPROFILE: activeHome },
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          cwd: PLUGIN_ROOT,
        },
      );
      writeFileSync(join(outDir, "openclaw-run-all-dry.txt"), r.stdout + r.stderr);
      return {
        name: "openclaw-run-all",
        ok: r.status === 0,
        error: r.status !== 0 ? `exit ${r.status}` : undefined,
        details: { exitCode: r.status ?? -1, stdoutLines: r.stdout.split("\n").length },
      };
    }),
  );

  writeReport(outDir, report);
  printSummary(report, outDir);

  const failed = report.phases.filter((p) => !p.ok);
  process.exit(failed.length > 0 ? 1 : 0);
}

function buildQaConfig(workFacts: string, lancePath: string) {
  const snippet = existsSync(TIER_SNIPPET)
    ? (JSON.parse(readFileSync(TIER_SNIPPET, "utf-8")) as Record<string, unknown>)
    : {};
  const { _comment: _, ...tierFields } = snippet;
  const azureKey = getEnv("AZURE_OPENAI_API_KEY")?.trim() || "azure-offline-qa-placeholder-key-000000000000";
  const afBase =
    getEnv("AZURE_FOUNDRY_BASE_URL")?.trim() ||
    getEnv("AZURE_OPENAI_BASE_URL")?.trim() ||
    "https://rnd-api-gateway.azure-api.net/ai";
  return hybridConfigSchema.parse({
    embedding: {
      provider: "openai",
      model: "text-embedding-3-large",
    },
    sqlitePath: workFacts,
    lanceDbPath: lancePath,
    credentials: { enabled: false },
    wal: { enabled: false },
    personaProposals: { enabled: false },
    verification: { enabled: false },
    nightlyCycle: { enabled: false },
    provenance: { enabled: false },
    ...tierFields,
    llm: {
      ...(tierFields.llm as object | undefined),
      providers: {
        minimax: { apiKey: getEnv("MINIMAX_API_KEY")?.trim() ?? azureKey },
        "azure-foundry": { apiKey: azureKey, baseURL: afBase },
      },
    },
  });
}

function syncAbFixtures(): void {
  mkdirSync(join(AB_FIXTURES, "sessions"), { recursive: true });
  const rawSessions = join(RAW, "sessions");
  if (existsSync(rawSessions)) {
    spawnSync("rsync", ["-a", `${rawSessions}/`, join(AB_FIXTURES, "sessions/")], {
      stdio: "pipe",
    });
  }
  const sample = join(RAW, "facts-sample.json");
  if (existsSync(sample)) {
    copyFileSync(sample, join(AB_FIXTURES, "facts-sample.json"));
  }
}

function countSessions(sandboxHome: string): number {
  const agents = join(sandboxHome, ".openclaw/agents");
  if (!existsSync(agents)) return 0;
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

function findLatestAbOut(): string | null {
  const base = join(AB_FIXTURES, "out");
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).sort().reverse();
  return dirs[0] ? join(base, dirs[0]) : null;
}

function collectTaskIssues(results: Record<string, unknown>, dryRun: boolean): string[] {
  const issues: string[] = [];
  const distill = results.distill as { error?: string; sessionsScanned?: number } | undefined;
  if (distill?.error) issues.push(`ERROR: distill — ${distill.error}`);
  if (distill && (distill.sessionsScanned ?? 0) === 0) {
    issues.push("WARN: distill scanned 0 sessions");
  }
  const reinf = results.extractReinforcement as { error?: string; sessionsScanned?: number } | undefined;
  if (reinf?.error) issues.push(`ERROR: extract-reinforcement — ${reinf.error}`);
  const sc = results.selfCorrection as { error?: string; incidentsFound?: number } | undefined;
  if (sc?.error) issues.push(`ERROR: self-correction — ${sc.error}`);
  const refl = results.reflection as { patternsStored?: number; diagnostics?: { status?: string } } | undefined;
  if (refl?.diagnostics?.status === "error") {
    issues.push("ERROR: reflection returned error status");
  }
  if (!dryRun && (refl?.patternsStored ?? 0) === 0) {
    issues.push("WARN: reflection stored 0 patterns in live mode");
  }
  return issues;
}

function summarizeTasks(results: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const d = results.distill as { stored?: number; sessionsScanned?: number } | undefined;
  if (d) out.distill = `${d.stored ?? 0} stored / ${d.sessionsScanned ?? 0} sessions`;
  const r = results.extractReinforcement as { sessionsScanned?: number; incidentsExtracted?: number } | undefined;
  if (r) out.extractReinforcement = `${r.incidentsExtracted ?? 0} incidents / ${r.sessionsScanned ?? 0} sessions`;
  const s = results.selfCorrection as { incidentsFound?: number; analysed?: number } | undefined;
  if (s) out.selfCorrection = `${s.analysed ?? 0} analysed / ${s.incidentsFound ?? 0} found`;
  const rf = results.reflection as { patternsStored?: number } | undefined;
  if (rf) out.reflection = `${rf.patternsStored ?? 0} patterns`;
  return out;
}

function writeReport(outDir: string, report: QaReport): void {
  writeFileSync(join(outDir, "qa-report.json"), JSON.stringify(report, null, 2));
  const lines = [
    `# Offline QA Report — ${report.timestamp}`,
    "",
    `Live writes: ${report.live ? "yes (work copy only)" : "no (dry-run)"}`,
    "",
    "## Phases",
    "",
    ...report.phases.map((p) => `- **${p.name}**: ${p.ok ? "OK" : "FAIL"}${p.error ? ` — ${p.error}` : ""}`),
    "",
  ];
  if (report.warnings.length > 0) {
    lines.push("## Warnings", "", ...report.warnings.map((w) => `- ${w}`), "");
  }
  const maint = report.phases.find((p) => p.name === "maintenance-tasks");
  if (maint?.details?.taskSummary) {
    lines.push("## Task summary", "", "```json", JSON.stringify(maint.details.taskSummary, null, 2), "```", "");
  }
  writeFileSync(join(outDir, "qa-report.md"), lines.join("\n"));
}

function printSummary(report: QaReport, outDir: string): void {
  console.log("\n==> Offline QA complete");
  console.log(`    Report: ${outDir}/qa-report.md`);
  for (const p of report.phases) {
    console.log(`    ${p.ok ? "✓" : "✗"} ${p.name}${p.error ? `: ${p.error}` : ""}`);
  }
  if (report.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
