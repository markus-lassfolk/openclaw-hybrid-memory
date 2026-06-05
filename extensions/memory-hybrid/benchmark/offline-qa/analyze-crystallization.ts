#!/usr/bin/env node
/**
 * Offline QA: assess workflow crystallization on Maeve session data.
 *
 * Usage (from extensions/memory-hybrid):
 *   HOME=.offline-qa/sandbox-work npm run offline-qa:crystallization
 *   HOME=.offline-qa/sandbox-work npm run offline-qa:crystallization -- --days=14
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { formatDateUtc, nowIso } from "../../utils/dates.js";
import { CrystallizationStore } from "../../backends/crystallization-store.js";
import { WorkflowStore } from "../../backends/workflow-store.js";
import { hybridConfigSchema } from "../../config.js";
import { getSessionFilePathsSince } from "../../cli/cmd-extract-sessions.js";
import { resolveExtractSessionFilePaths } from "../../services/extract-session-paths.js";
import {
  buildMaintenanceCoverageReport,
  formatMaintenanceCoverageReport,
} from "../../services/maintenance-coverage.js";
import { detectCrystallizationCandidates } from "../../services/pattern-detector.js";
import { GeneratedSkillValidationService } from "../../services/generated-skill-validation.js";
import { crystallizeSkill } from "../../services/skill-crystallizer.js";
import {
  extractUserWorkflowGoal,
  isSystemWorkflowGoal,
  patternHasUserFacingGoal,
} from "../../services/workflow-goal-classifier.js";
import { inferWorkflowOutcomeFromMessages } from "../../services/workflow-message-utils.js";
import type { CrystallizationConfig } from "../../config/types/features.js";
import type { WorkflowPattern } from "../../backends/workflow-store.js";
import { parseSessionMessagesFromLines } from "../../services/session-signal-context.js";
import { collectWorkflowToolsFromSessionFile } from "../../services/session-v3-parser.js";
import {
  countUsefulnessBuckets,
  pickCrystallizationVerdict,
} from "./crystallization-verdict.js";
import { redactMaintenancePrivateText } from "../../utils/maintenance-privacy.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultHome = join(here, "../../.offline-qa/sandbox-work");
const home = process.env.HOME ?? homedir();
const days = Number.parseInt(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "14", 10);
const outPath =
  process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ??
  join(here, "../../.offline-qa/crystallization-analysis.md");

const PROD_CFG: CrystallizationConfig = {
  enabled: true,
  minUsageCount: 5,
  minSuccessRate: 0.7,
  autoApprove: false,
  outputDir: join(home, ".openclaw/workspace/skills/auto"),
  maxCrystallized: 50,
  pruneUnusedDays: 30,
  maxPendingProposals: 100,
  evidenceCountBucketSize: 5,
  placeholderEmailDomains: ["example.com", "localhost", "test.com", "example.org"],
  excludeSystemGoals: true,
};

const STRUCTURAL_CFG: CrystallizationConfig = {
  ...PROD_CFG,
  minSuccessRate: 0,
  minUsageCount: 3,
  excludeSystemGoals: false,
};

const USER_FACING_CFG: CrystallizationConfig = {
  ...PROD_CFG,
  minSuccessRate: 0,
  minUsageCount: 3,
  excludeSystemGoals: true,
};

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function utcDay(ms: number): string {
  return formatDateUtc(Math.floor(ms / 1000));
}

function sessionDaysHistogram(paths: string[]): Map<string, number> {
  const hist = new Map<string, number>();
  for (const p of paths) {
    try {
      const day = utcDay(statSync(p).mtimeMs);
      hist.set(day, (hist.get(day) ?? 0) + 1);
    } catch {
      // skip
    }
  }
  return hist;
}

function detectSessionGaps(hist: Map<string, number>, windowDays: number): string[] {
  const gaps: string[] = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = formatDateUtc(Math.floor(d.getTime() / 1000));
    if ((hist.get(key) ?? 0) === 0) gaps.push(key);
  }
  return gaps;
}

function backfillWorkflowTraces(wf: WorkflowStore, paths: string[]): {
  traces: number;
  skipped: number;
  noTools: number;
  skippedSystemGoals: number;
} {
  let traces = 0;
  let skipped = 0;
  let noTools = 0;
  let skippedSystemGoals = 0;
  for (const p of paths) {
    const rawLines = readFileSync(p, "utf-8").split("\n");
    const messages = parseSessionMessagesFromLines(rawLines, "crystallization-qa");
    const tools = collectWorkflowToolsFromSessionFile(p, "crystallization-qa");
    if (tools.length < 2) {
      noTools++;
      continue;
    }
    const goal = redactMaintenancePrivateText(
      extractUserWorkflowGoal(messages, PROD_CFG.excludeGoalPatterns),
    );
    if (isSystemWorkflowGoal(goal, PROD_CFG.excludeGoalPatterns)) {
      skippedSystemGoals++;
      continue;
    }
    const inserted = wf.recordBackfillIfAbsent({
      goal,
      toolSequence: tools,
      outcome: inferWorkflowOutcomeFromMessages(messages),
      sessionId: basename(p),
    });
    if (inserted) traces++;
    else skipped++;
  }
  return { traces, skipped, noTools, skippedSystemGoals };
}

function outcomeBreakdown(wfPath: string): Record<string, number> {
  const db = new DatabaseSync(wfPath);
  try {
    const rows = db
      .prepare(`SELECT outcome, COUNT(*) AS cnt FROM workflow_traces GROUP BY outcome ORDER BY cnt DESC`)
      .all() as Array<{ outcome: string; cnt: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.outcome] = r.cnt;
    return out;
  } finally {
    db.close();
  }
}

function topPatterns(wf: WorkflowStore, minSuccessRate: number, minUsage: number, limit = 15): WorkflowPattern[] {
  return wf
    .getPatterns({
      minSuccessRate,
      traceSampleLimit: 8000,
      limit: 200,
    })
    .filter((p) => p.totalCount >= minUsage);
}

function isCronOrSystemGoal(goal: string): boolean {
  return isSystemWorkflowGoal(goal);
}

function assessUsefulness(
  pattern: WorkflowPattern,
  validation: ReturnType<GeneratedSkillValidationService["validate"]>,
): string {
  const goals = pattern.exampleGoals.filter((g) => g.trim().length > 8);
  const userGoals = goals.filter((g) => !isCronOrSystemGoal(g));

  if (validation.approvalDecision === "deny") return "garbage — validation denied";
  if (!patternHasUserFacingGoal(pattern.exampleGoals)) return "garbage — cron/system prompt patterns only";
  if (pattern.toolSequence.length === 1) return "weak — single-tool pattern";
  if (userGoals.length === 0 && pattern.exampleGoals.every((g) => g.length < 12))
    return "weak — goals too terse/generic";
  if (userGoals.length === 0) return "mediocre — repeatable but not user-facing workflows";
  if (validation.overallStatus === "passed" && userGoals.length >= 1)
    return "potentially useful — user-facing goals + validation pass";
  if (validation.overallStatus === "warn") return "borderline — validation warnings";
  return "unclear — review manually";
}

async function main(): Promise<void> {
  const cfgPath = join(home, ".openclaw/openclaw.json");
  const root = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
    plugins: { entries: Record<string, { config: unknown }> };
  };
  const cfg = hybridConfigSchema.parse(root.plugins.entries["openclaw-hybrid-memory"].config);
  const manifestPath = join(here, "../../.offline-qa/manifest.json");
  let manifestFetchedAt = "(unknown)";
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { fetchedAt?: string };
    manifestFetchedAt = manifest.fetchedAt ?? manifestFetchedAt;
  } catch {
    // optional
  }

  const sessionPaths = resolveExtractSessionFilePaths(cfg, days);
  const hist = sessionDaysHistogram(sessionPaths);
  const gaps = detectSessionGaps(hist, days);
  const coverage = buildMaintenanceCoverageReport({
    factsDbPath: join(home, ".openclaw/memory/facts.db"),
    workflowDbPath: join(home, ".openclaw/memory/workflow-traces.db"),
    proposalsDbPath: join(home, ".openclaw/memory/proposals.db"),
    days,
  });

  const qaTmp = mkdtempSync(join(here, "../../.offline-qa/.crystallization-qa-"));
  const wfPath = join(qaTmp, "workflow-traces.db");
  const propPath = join(qaTmp, "crystallization-proposals.db");
  const skillsOut = join(qaTmp, "skills-auto");
  mkdirSync(skillsOut, { recursive: true });

  const wf = new WorkflowStore(wfPath);
  const backfill = backfillWorkflowTraces(wf, sessionPaths);
  const outcomes = outcomeBreakdown(wfPath);
  const sampleUserGoals = wf
    .list({ limit: 50 })
    .filter((t) => !isSystemWorkflowGoal(t.goal, PROD_CFG.excludeGoalPatterns))
    .map((t) => t.goal)
    .slice(0, 8);

  const prodPatterns = topPatterns(wf, PROD_CFG.minSuccessRate, PROD_CFG.minUsageCount);
  const structuralPatterns = topPatterns(wf, 0, STRUCTURAL_CFG.minUsageCount);

  const crystStore = new CrystallizationStore(propPath);
  const prodCandidates = detectCrystallizationCandidates(wf, crystStore, PROD_CFG);
  const structuralCandidates = detectCrystallizationCandidates(wf, crystStore, STRUCTURAL_CFG);
  const userFacingCandidates = detectCrystallizationCandidates(wf, crystStore, USER_FACING_CFG);

  const validator = new GeneratedSkillValidationService();
  const structuralCfgForGen: CrystallizationConfig = { ...STRUCTURAL_CFG, outputDir: skillsOut };
  const samples = structuralCandidates.slice(0, 12).map((c) => {
    const generated = crystallizeSkill(
      { patternId: c.patternId, evidenceHash: c.evidenceHash, pattern: c.pattern },
      structuralCfgForGen,
    );
    const validation = validator.validate({
      outputDir: skillsOut,
      proposedOutputPath: generated.proposedOutputPath,
      skillName: generated.skillName,
      skillContent: generated.skillContent,
      pattern: c.pattern,
    });
    return {
      skillName: generated.skillName,
      score: c.score,
      toolSequence: c.pattern.toolSequence.join(" → "),
      totalCount: c.pattern.totalCount,
      successRate: c.pattern.successRate,
      exampleGoals: c.pattern.exampleGoals.slice(0, 3),
      hasScript: generated.hasScript,
      validation: {
        overall: validation.overallStatus,
        approval: validation.approvalDecision,
        static: validation.staticValidation.status,
        dryLoad: validation.dryLoadValidation.status,
        activation: validation.syntheticActivationEval.status,
        activationScore: validation.syntheticActivationEval.score,
      },
      usefulness: assessUsefulness(c.pattern, validation),
    };
  });

  const validationSummary = {
    allow: samples.filter((s) => s.validation.approval === "allow").length,
    allowWithOverride: samples.filter((s) => s.validation.approval === "allow-with-override").length,
    deny: samples.filter((s) => s.validation.approval === "deny").length,
    passed: samples.filter((s) => s.validation.overall === "passed").length,
    warn: samples.filter((s) => s.validation.overall === "warn").length,
    failed: samples.filter((s) => s.validation.overall === "failed").length,
  };

  const usefulnessCounts = countUsefulnessBuckets(samples.map((s) => s.usefulness));

  const liveWfPath = join(home, ".openclaw/memory/workflow-traces.db");
  let liveWfStats: {
    total: number;
    sinceWindow: number;
    outcomes: Record<string, number>;
    systemGoalTraces: number;
  } | null = null;
  let liveProdCandidates = 0;
  let liveProdPatterns = 0;
  if (existsSync(liveWfPath)) {
    const db = new DatabaseSync(liveWfPath);
    try {
      const sinceMs = Date.now() - days * 86400 * 1000;
      const sinceIso = new Date(sinceMs).toISOString();
      const total = (db.prepare("SELECT COUNT(*) AS n FROM workflow_traces").get() as { n: number }).n;
      const sinceWindow = (
        db.prepare(`SELECT COUNT(*) AS n FROM workflow_traces WHERE created_at >= ?`).get(sinceIso) as { n: number }
      ).n;
      const rows = db
        .prepare(`SELECT outcome, COUNT(*) AS cnt FROM workflow_traces WHERE created_at >= ? GROUP BY outcome`)
        .all(sinceIso) as Array<{ outcome: string; cnt: number }>;
      const outcomes: Record<string, number> = {};
      for (const r of rows) outcomes[r.outcome] = r.cnt;
      liveWfStats = { total, sinceWindow, outcomes, systemGoalTraces: 0 };
    } finally {
      db.close();
    }
    const liveWf = new WorkflowStore(liveWfPath);
    const liveCryst = new CrystallizationStore(join(qaTmp, "live-crystallization-proposals.db"));
    try {
      const liveSummary = liveWf.summarizeGoalKinds({
        sinceSec: Math.floor(Date.now() / 1000) - days * 86400,
        excludeGoalPatterns: PROD_CFG.excludeGoalPatterns,
      });
      liveWfStats!.systemGoalTraces = liveSummary.systemGoals;
      liveProdPatterns = topPatterns(liveWf, PROD_CFG.minSuccessRate, PROD_CFG.minUsageCount).length;
      liveProdCandidates = detectCrystallizationCandidates(liveWf, liveCryst, PROD_CFG).length;
    } finally {
      liveWf.close();
      liveCryst.close();
    }
  }

  const dataGapOk = gaps.length <= 2;
  const unknownOutcomeShare =
    backfill.traces > 0 ? (outcomes.unknown ?? 0) / backfill.traces : 0;
  const verdict = pickCrystallizationVerdict({
    dataGapOk,
    liveProdCandidates,
    userFacingCandidates: userFacingCandidates.length,
    structuralCandidates: structuralCandidates.length,
    prodCandidates: prodCandidates.length,
    liveWfStats,
    unknownOutcomeShare,
    validationSummary,
    usefulnessCounts,
  });

  const lines: string[] = [
    `# Crystallization analysis (Maeve offline QA)`,
    ``,
    `Generated: ${nowIso()}`,
    `Sandbox HOME: ${home}`,
    `Manifest fetchedAt: ${manifestFetchedAt}`,
    `Window: last ${days} days`,
    ``,
    `## Verdict`,
    ``,
    `**${verdict}**`,
    ``,
    `## Data coverage`,
    ``,
    `- Session files in window: **${sessionPaths.length}**`,
    `- Session days with zero files: **${gaps.length}** ${gaps.length ? `(${gaps.join(", ")})` : ""}`,
    `- Data-gap gate (≤2 zero days): **${dataGapOk ? "PASS" : "FAIL"}**`,
    `- Sessions with <2 tools (no trace): **${backfill.noTools}**`,
    `- Sessions skipped (system/cron goals only): **${backfill.skippedSystemGoals}**`,
    `- Workflow traces backfilled (isolated DB): **${backfill.traces}** (skipped dupes: ${backfill.skipped})`,
    `- Trace outcomes (backfill isolated DB): ${
      Object.entries(outcomes)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(none)"
    }`,
    liveWfStats
      ? `- Live workflow-traces.db on sandbox: total=${liveWfStats.total}, last ${days}d=${liveWfStats.sinceWindow}, user-facing=${Math.max(0, liveWfStats.sinceWindow - liveWfStats.systemGoalTraces)}, system-goal=${liveWfStats.systemGoalTraces}, outcomes: ${Object.entries(liveWfStats.outcomes).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`
      : `- Live workflow-traces.db on sandbox: (not present — backfill-only analysis)`,
    `- Maeve config workflowTracking.enabled: **${cfg.workflowTracking.enabled}**`,
    `- Maeve config crystallization.enabled: **${cfg.crystallization.enabled}**`,
    ``,
    formatMaintenanceCoverageReport(coverage),
    ``,
    `### Sessions per UTC day`,
    ``,
    ...[...hist.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => `- ${day}: ${count}`),
    ``,
    `## Pattern detection`,
    ``,
    `- Production thresholds on session backfill DB: **${prodCandidates.length}** candidates, **${prodPatterns.length}** raw pattern clusters`,
    liveWfStats
      ? `- Production thresholds on live Maeve workflow-traces.db: **${liveProdCandidates}** candidates, **${liveProdPatterns}** raw pattern clusters`
      : `- Production thresholds on live Maeve workflow-traces.db: (no live DB)`,
    `- Structural dry-run (minUsage=${STRUCTURAL_CFG.minUsageCount}, all goals): **${structuralCandidates.length}** candidates, **${structuralPatterns.length}** raw pattern clusters`,
    `- User-facing only (excludeSystemGoals=true): **${userFacingCandidates.length}** candidates from session backfill`,
    ``,
  ];

  if (sampleUserGoals.length > 0) {
    lines.push(`### User-facing backfill goals (sample)`, ``);
    for (const g of sampleUserGoals) {
      lines.push(`- ${JSON.stringify(g.slice(0, 120))}`);
    }
    lines.push(``);
  }

  if (structuralPatterns.length > 0) {
    lines.push(`### Top structural patterns (by usage)`, ``);
    for (const p of structuralPatterns.slice(0, 10)) {
      lines.push(
        `- \`${p.toolSequence.join(" → ")}\` — count=${p.totalCount}, successRate=${(p.successRate * 100).toFixed(0)}%, goals: ${p.exampleGoals
          .slice(0, 2)
          .map((g) => JSON.stringify(g.slice(0, 60)))
          .join("; ")}`,
      );
    }
    lines.push(``);
  }

  lines.push(`## Sample generated skills (top ${samples.length} structural candidates)`, ``);
  if (samples.length === 0) {
    lines.push(`No candidates to crystallize in this window.`, ``);
  } else {
    lines.push(
      `Validation summary: allow=${validationSummary.allow}, allow-with-override=${validationSummary.allowWithOverride}, deny=${validationSummary.deny}; passed=${validationSummary.passed}, warn=${validationSummary.warn}, failed=${validationSummary.failed}`,
    );
    lines.push(
      `Usefulness buckets: ${Object.entries(usefulnessCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
      ``,
    );
    for (const s of samples) {
      lines.push(`### ${s.skillName}`);
      lines.push(`- Sequence: \`${s.toolSequence}\``);
      lines.push(
        `- Evidence: count=${s.totalCount}, successRate=${(s.successRate * 100).toFixed(0)}%, score=${s.score.toFixed(1)}`,
      );
      lines.push(`- Example goals: ${s.exampleGoals.map((g) => JSON.stringify(g.slice(0, 80))).join(", ")}`);
      lines.push(`- Exec script: ${s.hasScript ? "yes" : "no"}`);
      lines.push(
        `- Validation: ${s.validation.overall} / ${s.validation.approval} (static=${s.validation.static}, dryLoad=${s.validation.dryLoad}, activation=${s.validation.activation} score=${s.validation.activationScore})`,
      );
      lines.push(`- Assessment: **${s.usefulness}**`, ``);
    }
  }

  lines.push(`## Recommendations`, ``);
  let rec = 1;
  if (!cfg.workflowTracking.enabled) {
    lines.push(`${rec++}. Enable \`workflowTracking.enabled\` on Maeve so traces record success/failure instead of backfill-only inference.`);
  }
  if (liveWfStats && liveWfStats.systemGoalTraces > 0) {
    lines.push(
      `${rec++}. Purge legacy cron/system traces from live DB: \`openclaw hybrid-mem purge-workflow-system-traces --dry-run\` then apply (currently ${liveWfStats.systemGoalTraces} system-goal row(s)).`,
    );
  }
  if (backfill.traces < 20 || userFacingCandidates.length === 0) {
    lines.push(
      `${rec++}. Keep \`crystallization.enabled: false\`; only ${backfill.traces} user-facing backfill trace(s) in this window. Re-run after 2–4 weeks of live tracking.`,
    );
  }
  lines.push(
    `${rec++}. Preview production candidates anytime: \`openclaw hybrid-mem skills crystallize --dry-run\` (no proposals written).`,
  );
  if (dataGapOk && userFacingCandidates.length >= 3 && prodCandidates.length > 0) {
    lines.push(
      `${rec++}. Optional pilot: enable \`crystallization.enabled\` with \`autoApprove: false\` and review pending proposals for 1–2 weeks.`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${lines.join("\n")}\n`, "utf-8");
  log(`Wrote ${outPath}`);
  log(`Verdict: ${verdict}`);
  rmSync(qaTmp, { recursive: true, force: true });
}

main().catch(() => {
  console.error("offline-qa:crystallization failed");
  process.exit(1);
});
