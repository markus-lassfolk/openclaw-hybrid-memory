/**
 * In-process rolling record of outbound provider HTTP attempts (chat + embeddings).
 * Used only for diagnostics when rate limits fire — not authoritative billing data.
 */

export type RecentHttpAttempt = {
  t: number;
  operation?: string;
  model?: string;
};

const MAX_EVENTS = 500;
const events: RecentHttpAttempt[] = [];

function pruneOlderThan(cutoffMs: number): void {
  while (events.length > 0 && events[0].t < cutoffMs) {
    events.shift();
  }
}

/**
 * Record one outbound attempt before the SDK call (includes retries as separate rows).
 */
export function recordProviderHttpAttempt(meta: { operation?: string; model?: string }): void {
  const now = Date.now();
  events.push({ t: now, operation: meta.operation, model: meta.model });
  while (events.length > MAX_EVENTS) {
    events.shift();
  }
  pruneOlderThan(now - 180_000);
}

function countInWindow(windowMs: number): RecentHttpAttempt[] {
  const now = Date.now();
  const start = now - windowMs;
  pruneOlderThan(start - 1);
  return events.filter((e) => e.t >= start);
}

function aggregateByOperationModel(rows: RecentHttpAttempt[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of rows) {
    const op = e.operation?.trim() || "?";
    const mod = e.model?.trim() || "?";
    const key = `${op} · ${mod}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

function formatTop(m: Map<string, number>, limit: number): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, c]) => `${c}× ${k}`)
    .join("; ");
}

/**
 * Summarize recent attempts for rate-limit log lines (this Node process only).
 */
export function formatRecentHttpAttemptsForRateLimitLog(): string {
  const w60 = countInWindow(60_000);
  const w180 = countInWindow(180_000);
  const top60 = formatTop(aggregateByOperationModel(w60), 6);
  const top180 = formatTop(aggregateByOperationModel(w180), 6);
  const s60 = w60.length === 0 ? "0" : String(w60.length);
  const s180 = w180.length === 0 ? "0" : String(w180.length);
  return (
    `this-process traffic: last60s=${s60} attempt(s) [${top60 || "—"}]; ` +
    `last180s=${s180} attempt(s) [${top180 || "—"}] ` +
    `(same IP / subscription as other gateway jobs will share provider limits)`
  );
}
