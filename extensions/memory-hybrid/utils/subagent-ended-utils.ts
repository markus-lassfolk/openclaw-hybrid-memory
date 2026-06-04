/**
 * Helpers for OpenClaw **subagent_ended** payloads (issue #966).
 * Core passes targetSessionKey, outcome, error, etc.; shapes vary slightly by version.
 */

/** OpenClaw core dispatch shapes — see runSubagentEnded */
export type SubagentEndedEvent = {
  targetSessionKey?: string;
  sessionKey?: string;
  label?: string;
  success?: boolean;
  outcome?: string;
  error?: string;
  reason?: string;
  runId?: string;
};

export function subagentEndedIsSuccess(ev: SubagentEndedEvent): boolean {
  if (typeof ev.success === "boolean") return ev.success;
  const o = (ev.outcome ?? "").toLowerCase();
  if (!o) return false;
  if (["error", "timeout", "killed", "failed", "failure"].includes(o)) return false;
  if (["success", "completed", "ok", "done"].includes(o)) return true;
  return false;
}

export function taskLabelsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Resolve which active task row this event refers to: prefer label match, then
 * `subagent === targetSessionKey` when core sends session keys without a stable label.
 */
export function findActiveTaskForSubagentEnd<T extends { label: string; subagent?: string }>(
  active: T[],
  ev: SubagentEndedEvent,
): T | undefined {
  const targetKey = ev.targetSessionKey ?? ev.sessionKey;
  const candidateLabel = ev.label ?? targetKey;
  if (candidateLabel) {
    const byLabel = active.find((t) => taskLabelsMatch(t.label, candidateLabel));
    if (byLabel) return byLabel;
  }
  if (targetKey) {
    return active.find((t) => t.subagent === targetKey);
  }
  return undefined;
}
