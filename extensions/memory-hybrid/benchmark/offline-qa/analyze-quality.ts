/**
 * Post-run quality review — inspect DB artifacts and task logs beyond exit codes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { quickValidateSkillMarkdown } from "../../services/skill-creator-validator.js";
import { SkillValidator } from "../../services/skill-validator.js";

export type QualityVerdict = "good" | "acceptable" | "weak" | "failed" | "n/a";

export type TaskQualityReview = {
  taskId: string;
  verdict: QualityVerdict;
  summary: string;
  findings: string[];
  samples: string[];
};

export type QualityReport = {
  generatedAt: string;
  workHome: string;
  tasks: TaskQualityReview[];
  blockers: string[];
};

const PRIVATE_PATH_RE = /\/home\/markus\/|192\.168\.|@[a-z0-9.-]+\.[a-z]{2,}/i;
const ABSOLUTE_PATH_RE = /\/(?:home|Users|tmp|var)\/[^\s]+/;

function readLog(logPath: string | undefined): string {
  if (!logPath || !existsSync(logPath)) return "";
  return readFileSync(logPath, "utf-8");
}

function sqlQuery(dbPath: string, sql: string): string[][] {
  if (!existsSync(dbPath)) return [];
  const r = spawnSync("sqlite3", ["-separator", "\t", dbPath, sql], { encoding: "utf-8" });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
}

function reviewDistill(workHome: string, log: string): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const extracted = log.match(/(\d+) extracted from (\d+) sessions/i);
  const stored = log.match(/Distill done: (\d+) stored/i);
  const extractN = extracted ? Number.parseInt(extracted[1], 10) : 0;
  const storeN = stored ? Number.parseInt(stored[1], 10) : 0;
  const embed401 = /401 status code|distill store failed/i.test(log);

  if (embed401 && extractN > 0 && storeN === 0) {
    findings.push(`LLM extracted ${extractN} facts but embedding 401 blocked all stores — not production-ready`);
  } else if (storeN === 0 && extractN === 0) {
    findings.push("No facts extracted — check session window or distill cursor");
  } else if (storeN > 0) {
    findings.push(`Stored ${storeN} of ${extractN} extracted facts`);
  }

  const db = join(workHome, ".openclaw/memory/facts.db");
  const rows = sqlQuery(
    db,
    `SELECT substr(text,1,120), category FROM facts
     WHERE superseded_at IS NULL AND source LIKE '%distill%'
     ORDER BY created_at DESC LIMIT 8`,
  );
  if (rows.length === 0 && storeN > 0) {
    rows.push(
      ...sqlQuery(
        db,
        `SELECT substr(text,1,120), category FROM facts
         ORDER BY created_at DESC LIMIT 8`,
      ),
    );
  }
  for (const [text, cat] of rows) {
    samples.push(`[${cat}] ${text}`);
    if (PRIVATE_PATH_RE.test(text ?? "")) findings.push(`Private path/email in stored fact: ${text?.slice(0, 60)}…`);
    if ((text ?? "").length < 25) findings.push(`Very short fact (${(text ?? "").length} chars): ${text}`);
  }

  let verdict: QualityVerdict = "n/a";
  if (embed401 && storeN === 0 && extractN > 0) verdict = "failed";
  else if (storeN >= 10 && findings.filter((f) => f.includes("Private")).length === 0) verdict = "good";
  else if (storeN > 0) verdict = "acceptable";
  else if (extractN > 0) verdict = "weak";
  else verdict = "n/a";

  return {
    taskId: "distill",
    verdict,
    summary:
      verdict === "failed"
        ? "Extraction OK but vector store failed — memories not persisted"
        : storeN > 0
          ? `${storeN} facts stored; review samples for specificity and privacy`
          : "No durable distill output",
    findings,
    samples,
  };
}

function reviewReflection(taskId: string, log: string, kind: "reflect" | "meta" | "rules"): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const disabled = /reflection — \d+ facts in window \(min|reflection is disabled|input facts unchanged/i.test(log);
  const embedFail = /embed failure|401 status code|embedding check failed/i.test(log);
  const metaLines = [...log.matchAll(/^\[plugins\]\s+META:\s*(.+)$/gm)].map((m) => m[1].trim());
  const patternLines = [...log.matchAll(/^\[plugins\]\s+PATTERN:\s*(.+)$/gm)].map((m) => m[1].trim());

  for (const line of [...metaLines, ...patternLines].slice(0, 5)) {
    samples.push(line);
    if (line.length < 40) findings.push(`Reflection output too terse (${line.length} chars)`);
    if (line.length > 400) findings.push("Reflection output very long — may be noisy for recall");
    if (ABSOLUTE_PATH_RE.test(line)) findings.push("Absolute path in reflection text");
  }

  const stored =
    log.match(/stored (\d+)/i)?.[1] ??
    log.match(/stored (\d+) meta/i)?.[1] ??
    log.match(/stored (\d+) pattern/i)?.[1];
  const storeN = stored ? Number.parseInt(stored, 10) : 0;
  const analyzed = log.match(/analyzed (\d+) facts/i)?.[1];
  const analyzedN = analyzed ? Number.parseInt(analyzed, 10) : 0;

  if (disabled && analyzedN === 0) findings.push("Reflection skipped (disabled, unchanged input, or below minObservations)");
  if (embedFail && storeN === 0 && (metaLines.length > 0 || patternLines.length > 0)) {
    findings.push("LLM produced reflection candidates but embedding failures prevented storage");
  }
  if (analyzedN > 0 && storeN === 0 && !embedFail && !disabled) {
    findings.push("Facts analyzed but nothing stored — check dedupe gates or parse quality");
  }

  let verdict: QualityVerdict = "n/a";
  if (embedFail && (metaLines.length > 0 || patternLines.length > 0) && storeN === 0) verdict = "failed";
  else if (storeN >= 1 && samples.length > 0) verdict = metaLines.length > 0 || patternLines.length > 0 ? "good" : "acceptable";
  else if (samples.length > 0) verdict = "weak";
  else if (disabled) verdict = "n/a";
  else verdict = "weak";

  return {
    taskId,
    verdict,
    summary:
      verdict === "good"
        ? `${storeN} stored; meta/pattern text looks substantive`
        : verdict === "failed"
          ? "Reflection LLM OK but storage failed"
          : analyzedN > 0
            ? `Analyzed ${analyzedN} facts, stored ${storeN}`
            : "No reflection output this run",
    findings,
    samples,
  };
}

function reviewIdentity(log: string): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const stored = Number.parseInt(log.match(/stored (\d+)/i)?.[1] ?? "0", 10);
  const keys = [...log.matchAll(/stored (\w+) \(durable, conf=([\d.]+)\)/g)];
  for (const [, key, conf] of keys) {
    samples.push(`${key} (conf=${conf})`);
    if (Number.parseFloat(conf) < 0.7) findings.push(`Low-confidence insight: ${key} conf=${conf}`);
  }
  if (stored === 0) findings.push("No identity insights stored — check minInsights gate or reflection corpus");
  return {
    taskId: "reflect-identity",
    verdict: stored >= 3 ? "good" : stored > 0 ? "acceptable" : "weak",
    summary: stored > 0 ? `${stored} durable persona insights stored across question keys` : "No identity reflection output",
    findings,
    samples,
  };
}

function reviewSkills(workHome: string, log: string): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const deferred = [...log.matchAll(/deferred-for-human:\s*([^\s(]+)/g)].map((m) => m[1]);
  const drafted = Number.parseInt(log.match(/drafted=(\d+)/)?.[1] ?? "0", 10);
  const eligible = Number.parseInt(log.match(/eligible=(\d+)/)?.[1] ?? "0", 10);

  if (deferred.length) findings.push(`${deferred.length} procedure(s) deferred (expected for Maeve-local paths): ${deferred.join(", ")}`);
  if (eligible === 0 && drafted === 0) findings.push("No procedures passed promotion gates — skills correctly withheld");

  const skillsDir = join(workHome, ".openclaw/workspace/skills/auto");
  const validator = new SkillValidator();
  let validCount = 0;
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const skillMd = join(skillsDir, name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, "utf-8");
      const quick = quickValidateSkillMarkdown(content);
      const full = validator.validate(content);
      samples.push(`${name}: quick=${quick.valid} full=${full.valid}`);
      if (quick.valid && full.valid) validCount++;
      else findings.push(`${name}: ${[...quick.violations.map((v) => v.message), ...full.violations].slice(0, 2).join("; ")}`);
    }
  }

  const verdict: QualityVerdict =
    validCount > 0 ? "good" : deferred.length > 0 && drafted === 0 ? "acceptable" : drafted === 0 ? "n/a" : "weak";

  return {
    taskId: "generate-auto-skills",
    verdict,
    summary:
      validCount > 0
        ? `${validCount} skill(s) pass Skill Creator + validator checks`
        : "No skills promoted — safety gates blocked Maeve-local procedures (correct)",
    findings,
    samples,
  };
}

function reviewExtractDaily(log: string): TaskQualityReview {
  const findings: string[] = [];
  const extracted = Number.parseInt(log.match(/Extracted (\d+) new facts/i)?.[1] ?? "0", 10);
  const embed401 = /extract-daily vector store failed|401 status code/i.test(log);
  if (extracted > 0 && embed401) findings.push(`${extracted} facts parsed from daily logs but vector store failed (401)`);
  if (/Scanning 20\d{2}-\d{2}-\d{2}/.test(log)) findings.push("Daily log files found and scanned");
  else findings.push("No daily log scan lines in output");

  return {
    taskId: "extract-daily",
    verdict: extracted > 0 && !embed401 ? "acceptable" : embed401 && extracted > 0 ? "failed" : extracted > 0 ? "weak" : "n/a",
    summary: extracted > 0 ? `${extracted} daily facts extracted` : "No daily facts extracted",
    findings,
    samples: [],
  };
}

export function buildQualityReport(
  workHome: string,
  taskLogs: Record<string, string | undefined>,
): QualityReport {
  const tasks: TaskQualityReview[] = [
    reviewDistill(workHome, readLog(taskLogs.distill)),
    reviewExtractDaily(readLog(taskLogs["extract-daily"])),
    reviewReflection("reflect", readLog(taskLogs.reflect), "reflect"),
    reviewReflection("reflect-meta", readLog(taskLogs["reflect-meta"]), "meta"),
    reviewReflection("reflect-rules", readLog(taskLogs["reflect-rules"]), "rules"),
    reviewIdentity(readLog(taskLogs["reflect-identity"])),
    reviewSkills(workHome, readLog(taskLogs["generate-auto-skills"])),
  ];

  const blockers = tasks
    .filter((t) => t.verdict === "failed")
    .map((t) => `${t.taskId}: ${t.summary}`);

  return {
    generatedAt: new Date().toISOString(),
    workHome,
    tasks,
    blockers,
  };
}

export function renderQualityMarkdown(report: QualityReport): string {
  const lines = [
    "## Quality review (artifact inspection)",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Task | Verdict | Summary |",
    "|------|---------|---------|",
    ...report.tasks.map((t) => `| ${t.taskId} | ${t.verdict} | ${t.summary.replace(/\|/g, "/")} |`),
    "",
  ];
  for (const t of report.tasks) {
    if (t.findings.length === 0 && t.samples.length === 0) continue;
    lines.push(`### Quality: ${t.taskId} (${t.verdict})`, "");
    if (t.findings.length) lines.push(...t.findings.map((f) => `- ${f}`), "");
    if (t.samples.length) {
      lines.push("Samples:", "");
      for (const s of t.samples.slice(0, 5)) lines.push(`> ${s}`, "");
    }
  }
  if (report.blockers.length) {
    lines.push("### Quality blockers", "", ...report.blockers.map((b) => `- **${b}**`), "");
  }
  return lines.join("\n");
}
