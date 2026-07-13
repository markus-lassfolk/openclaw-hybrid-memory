/**
 * Batch reject/defer hygiene for the pending-review digest (#2098).
 *
 * `digest pending` reports age-bucket hygiene per queue but, until now, had no way to actually
 * act on a large backlog other than one-by-one approve/reject — explicitly deferred in
 * `pending-review-digest.ts`. This module adds duplicate detection (same target/name, keep the
 * newest) and age/confidence-threshold candidate selection across the three simple pending
 * queues (persona proposals, tool proposals, crystallization proposals), plus a bounded apply
 * path that rejects only the previewed candidate ids through each store's existing reject
 * primitive — no new state-transition logic, reused as-is.
 */
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { parseTimestamp } from "../utils/dates.js";
import { pendingStorePaths } from "./pending-review-digest.js";

export type DigestBatchRejectQueue = "persona" | "tools" | "crystallization";

export type DigestBatchRejectCandidate = {
  id: string;
  label: string;
  ageDays: number;
  reasons: string[];
};

export type DigestBatchRejectPreview = {
  queue: DigestBatchRejectQueue;
  totalPending: number;
  candidates: DigestBatchRejectCandidate[];
};

type GenericPendingItem = {
  id: string;
  label: string;
  dedupeKey: string;
  createdAtSec: number;
  confidence?: number;
};

function ageDaysFromSec(createdAtSec: number, nowSec: number): number {
  return Math.max(0, Math.floor((nowSec - createdAtSec) / 86400));
}

/** Newest item per non-empty dedupeKey group is kept; every older sibling maps to its id. */
function findDuplicates(items: GenericPendingItem[]): Map<string, string> {
  const groups = new Map<string, GenericPendingItem[]>();
  for (const item of items) {
    if (!item.dedupeKey) continue;
    const group = groups.get(item.dedupeKey);
    if (group) group.push(item);
    else groups.set(item.dedupeKey, [item]);
  }
  const duplicateOf = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.createdAtSec - a.createdAtSec);
    const newestId = sorted[0].id;
    for (let i = 1; i < sorted.length; i++) duplicateOf.set(sorted[i].id, newestId);
  }
  return duplicateOf;
}

function buildCandidates(
  items: GenericPendingItem[],
  opts: { olderThanDays?: number; maxConfidence?: number; duplicatesOnly?: boolean },
  nowSec: number,
): DigestBatchRejectCandidate[] {
  const duplicateOf = findDuplicates(items);
  const out: DigestBatchRejectCandidate[] = [];
  for (const item of items) {
    const reasons: string[] = [];
    const dupOfId = duplicateOf.get(item.id);
    if (dupOfId) reasons.push(`duplicate of ${dupOfId.slice(0, 8)}`);
    const ageDays = ageDaysFromSec(item.createdAtSec, nowSec);
    if (opts.olderThanDays != null && ageDays >= opts.olderThanDays) reasons.push(`age>=${opts.olderThanDays}d`);
    if (opts.maxConfidence != null && item.confidence != null && item.confidence <= opts.maxConfidence) {
      reasons.push(`confidence<=${opts.maxConfidence.toFixed(2)}`);
    }
    if (opts.duplicatesOnly && !dupOfId) continue;
    if (reasons.length === 0) continue;
    out.push({ id: item.id, label: item.label, ageDays, reasons });
  }
  // Oldest first — the natural triage order for a batch action.
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

function loadGenericItems(cfg: HybridMemoryConfig, queue: DigestBatchRejectQueue): GenericPendingItem[] {
  const paths = pendingStorePaths(cfg.sqlitePath);
  if (queue === "persona") {
    if (!cfg.personaProposals.enabled) return [];
    const store = new ProposalsDB(paths.proposals);
    try {
      return store.list({ status: "pending" }).map((p) => ({
        id: p.id,
        label: `${p.title} (${p.targetFile})`,
        dedupeKey: `${p.targetFile.trim().toLowerCase()}::${p.title.trim().toLowerCase()}`,
        createdAtSec: p.createdAt,
        confidence: p.confidence,
      }));
    } finally {
      store.close();
    }
  }
  if (queue === "tools") {
    const store = new ToolProposalStore(paths.toolProposals);
    try {
      return store.list({ status: "proposed" }).map((p) => ({
        id: p.id,
        label: p.name,
        dedupeKey: p.name.trim().toLowerCase(),
        createdAtSec: parseTimestamp(p.createdAt) ?? 0,
      }));
    } finally {
      store.close();
    }
  }
  const store = new CrystallizationStore(paths.crystallization);
  try {
    return store
      .list()
      .filter((p) => p.status === "drafted" || p.status === "validated")
      .map((p) => ({
        id: p.id,
        label: p.skillName,
        dedupeKey: p.skillName.trim().toLowerCase(),
        createdAtSec: parseTimestamp(p.createdAt) ?? 0,
        confidence: p.confidence,
      }));
  } finally {
    store.close();
  }
}

/** Non-mutating: compute which pending items in `queue` would be batch-rejected. */
export function previewDigestBatchReject(opts: {
  cfg: HybridMemoryConfig;
  queue: DigestBatchRejectQueue;
  olderThanDays?: number;
  maxConfidence?: number;
  duplicatesOnly?: boolean;
  now?: Date;
}): DigestBatchRejectPreview {
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const items = loadGenericItems(opts.cfg, opts.queue);
  const candidates = buildCandidates(
    items,
    {
      olderThanDays: opts.olderThanDays,
      maxConfidence: opts.maxConfidence,
      duplicatesOnly: opts.duplicatesOnly,
    },
    nowSec,
  );
  return { queue: opts.queue, totalPending: items.length, candidates };
}

/** Apply a previously previewed set of candidate ids: reject each through its store's existing
 *  reject primitive. Never widens the id set itself — callers must pass exactly the ids they
 *  showed the operator (or a subset), so an apply run can never reject more than was previewed. */
export function applyDigestBatchReject(opts: {
  cfg: HybridMemoryConfig;
  queue: DigestBatchRejectQueue;
  ids: string[];
  reasonPrefix?: string;
}): { rejected: number; failed: string[] } {
  const paths = pendingStorePaths(opts.cfg.sqlitePath);
  const reason = opts.reasonPrefix ?? "digest batch-reject";
  const failed: string[] = [];
  let rejected = 0;

  if (opts.queue === "persona") {
    const store = new ProposalsDB(paths.proposals);
    try {
      for (const id of opts.ids) {
        const updated = store.updateStatus(id, "rejected", "digest-batch-reject", reason);
        if (updated) rejected++;
        else failed.push(id);
      }
    } finally {
      store.close();
    }
    return { rejected, failed };
  }

  if (opts.queue === "tools") {
    const store = new ToolProposalStore(paths.toolProposals);
    try {
      for (const id of opts.ids) {
        const updated = store.updateStatus(id, "rejected", "proposed", reason);
        if (updated) rejected++;
        else failed.push(id);
      }
    } finally {
      store.close();
    }
    return { rejected, failed };
  }

  const store = new CrystallizationStore(paths.crystallization);
  try {
    for (const id of opts.ids) {
      const updated = store.reject(id, reason);
      if (updated) rejected++;
      else failed.push(id);
    }
  } finally {
    store.close();
  }
  return { rejected, failed };
}
