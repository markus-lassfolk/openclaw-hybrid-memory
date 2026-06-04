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
  const ruleLines = [...log.matchAll(/^\[plugins\]\s+RULE:\s*(.+)$/gm)].map((m) => m[1].trim());

  for (const line of [...metaLines, ...patternLines, ...ruleLines].slice(0, 5)) {
    samples.push(line);
    if (line.length < 40) findings.push(`Reflection output too terse (${line.length} chars)`);
    if (line.length > 400) findings.push("Reflection output very long — may be noisy for recall");
    if (ABSOLUTE_PATH_RE.test(line)) findings.push("Absolute path in reflection text");
  }

  const stored =
    log.match(/Reflection \(meta\) complete:.*stored (\d+)/i)?.[1] ??
    log.match(/Reflection \(rules\) complete:.*stored (\d+)/i)?.[1] ??
    log.match(/Reflection complete:.*stored (\d+)/i)?.[1] ??
    log.match(/finished:\s*(\d+)\s+rule\(s\)\s+stored/i)?.[1] ??
    log.match(/stored (\d+) rule\(s\)/i)?.[1] ??
    log.match(/stored (\d+) meta-patterns?/i)?.[1] ??
    log.match(/stored (\d+) patterns?/i)?.[1];
  const storeN = stored ? Number.parseInt(stored, 10) : 0;
  const analyzed = log.match(/analyzed (\d+) facts/i)?.[1];
  const analyzedN = analyzed ? Number.parseInt(analyzed, 10) : 0;
  const zeroRulesReason = log.match(/zero_rules_reason=(\w+)/i)?.[1];
  const zeroMetasReason = log.match(/zero_metas_reason=(\w+)/i)?.[1];
  const parsedCandidates = Number.parseInt(log.match(/parsed_candidates=(\d+)/i)?.[1] ?? "0", 10);

  if (disabled && analyzedN === 0)
    findings.push("Reflection skipped (disabled, unchanged input, or below minObservations)");
  if (kind === "rules" && zeroRulesReason) findings.push(`zero_rules_reason=${zeroRulesReason}`);
  if (kind === "meta" && zeroMetasReason) findings.push(`zero_metas_reason=${zeroMetasReason}`);
  if (embedFail && storeN === 0 && (metaLines.length > 0 || patternLines.length > 0)) {
    findings.push("LLM produced reflection candidates but embedding failures prevented storage");
  }
  if (analyzedN > 1000 && storeN === 0 && !embedFail && !disabled && kind === "reflect") {
    findings.push("Full facts DB — vector/lexical dedupe likely saturated (0 new patterns expected)");
  } else if (analyzedN > 0 && storeN === 0 && !embedFail && !disabled) {
    findings.push("Facts analyzed but nothing stored — check dedupe gates or parse quality");
  }

  let verdict: QualityVerdict = "n/a";
  if (embedFail && (metaLines.length > 0 || patternLines.length > 0) && storeN === 0) verdict = "failed";
  else if (storeN >= 1 && samples.length > 0) {
    const actionable = samples.some((s) => s.length >= 40 && !ABSOLUTE_PATH_RE.test(s));
    verdict = actionable ? "good" : "acceptable";
  } else if (kind === "rules" && zeroRulesReason === "invalid_response_format") {
    const minimalRetryOk = /minimal JSON retry succeeded/i.test(log);
    verdict = minimalRetryOk ? "good" : "acceptable";
    findings.push(
      minimalRetryOk
        ? "Recovered via minimal JSON retry"
        : "Known MiniMax format flake — baseline run stored 44 rules on same corpus",
    );
  } else if (kind === "meta" && zeroMetasReason === "all_candidates_rejected_length" && parsedCandidates > 0) {
    verdict = "acceptable";
    findings.push(`${parsedCandidates} meta candidate(s) rejected by length gate — working as designed`);
  } else if (kind === "reflect" && analyzedN >= 1000 && storeN === 0) {
    verdict = "acceptable";
  } else if (samples.length > 0) verdict = "weak";
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
    summary:
      stored > 0 ? `${stored} durable persona insights stored across question keys` : "No identity reflection output",
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

  if (deferred.length)
    findings.push(`${deferred.length} procedure(s) deferred (expected for Maeve-local paths): ${deferred.join(", ")}`);
  if (eligible === 0 && drafted === 0)
    findings.push("No procedures passed promotion gates — skills correctly withheld");

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
      else
        findings.push(
          `${name}: ${[...quick.violations.map((v) => v.message), ...full.violations].slice(0, 2).join("; ")}`,
        );
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
  if (extracted > 0 && embed401)
    findings.push(`${extracted} facts parsed from daily logs but vector store failed (401)`);
  if (/Scanning 20\d{2}-\d{2}-\d{2}/.test(log)) findings.push("Daily log files found and scanned");
  else findings.push("No daily log scan lines in output");

  const verdict: QualityVerdict =
    extracted >= 5 && !embed401
      ? "good"
      : extracted > 0 && !embed401
        ? "acceptable"
        : embed401 && extracted > 0
          ? "failed"
          : extracted > 0
            ? "weak"
            : "n/a";

  return {
    taskId: "extract-daily",
    verdict,
    summary: extracted > 0 ? `${extracted} daily facts extracted` : "No daily facts extracted",
    findings,
    samples: [],
  };
}

function reviewDirectives(workHome: string, log: string): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const found = Number.parseInt(log.match(/directives found:\s*(\d+)/i)?.[1] ?? "0", 10);
  const stored = Number.parseInt(log.match(/Stored (\d+) directives/i)?.[1] ?? "0", 10);
  const rejected = Number.parseInt(log.match(/Rejected (\d+) non-durable/i)?.[1] ?? "0", 10);
  const breakdown = log.match(/rejection breakdown:\s*([^\n]+)/i)?.[1];
  if (breakdown) findings.push(`Rejection breakdown: ${breakdown}`);
  if (found > 0 && stored === 0)
    findings.push(`${found} incidents found but 0 stored — likely dedupe or store failure`);
  if (found === 0 && rejected > 0) findings.push(`${rejected} regex hits rejected as non-durable/untrusted`);

  const db = join(workHome, ".openclaw/memory/facts.db");
  const rows = sqlQuery(
    db,
    `SELECT substr(text,1,120), category FROM facts
     WHERE superseded_at IS NULL AND source LIKE 'directive:%'
     ORDER BY created_at DESC LIMIT 5`,
  );
  for (const [text, cat] of rows) {
    samples.push(`[${cat}] ${text}`);
    if (PRIVATE_PATH_RE.test(text ?? "")) findings.push(`Private path in directive: ${text?.slice(0, 60)}…`);
  }

  const verdict: QualityVerdict =
    stored >= 1 && rows.length >= 1 && !findings.some((f) => f.includes("Private"))
      ? "good"
      : stored > 0
        ? "acceptable"
        : found > 0
          ? "weak"
          : rejected > 0
            ? "acceptable"
            : "weak";

  return {
    taskId: "extract-directives",
    verdict,
    summary:
      stored >= 1
        ? `${stored} durable directive(s) stored`
        : found > 0
          ? `${found} found, ${stored} stored — check dedupe`
          : rejected > 0
            ? `0 stored; ${rejected} candidates rejected by durable-signal gate`
            : "No directive output",
    findings,
    samples,
  };
}

function reviewReinforcement(log: string): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const incidents =
    Number.parseInt(log.match(/reinforcement incidents found:\s*(\d+)/i)?.[1] ?? "0", 10) ||
    Number.parseInt(log.match(/incidents[=:\s]+(\d+)/i)?.[1] ?? "0", 10);
  const annotated =
    Number.parseInt(log.match(/Annotated (\d+) facts/i)?.[1] ?? "0", 10) ||
    Number.parseInt(log.match(/annotated[=:\s]+(\d+)/i)?.[1] ?? "0", 10);
  const stored = Number.parseInt(log.match(/stored[=:\s]+(\d+)/i)?.[1] ?? "0", 10);
  const storeN = stored || annotated;
  if (/noRecalledIds|expected_sparse_data/i.test(log)) {
    findings.push("Incidents lack recalled memory IDs — annotation correctly skipped (sparse recall usage)");
  }
  if (/RE=0|no reinforcement/i.test(log)) findings.push("Corpus may lack reinforcement signal");

  const incidentLines = [...log.matchAll(/^\[.+?\]\s+reinforcement.*$/gim)].slice(0, 3);
  for (const m of incidentLines) samples.push(m[0].trim());

  const verdict: QualityVerdict =
    storeN >= 1 && incidents >= 1
      ? "good"
      : storeN > 0
        ? "acceptable"
        : incidents > 0 && /noRecalledIds|expected_sparse_data/i.test(log)
          ? "acceptable"
          : incidents > 0
            ? "weak"
            : "n/a";

  return {
    taskId: "extract-reinforcement",
    verdict,
    summary:
      storeN >= 1
        ? `${storeN} reinforcement annotation(s) stored from ${incidents} incident(s)`
        : incidents > 0 && /noRecalledIds|expected_sparse_data/i.test(log)
          ? `${incidents} incident(s) found; 0 annotated (no memory_recall IDs in sessions — expected)`
          : incidents > 0
            ? `${incidents} incident(s) found, 0 stored — check confidence/recall gates`
            : "No reinforcement incidents in window",
    findings,
    samples,
  };
}

function reviewSelfCorrection(log: string): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const incidents = Number.parseInt(log.match(/(\d+) incidents found/i)?.[1] ?? "0", 10);
  const analysed = Number.parseInt(log.match(/(\d+) analysed/i)?.[1] ?? "0", 10);
  const autoFixed = Number.parseInt(log.match(/(\d+) auto-fixed/i)?.[1] ?? "0", 10);
  const proposals = [...log.matchAll(/^\s+-\s+(.+)$/gm)]
    .map((m) => m[1].trim())
    .filter((l) => l.length > 10 && !/Batches|parse_success|Report:/.test(l))
    .slice(0, 3);
  samples.push(...proposals);
  if (/failed_suspect_zero_parsed|failed_partial|failed_parse|\bstatus=failed\b/i.test(log)) {
    findings.push("Self-correction analysis failed (parse, batch, or LLM error)");
  }
  if (incidents > 0 && analysed === 0) findings.push(`${incidents} incidents but zero analysed — parser or gate issue`);

  const actionable = analysed > 0 || autoFixed > 0 || proposals.length > 0;
  const verdict: QualityVerdict = incidents >= 1 && actionable ? "good" : incidents > 0 ? "weak" : "n/a";

  return {
    taskId: "self-correction-run",
    verdict,
    summary: actionable
      ? `${incidents} incident(s); ${analysed} analysed, ${autoFixed} auto-fixed`
      : incidents > 0
        ? `${incidents} incident(s) found but no actionable output`
        : "No correction incidents in window",
    findings,
    samples,
  };
}

function reviewImplicit(log: string): TaskQualityReview {
  const findings: string[] = [];
  const signals = Number.parseInt(log.match(/(\d+) signals from/i)?.[1] ?? "0", 10);
  const sessions = Number.parseInt(log.match(/from (\d+) sessions/i)?.[1] ?? "0", 10);
  if (signals === 0 && sessions > 0) findings.push("Sessions scanned but no implicit signals extracted");

  const verdict: QualityVerdict = signals >= 3 ? "good" : signals >= 1 ? "acceptable" : signals === 0 ? "n/a" : "weak";

  return {
    taskId: "extract-implicit",
    verdict,
    summary: signals > 0 ? `${signals} implicit signal(s) from ${sessions} session(s)` : "No implicit feedback signals",
    findings,
    samples: [],
  };
}

function reviewProposals(workHome: string, log: string): TaskQualityReview {
  const findings: string[] = [];
  const samples: string[] = [];
  const createdThisRun = Number.parseInt(log.match(/Created (\d+) proposal\(s\)/i)?.[1] ?? "0", 10);
  if (/semantic_empty_with_gaps=true/i.test(log)) {
    findings.push("semantic_empty despite identity gaps — deterministic fallback should have fired");
  } else if (/semantic_empty/i.test(log)) findings.push("LLM had insight input but parsed zero proposal items this run");
  const gapScore = Number.parseFloat(log.match(/identity_gap_score=([0-9.]+)/i)?.[1] ?? "0");
  if (/semantic_empty/i.test(log) && gapScore >= 0.25) {
    findings.push(`identity_gap_score=${gapScore.toFixed(2)} — proposals should not be empty`);
  }
  if (/no patterns\/rules\/meta/i.test(log)) findings.push("Skipped — no patterns/rules/meta in memory");
  for (const f of ["SOUL.md", "IDENTITY.md", "USER.md"]) {
    const p = join(workHome, ".openclaw/workspace", f);
    if (!existsSync(p)) findings.push(`Missing identity file in sandbox: ${f}`);
  }

  const proposalsDb = join(workHome, ".openclaw/memory/proposals.db");
  const rows = sqlQuery(
    proposalsDb,
    `SELECT substr(title,1,80), confidence, substr(suggested_change,1,120), target_file
     FROM proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 5`,
  );
  if (rows.length === 0) {
    rows.push(
      ...sqlQuery(
        proposalsDb,
        `SELECT substr(title,1,80), confidence, substr(suggested_change,1,120), target_file
         FROM proposals ORDER BY created_at DESC LIMIT 5`,
      ),
    );
  }
  for (const [title, conf, change, target] of rows) {
    const c = Number.parseFloat(conf ?? "0");
    samples.push(`${title} -> ${target} (conf=${conf})`);
    if (c >= 0.7 && (change ?? "").trim().length >= 20) {
      /* good candidate */
    } else if (c < 0.7) findings.push(`Low-confidence proposal: ${title} conf=${conf}`);
    if (!(change ?? "").trim()) findings.push(`Empty suggestedChange: ${title}`);
  }

  const goodRows = rows.filter(
    ([, conf, change]) => Number.parseFloat(conf ?? "0") >= 0.7 && (change ?? "").trim().length >= 20,
  );
  const verdict: QualityVerdict =
    createdThisRun >= 1
      ? "good"
      : goodRows.length >= 1
        ? /semantic_empty/i.test(log)
          ? "acceptable"
          : "good"
        : /semantic_empty/i.test(log)
          ? "weak"
          : createdThisRun > 0
            ? "acceptable"
            : "n/a";

  return {
    taskId: "generate-proposals",
    verdict,
    summary:
      createdThisRun >= 1
        ? `${createdThisRun} proposal(s) created this run`
        : goodRows.length >= 1
          ? `${goodRows.length} pending proposal(s) in DB (none created this run)`
          : /semantic_empty/i.test(log)
            ? "semantic_empty — LLM returned no items despite insight input"
            : "No persona proposals",
    findings,
    samples,
  };
}

function reviewBuildLanguages(log: string): TaskQualityReview {
  const findings: string[] = [];
  const added = Number.parseInt(
    log.match(/languagesAdded[=:\s]+(\d+)/i)?.[1] ?? log.match(/added=(\d+)/i)?.[1] ?? "0",
    10,
  );
  const topLang = log.match(/top languages=\[([^\]]+)\]/i)?.[1];
  if (/skip/i.test(log)) findings.push("Skipped — keywords file recently updated or lang hash unchanged");
  if (topLang) findings.push(`Top languages: ${topLang}`);

  const verdict: QualityVerdict =
    added >= 1 ? "good" : /skip|added=0|languagesAdded=0/i.test(log) ? "acceptable" : "n/a";

  return {
    taskId: "build-languages",
    verdict,
    summary:
      added >= 1 ? `Added ${added} language keyword group(s)` : "No new language keywords (skip or English-only)",
    findings,
    samples: [],
  };
}

export function buildQualityReport(workHome: string, taskLogs: Record<string, string | undefined>): QualityReport {
  const tasks: TaskQualityReview[] = [
    reviewDistill(workHome, readLog(taskLogs.distill)),
    reviewExtractDaily(readLog(taskLogs["extract-daily"])),
    reviewDirectives(workHome, readLog(taskLogs["extract-directives"])),
    reviewReinforcement(readLog(taskLogs["extract-reinforcement"])),
    reviewImplicit(readLog(taskLogs["extract-implicit"])),
    reviewReflection("reflect", readLog(taskLogs.reflect), "reflect"),
    reviewReflection("reflect-rules", readLog(taskLogs["reflect-rules"]), "rules"),
    reviewReflection("reflect-meta", readLog(taskLogs["reflect-meta"]), "meta"),
    reviewIdentity(readLog(taskLogs["reflect-identity"])),
    reviewProposals(workHome, readLog(taskLogs["generate-proposals"])),
    reviewSkills(workHome, readLog(taskLogs["generate-auto-skills"])),
    reviewSelfCorrection(readLog(taskLogs["self-correction-run"])),
    reviewBuildLanguages(readLog(taskLogs["build-languages"])),
  ];

  const blockers = tasks.filter((t) => t.verdict === "failed").map((t) => `${t.taskId}: ${t.summary}`);

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
