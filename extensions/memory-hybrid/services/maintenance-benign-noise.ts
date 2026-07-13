import { createHash } from "node:crypto";

export interface MaintenanceBenignNoisePattern {
  id: string;
  /** Human-readable label for digest output. */
  label: string;
  pattern: RegExp;
}

/** Known benign maintenance log lines that should not inflate failure analysis (#1833). */
export const MAINTENANCE_BENIGN_NOISE_PATTERNS: MaintenanceBenignNoisePattern[] = [
  {
    id: "register-context-engine-missing",
    label: "registerContextEngine not found in SDK (compatibility notice)",
    pattern: /registerContextEngine not found in SDK; skipping ContextEngine registration/i,
  },
  {
    id: "codex-unsupported-project-local-config",
    label: "Codex app-server ignored unsupported project-local config keys",
    // Consumes an optional leading log-level label (e.g. "ERROR codex_app_server: ...", as
    // actually emitted by the wrapper) so sanitizeMaintenanceLogText's substring-only removal
    // (not whole-line removal, QA follow-up) doesn't leave a bare "ERROR" behind that would
    // itself then match ACTIONABLE_FAILURE_SIGNAL.
    pattern:
      /(?:ERROR|WARN|INFO)?\s*codex_app_server:\s*Ignored unsupported project-local config keys in .*\.codex\/config\.toml:\s*(?:model_provider|model_providers|profiles)\.?/i,
  },
];

export interface MaintenanceNoiseWarning {
  patternId: string;
  fingerprint: string;
  classification: "benign_noise";
  label: string;
  job: string;
  step: string;
  logPath: string;
  occurrenceCount: number;
  excerpt: string;
}

export function maintenanceBenignNoiseFingerprint(patternId: string): string {
  return createHash("sha256").update(`benign_noise\0${patternId}`).digest("hex").slice(0, 16);
}

export function lineMatchesMaintenanceBenignNoise(line: string): MaintenanceBenignNoisePattern | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const entry of MAINTENANCE_BENIGN_NOISE_PATTERNS) {
    if (entry.pattern.test(trimmed)) return entry;
  }
  return null;
}

export function logContainsMaintenanceBenignNoise(text: string): boolean {
  if (!text) return false;
  return text.split("\n").some((line) => lineMatchesMaintenanceBenignNoise(line) !== null);
}

/** Remove known benign noise substrings before classifying or excerpting actionable failures. */
export function sanitizeMaintenanceLogText(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => {
      // Strip only the matched benign-noise substring, not the whole line — a genuine error
      // concatenated onto the same physical line as a benign notice (e.g. merged stdout/stderr)
      // must survive for the actionable-failure-signal check below, or the real failure is
      // silently dropped along with the noise (QA follow-up).
      let sanitized = line;
      for (const entry of MAINTENANCE_BENIGN_NOISE_PATTERNS) {
        const flags = entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`;
        sanitized = sanitized.replace(new RegExp(entry.pattern.source, flags), "");
      }
      return sanitized;
    })
    .join("\n");
}

const ACTIONABLE_FAILURE_SIGNAL =
  /error|fail|exception|unauthorized|429|busy|timeout|killed|cannot find module|guard|stopped early|ENOSPC|SQLITE_BUSY|still running after|validate-cron-exit|orchestration anomaly|empty exit ledger/i;
const BENIGN_COUNTER_SIGNAL =
  /\b(no|without|zero)\s+(errors?|failures?)\b|\berrors?\s*[:=]\s*0\b|\bfailures?\s*[:=]\s*0\b|\b0\s+errors?\b|\b0\s+failures?\b|\berrorcount\s*[:=]\s*0\b/gi;

export function textHasActionableFailureSignal(text: string): boolean {
  const sanitized = sanitizeMaintenanceLogText(text);
  if (!sanitized.trim()) return false;
  if (!ACTIONABLE_FAILURE_SIGNAL.test(sanitized)) return false;
  return ACTIONABLE_FAILURE_SIGNAL.test(sanitized.replace(BENIGN_COUNTER_SIGNAL, " "));
}

export function stepHasActionableFailureSignal(input: { line?: string; logContent?: string }): boolean {
  return textHasActionableFailureSignal(`${input.line ?? ""}\n${input.logContent ?? ""}`);
}

export function isBenignNoiseOnlyMaintenanceStep(input: {
  exitCode: number;
  line?: string;
  logContent?: string;
}): boolean {
  const combined = `${input.line ?? ""}\n${input.logContent ?? ""}`;
  if (!logContainsMaintenanceBenignNoise(combined)) return false;
  return !stepHasActionableFailureSignal(input);
}

export function collectMaintenanceNoiseWarnings(
  steps: Array<{ job: string; step: string; logPath: string; line?: string; logContent?: string }>,
): MaintenanceNoiseWarning[] {
  const byKey = new Map<string, MaintenanceNoiseWarning>();

  for (const step of steps) {
    const lines = `${step.line ?? ""}\n${step.logContent ?? ""}`.split("\n");
    for (const rawLine of lines) {
      const match = lineMatchesMaintenanceBenignNoise(rawLine);
      if (!match) continue;
      const key = `${match.id}\0${step.job}\0${step.step}\0${step.logPath}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrenceCount += 1;
        continue;
      }
      byKey.set(key, {
        patternId: match.id,
        fingerprint: maintenanceBenignNoiseFingerprint(match.id),
        classification: "benign_noise",
        label: match.label,
        job: step.job,
        step: step.step,
        logPath: step.logPath,
        occurrenceCount: 1,
        excerpt: rawLine.trim().slice(0, 500),
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.patternId !== b.patternId) return a.patternId.localeCompare(b.patternId);
    if (a.job !== b.job) return a.job.localeCompare(b.job);
    return a.step.localeCompare(b.step);
  });
}
