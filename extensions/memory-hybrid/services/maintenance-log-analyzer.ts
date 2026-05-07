import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { capturePluginError } from "./error-reporter.js";

export type MaintenanceClassification =
  | "env-misconfig"
  | "transient-llm"
  | "transient-network"
  | "provider-auth"
  | "infra"
  | "plugin-bug"
  | "smoke-only"
  | "orchestration-bug"
  | "unclassified";

export type MaintenanceAction =
  | "retry-once"
  | "escalate-user"
  | "escalate-user-urgent"
  | "glitchtip+digest"
  | "informational"
  | "user-digest";

export interface MaintenanceRule {
  id: string;
  pattern: string;
  classification: MaintenanceClassification;
  defaultAction: MaintenanceAction;
  severity: "critical" | "high" | "medium" | "low" | "info";
  suggestedAction: string;
}

export interface MaintenanceLogStep {
  occurredAt: number;
  iso: string;
  job: string;
  step: string;
  exitCode: number;
  exitPath: string;
  logPath: string;
  logContent: string;
  line: string;
}

export interface MaintenanceFinding {
  id: string;
  occurredAt: number;
  job: string;
  step: string;
  exitCode: number;
  classification: MaintenanceClassification;
  ruleId: string;
  fingerprint: string;
  logExcerpt: string;
  logPath: string;
  pluginVersion: string | null;
  actionTaken:
    | MaintenanceAction
    | "reported"
    | "reported-glitchtip"
    | "auto-fixed-clear-stale-lock"
    | "auto-fixed-retry-once";
  suggestedAction: string;
  severity: MaintenanceRule["severity"];
  glitchtipEventId?: string;
}

export interface MaintenanceAnalysisReport {
  schemaVersion: 1;
  generatedAt: string;
  root?: string;
  since: string;
  totalSteps: number;
  successfulSteps: number;
  findings: MaintenanceFinding[];
  summary: {
    jobsOk: number;
    jobsWithFindings: number;
    byClassification: Record<string, number>;
    byAction: Record<string, number>;
    weekOverWeek?: Array<{ classification: string; currentWeek: number; previousWeek: number; delta: number }>;
  };
  findingsPath?: string;
  digestMd: string;
}

function resolveMaintenanceRulesPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "maintenance-rules.json"),
    // Built dist/services/*.js is emitted without JSON assets, but the published package includes source services/.
    join(here, "..", "..", "services", "maintenance-rules.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

type MaintenanceResolvedEntry = { resolvedInVersion: string; note?: string };

function resolveMaintenanceResolvedPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "maintenance-resolved.json"),
    // Packaged dist/services/*.js omits JSON; published tarball still ships services/*.json.
    join(here, "..", "..", "services", "maintenance-resolved.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function loadMaintenanceResolvedMap(): Record<string, MaintenanceResolvedEntry> {
  try {
    const p = resolveMaintenanceResolvedPath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { fingerprints?: Record<string, MaintenanceResolvedEntry> };
    return raw.fingerprints ?? {};
  } catch {
    return {};
  }
}

/** @internal Compare YYYY.M.N or semver-like dotted versions for resolved-issue suppression (#1199). */
export function pluginVersionGte(current: string | null, minimum: string): boolean {
  if (!current) return false;
  const pa = current.split(/[.+]/).map((s) => Number.parseInt(s, 10));
  const pb = minimum.split(/[.+]/).map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const a = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const b = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function filterResolvedMaintenanceFindings(
  findings: MaintenanceFinding[],
  resolved: Record<string, MaintenanceResolvedEntry>,
): MaintenanceFinding[] {
  return findings.filter((f) => {
    const entry = resolved[f.fingerprint];
    if (!entry) return true;
    return !pluginVersionGte(f.pluginVersion, entry.resolvedInVersion);
  });
}

function loadMaintenanceRules(): MaintenanceRule[] {
  return JSON.parse(readFileSync(resolveMaintenanceRulesPath(), "utf-8")) as MaintenanceRule[];
}

const RULES = loadMaintenanceRules();
const STRICT_CLASSES = new Set<MaintenanceClassification>([
  "plugin-bug",
  "orchestration-bug",
  "provider-auth",
  "env-misconfig",
]);
const GLITCHTIP_CLASSES = new Set<MaintenanceClassification>(["plugin-bug", "orchestration-bug"]);

export function maintenanceRules(): MaintenanceRule[] {
  return RULES.slice();
}

export function parseMaintenanceSinceMs(value = "24h"): number {
  const m = value.trim().match(/^(\d+)([hdw])?$/i);
  if (!m) return 24 * 3600 * 1000;
  const n = Number.parseInt(m[1], 10);
  const unit = (m[2] ?? "h").toLowerCase();
  if (unit === "d") return n * 24 * 3600 * 1000;
  if (unit === "w") return n * 7 * 24 * 3600 * 1000;
  return n * 3600 * 1000;
}

function extractJobName(file: string): string {
  return file.replace(/-[0-9]{8}T.*$/, "").replace(/\.exit\.txt$/, "");
}

function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

export function collectMaintenanceSteps(root: string, since = "24h", nowMs = Date.now()): MaintenanceLogStep[] {
  if (!existsSync(root)) return [];
  const cutoff = nowMs - parseMaintenanceSinceMs(since);
  const steps: MaintenanceLogStep[] = [];
  for (const day of readdirSync(root).sort()) {
    const dayPath = join(root, day);
    if (!existsSync(dayPath) || !statSync(dayPath).isDirectory()) continue;
    for (const file of readdirSync(dayPath).sort()) {
      if (!file.endsWith(".exit.txt")) continue;
      const exitPath = join(dayPath, file);
      if (statSync(exitPath).mtimeMs < cutoff) continue;
      const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
      const logContent = safeRead(logPath);
      const job = extractJobName(file);
      for (const line of safeRead(exitPath).split("\n")) {
        const m = line.match(/^(\S+)\s+(\S+)\s+exit=(\d+)\b/);
        if (!m) continue;
        const [, iso, step, exitRaw] = m;
        const occurredAt = Math.floor(new Date(iso).getTime() / 1000);
        if (!Number.isFinite(occurredAt)) continue;
        steps.push({
          occurredAt,
          iso,
          job,
          step,
          exitCode: Number.parseInt(exitRaw, 10),
          exitPath,
          logPath,
          logContent,
          line,
        });
      }
    }
  }
  return steps;
}

export function classifyMaintenanceFailure(input: {
  step?: string;
  exitCode?: number;
  logContent?: string;
  line?: string;
  rules?: MaintenanceRule[];
}): MaintenanceRule {
  const text = `${input.step ?? ""}\nexit=${input.exitCode ?? ""}\n${input.line ?? ""}\n${input.logContent ?? ""}`;
  for (const rule of input.rules ?? RULES) {
    if (new RegExp(rule.pattern, "ims").test(text)) return rule;
  }
  return {
    id: "unclassified",
    pattern: ".*",
    classification: "unclassified",
    defaultAction: "user-digest",
    severity: "low",
    suggestedAction: "Inspect the raw maintenance log and decide whether this needs a fix or can be deferred.",
  };
}

function extractPluginVersion(logContent: string): string | null {
  const m = logContent.match(/openclaw(?:-hybrid-memory)?[^\n]*?(\d{4}\.\d+\.\d+|\d+\.\d+\.\d+)/i);
  return m?.[1] ?? null;
}

function excerptFor(logContent: string, line: string): string {
  const interesting = logContent
    .split("\n")
    .filter((l) =>
      /error|fail|exception|unauthorized|429|busy|timeout|killed|cannot find module|guard|stopped early|ENOSPC|SQLITE_BUSY/i.test(
        l,
      ),
    )
    .slice(-8)
    .join("\n");
  return (interesting || line || logContent.slice(0, 1000)).slice(0, 1800);
}

function fingerprintFor(step: MaintenanceLogStep, rule: MaintenanceRule): string {
  return createHash("sha256")
    .update(`${rule.classification}\0${rule.id}\0${step.job}\0${step.step}`)
    .digest("hex")
    .slice(0, 16);
}

export function findingFromStep(step: MaintenanceLogStep, rule = classifyMaintenanceFailure(step)): MaintenanceFinding {
  const fingerprint = fingerprintFor(step, rule);
  return {
    id: createHash("sha256")
      .update(`${fingerprint}\0${step.occurredAt}\0${step.exitCode}\0${step.logPath}`)
      .digest("hex"),
    occurredAt: step.occurredAt,
    job: step.job,
    step: step.step,
    exitCode: step.exitCode,
    classification: rule.classification,
    ruleId: rule.id,
    fingerprint,
    logExcerpt: excerptFor(step.logContent, step.line),
    logPath: step.logPath,
    pluginVersion: extractPluginVersion(step.logContent),
    actionTaken: rule.defaultAction,
    suggestedAction: rule.suggestedAction,
    severity: rule.severity,
  };
}

export function analyzeMaintenanceSteps(
  steps: MaintenanceLogStep[],
  opts?: { resolvedFingerprints?: Record<string, MaintenanceResolvedEntry> },
): MaintenanceFinding[] {
  const findings: MaintenanceFinding[] = [];
  const zeroExitHeuristicSeen = new Set<string>();
  for (const step of steps) {
    if (step.exitCode !== 0) {
      findings.push(findingFromStep(step));
      continue;
    }
    const zeroText = `${step.line}
${step.logContent}`;
    const hasAgentStoppedEarly = /agent stopped early|stopped early/i.test(zeroText);
    const hasGuardAnomaly = /guard not updated|guard.*not.*success|success.*guard.*missing/i.test(zeroText);
    if (!hasAgentStoppedEarly && !hasGuardAnomaly) continue;
    if (hasGuardAnomaly && !/guard/i.test(step.step) && !/guard/i.test(step.line)) continue;
    const key = `${step.logPath}:${hasAgentStoppedEarly ? "agent-stopped-early" : "guard-not-updated"}`;
    if (zeroExitHeuristicSeen.has(key)) continue;
    zeroExitHeuristicSeen.add(key);
    const rule = classifyMaintenanceFailure({
      step: step.step,
      exitCode: step.exitCode,
      line: hasAgentStoppedEarly ? "agent stopped early" : "guard not updated after success",
      logContent: "",
    });
    findings.push(findingFromStep(step, rule));
  }
  const resolved = opts?.resolvedFingerprints ?? loadMaintenanceResolvedMap();
  return filterResolvedMaintenanceFindings(findings, resolved);
}

export function persistMaintenanceFindings(dbPath: string, findings: MaintenanceFinding[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_finding (
        id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        job TEXT NOT NULL,
        step TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        classification TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        log_excerpt TEXT,
        log_path TEXT,
        plugin_version TEXT,
        action_taken TEXT,
        resolved_at INTEGER,
        resolved_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_finding_occurred ON maintenance_finding(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_maintenance_finding_class ON maintenance_finding(classification, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_maintenance_finding_fingerprint ON maintenance_finding(fingerprint);
    `);
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO maintenance_finding
       (id, occurred_at, job, step, exit_code, classification, fingerprint, log_excerpt, log_path, plugin_version, action_taken)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of findings) {
      stmt.run(
        f.id,
        f.occurredAt,
        f.job,
        f.step,
        f.exitCode,
        f.classification,
        f.fingerprint,
        f.logExcerpt,
        f.logPath,
        f.pluginVersion,
        f.actionTaken,
      );
    }
  } finally {
    db.close();
  }
}

export function weekOverWeekTrend(dbPath: string, nowSec = Math.floor(Date.now() / 1000)) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    const curStart = nowSec - 7 * 24 * 3600;
    const prevStart = nowSec - 14 * 24 * 3600;
    const rows = db
      .prepare(
        `SELECT classification,
          SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS currentWeek,
          SUM(CASE WHEN occurred_at >= ? AND occurred_at < ? THEN 1 ELSE 0 END) AS previousWeek
         FROM maintenance_finding
         WHERE occurred_at >= ?
         GROUP BY classification
         ORDER BY classification`,
      )
      .all(curStart, prevStart, curStart, prevStart) as Array<{
      classification: string;
      currentWeek: number;
      previousWeek: number;
    }>;
    return rows.map((r) => ({
      classification: r.classification,
      currentWeek: Number(r.currentWeek ?? 0),
      previousWeek: Number(r.previousWeek ?? 0),
      delta: Number(r.currentWeek ?? 0) - Number(r.previousWeek ?? 0),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function incr(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function reportGlitchTipFindings(findings: MaintenanceFinding[]): MaintenanceFinding[] {
  return findings.map((finding) => {
    if (!GLITCHTIP_CLASSES.has(finding.classification)) return finding;
    const eventId = capturePluginError(
      new Error(
        `maintenance-log ${finding.classification}: ${finding.job}/${finding.step} fingerprint=${finding.fingerprint}`,
      ),
      {
        operation: "analyze-maintenance-logs",
        subsystem: "maintenance",
        severity: finding.severity,
        classification: finding.classification,
        fingerprint: finding.fingerprint,
        job: finding.job,
        step: finding.step,
      },
    );
    return { ...finding, glitchtipEventId: eventId, actionTaken: "reported-glitchtip" };
  });
}

export function renderMaintenanceDigestMarkdown(report: Omit<MaintenanceAnalysisReport, "digestMd">): string {
  const okJobs = report.summary.jobsOk;
  const totalJobs = okJobs + report.summary.jobsWithFindings;
  const lines = [
    `## Hybrid-memory maintenance digest (${report.since})`,
    `${report.findings.length === 0 ? "✅" : "⚠️"} ${okJobs}/${totalJobs} jobs OK`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No maintenance failures detected.");
  } else {
    for (const f of report.findings.slice(0, 20)) {
      const icon =
        f.classification === "plugin-bug" || f.classification === "orchestration-bug"
          ? "🐞"
          : f.severity === "critical"
            ? "🚨"
            : "⚠️";
      lines.push(
        `${icon} **${f.job}** — ${f.step} exit=${f.exitCode} at ${new Date(f.occurredAt * 1000).toISOString()}. Class: ${f.classification}. Action: ${f.actionTaken}. Fingerprint: ${f.fingerprint}.`,
      );
      lines.push(`Suggested: ${f.suggestedAction}`);
      lines.push(`Log: ${f.logPath}`);
      if (f.logExcerpt) lines.push(`Excerpt: \`${f.logExcerpt.replace(/\s+/g, " ").slice(0, 240)}\``);
      lines.push("");
    }
    if (report.findings.length > 20) lines.push(`… and ${report.findings.length - 20} more findings.`);
  }
  const trend = report.summary.weekOverWeek ?? [];
  if (trend.length > 0) {
    lines.push("", "### Week-over-week trend", "");
    for (const t of trend) {
      lines.push(
        `- ${t.classification}: ${t.currentWeek} this week vs ${t.previousWeek} previous (${t.delta >= 0 ? "+" : ""}${t.delta})`,
      );
    }
  }
  return lines.join("\n").trimEnd();
}

export function buildMaintenanceAnalysisReport(opts: {
  root?: string;
  since?: string;
  steps: MaintenanceLogStep[];
  findings: MaintenanceFinding[];
  findingsPath?: string;
  includeTrend?: boolean;
}): MaintenanceAnalysisReport {
  const jobs = new Set(opts.steps.map((s) => s.job));
  const failedJobs = new Set(opts.findings.map((f) => f.job));
  const byClassification: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const f of opts.findings) {
    incr(byClassification, f.classification);
    incr(byAction, f.actionTaken);
  }
  const base = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    root: opts.root,
    since: opts.since ?? "24h",
    totalSteps: opts.steps.length,
    successfulSteps: opts.steps.filter((s) => s.exitCode === 0).length,
    findings: opts.findings,
    summary: {
      jobsOk: [...jobs].filter((j) => !failedJobs.has(j)).length,
      jobsWithFindings: failedJobs.size,
      byClassification,
      byAction,
      weekOverWeek: opts.includeTrend && opts.findingsPath ? weekOverWeekTrend(opts.findingsPath) : undefined,
    },
    findingsPath: opts.findingsPath,
  };
  return { ...base, digestMd: renderMaintenanceDigestMarkdown(base) };
}

export function shouldMaintenanceStrictFail(findings: MaintenanceFinding[]): boolean {
  return findings.some((f) => STRICT_CLASSES.has(f.classification));
}

export function writeMaintenanceAnalysisOutput(report: MaintenanceAnalysisReport, format: string, outPath = "-"): void {
  const content = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${report.digestMd}\n`;
  if (outPath === "-") {
    process.stdout.write(content);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf-8");
}
