/**
 * Client-side strength estimate for live-added/updated nodes.
 *
 * Subscription payloads are `Fact`s, which don't carry the server-computed `strength`. This mirrors
 * the plugin's services/graph-node-metrics.computeNodeStrength (composite-score v2, GENERAL intent)
 * closely enough to place a freshly-created star sensibly; the next full graph load reconciles it to
 * the exact server value.
 */
export interface StrengthInputs {
  importance: number;
  confidence: number;
  recallCount?: number | null;
  lastAccessedAt?: string | number | null;
  createdAt?: number | null;
  textLength?: number;
  pinned?: boolean | null;
}

const DAY_SEC = 86_400;

function lastAccessSec(f: StrengthInputs): number {
  if (typeof f.lastAccessedAt === "number" && f.lastAccessedAt > 0) return f.lastAccessedAt;
  if (f.lastAccessedAt) {
    const parsed = Date.parse(String(f.lastAccessedAt));
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return f.createdAt ?? Math.floor(Date.now() / 1000);
}

export function estimateStrength(f: StrengthInputs): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const days = Math.max(0, (nowSec - lastAccessSec(f)) / DAY_SEC);
  const recency = Math.max(0.1, 1 / (1 + days / 30));
  // GENERAL intent weights: search 0.45, recency 0.25, confidence 0.30 (importance stands in for search).
  const base = f.importance * 0.45 + recency * 0.25 + f.confidence * 0.3;
  const bodyLen = f.textLength ?? 100;
  const lengthNorm = Math.max(0.3, 1 / (1 + 0.5 * Math.log2(Math.max(bodyLen / 500, 1))));
  // freqBoost = min(0.10, log1p((recallCount+1 revisions → 2*recallCount) ) * 0.03)
  const freqSignal = Math.max(0, f.recallCount ?? 0) * 2;
  const freqBoost = Math.min(0.1, Math.log1p(freqSignal) * 0.03);
  const pinBoost = f.pinned ? 0.3 : 0;
  // qualityMult defaults to 1.0 (quality 0.5) — omitted.
  return base * lengthNorm + pinBoost + freqBoost;
}
