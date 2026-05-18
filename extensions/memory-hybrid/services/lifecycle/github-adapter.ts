/**
 * GitHub lifecycle adapter — Phase 2 (Issue #1196).
 *
 * Reads `lifecycle.adapters.github.{repos,onMerged,onClosed,onOpen}` and queries the GitHub
 * REST API (via the local `gh` CLI by default) to discover the current state of issues and
 * PRs referenced in fact `entity` columns (e.g. `PR #123` / `Issue #456`). For each match it
 * applies the configured action (`expire-now` / `expire-soon` / `keep-stable`) to the fact's
 * `expires_at` and `decay_class`.
 *
 * The adapter is **transport-agnostic**: callers can inject a `gh` client (`runGh`) so the
 * test suite can drive the flow with a recorded JSON fixture instead of a real network
 * round-trip. In production the default uses `node:child_process` to shell out to `gh api`.
 */

import { spawn } from "node:child_process";

import type { FactsDB } from "../../backends/facts-db.js";
import type { LifecycleGitHubAction, LifecycleGitHubAdapterConfig } from "../../config/types/features.js";

export type GitHubIssueState = "open" | "closed";
export type GitHubItemKind = "issue" | "pr";

export interface GitHubItem {
  kind: GitHubItemKind;
  number: number;
  state: GitHubIssueState;
  /** Whether a PR was merged (always false for issues, may be undefined when unknown). */
  merged?: boolean;
  /** ISO timestamp when the item closed (or null when still open). */
  closedAt?: string | null;
  /** ISO timestamp when the PR merged (PR-only). */
  mergedAt?: string | null;
}

/**
 * Minimal `gh api` client surface. Returning a `Promise<unknown>` lets the implementation
 * shell out, hit a recorded fixture, or stub the response for tests.
 */
export type GhApiClient = (path: string) => Promise<unknown>;

export interface SyncLifecycleFromGitHubOptions {
  config: LifecycleGitHubAdapterConfig;
  /** When set, overrides the default `gh api` shell-out (used by tests). */
  gh?: GhApiClient;
  /** When true (default), actually mutate `expires_at` / `decay_class`. When false, count only. */
  apply?: boolean;
  /** Logger override; falls back to console. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface LifecycleSyncReport {
  ok: true;
  scanned: number;
  matched: number;
  expiredNow: number;
  expiredSoon: number;
  keptStable: number;
  /** Errors encountered per repo (non-fatal). */
  errors: Array<{ repo: string; message: string }>;
}

const ENTITY_RE = /\b(PR|Pull Request|Issue)\s*#(\d+)\b/i;
const SECONDS_PER_DAY = 86400;

function defaultGhClient(): GhApiClient {
  return async (path: string): Promise<unknown> => {
    return await new Promise((resolve, reject) => {
      const child = spawn("gh", ["api", path], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`gh api ${path} exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(err);
        }
      });
    });
  };
}

/**
 * Parse `entity` columns like "PR #123" or "Issue #456" into a structured reference. Returns
 * `null` when the entity does not look like a GitHub reference.
 */
export function parseGitHubEntity(entity: string | null): { kind: GitHubItemKind; number: number } | null {
  if (!entity) return null;
  const m = ENTITY_RE.exec(entity);
  if (!m) return null;
  const number = Number.parseInt(m[2], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  const kind: GitHubItemKind = /^(?:PR|Pull Request)$/i.test(m[1]) ? "pr" : "issue";
  return { kind, number };
}

/** Apply a `LifecycleGitHubAction` to a fact row. Returns the bucket it was counted under. */
function applyAction(
  factsDb: FactsDB,
  factId: string,
  action: LifecycleGitHubAction,
  apply: boolean,
): "expiredNow" | "expiredSoon" | "keptStable" {
  if (!apply) {
    return action === "expire-now" ? "expiredNow" : action === "expire-soon" ? "expiredSoon" : "keptStable";
  }
  const db = (factsDb as unknown as { getRawDb?: () => unknown }).getRawDb?.();
  if (!db) return "keptStable";
  const nowSec = Math.floor(Date.now() / 1000);
  if (action === "expire-now") {
    (db as { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } })
      .prepare(`UPDATE facts SET expires_at = ?, decay_class = 'short' WHERE id = ?`)
      .run(nowSec, factId);
    return "expiredNow";
  }
  if (action === "expire-soon") {
    (db as { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } })
      .prepare(`UPDATE facts SET expires_at = ?, decay_class = 'normal' WHERE id = ?`)
      .run(nowSec + 7 * SECONDS_PER_DAY, factId);
    return "expiredSoon";
  }
  return "keptStable";
}

/** Compute the resolved action given the GitHub item and config. */
export function resolveActionForItem(item: GitHubItem, cfg: LifecycleGitHubAdapterConfig): LifecycleGitHubAction {
  const onMerged: LifecycleGitHubAction = cfg.onMerged ?? "expire-soon";
  const onClosed: LifecycleGitHubAction = cfg.onClosed ?? "expire-now";
  const onOpen: LifecycleGitHubAction = cfg.onOpen ?? "keep-stable";
  if (item.state === "open") return onOpen;
  if (item.kind === "pr" && item.merged === true) return onMerged;
  return onClosed;
}

/**
 * Wire `lifecycle.adapters.github.{repos,onMerged,onClosed,onOpen}` to the actual fact store.
 * Throws when the adapter is disabled (caller is responsible for early-out at the cron edge).
 */
export async function syncLifecycleFromGitHub(
  factsDb: FactsDB,
  opts: SyncLifecycleFromGitHubOptions,
): Promise<LifecycleSyncReport> {
  const cfg = opts.config;
  if (!cfg.enabled) {
    throw new Error("lifecycle.adapters.github is disabled — set enabled=true to run sync");
  }
  const repos: string[] = [];
  if (cfg.repos && cfg.repos.length > 0) repos.push(...cfg.repos);
  else if (cfg.repo) repos.push(cfg.repo);
  if (repos.length === 0) {
    throw new Error("lifecycle.adapters.github: no repos configured (set `repos` or `repo`)");
  }
  const gh = opts.gh ?? defaultGhClient();
  const apply = opts.apply !== false;
  const logger = opts.logger ?? { info: () => {}, warn: (m) => console.warn(m) };

  const errors: LifecycleSyncReport["errors"] = [];

  // Collect candidate facts whose entity matches a GitHub reference. We scan only active rows;
  // expired facts are not interesting for this sync.
  const db = (factsDb as unknown as { getRawDb?: () => unknown }).getRawDb?.();
  if (!db) throw new Error("syncLifecycleFromGitHub: factsDb does not expose getRawDb()");
  const rows = (
    db as {
      prepare: (sql: string) => {
        all: (...args: unknown[]) => Array<Record<string, unknown>>;
      };
    }
  )
    .prepare(
      `SELECT id, entity FROM facts
       WHERE superseded_at IS NULL
         AND entity IS NOT NULL
         AND (entity LIKE '%PR #%' OR entity LIKE '%Issue #%' OR entity LIKE '%Pull Request #%')`,
    )
    .all() as Array<{ id: string; entity: string | null }>;

  let matched = 0;
  let expiredNow = 0;
  let expiredSoon = 0;
  let keptStable = 0;
  for (const row of rows) {
    const ref = parseGitHubEntity(row.entity);
    if (!ref) continue;
    let resolved: GitHubItem | null = null;
    for (const repo of repos) {
      try {
        const path = ref.kind === "pr" ? `repos/${repo}/pulls/${ref.number}` : `repos/${repo}/issues/${ref.number}`;
        const data = (await gh(path)) as Record<string, unknown> | null;
        if (!data || typeof data !== "object") continue;
        const state = data.state === "closed" ? "closed" : "open";
        const merged = ref.kind === "pr" ? Boolean(data.merged ?? data.merged_at) : false;
        resolved = {
          kind: ref.kind,
          number: ref.number,
          state,
          merged,
          closedAt: typeof data.closed_at === "string" ? data.closed_at : null,
          mergedAt: typeof data.merged_at === "string" ? data.merged_at : null,
        };
        break;
      } catch (err) {
        errors.push({ repo, message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!resolved) continue;
    matched += 1;
    const action = resolveActionForItem(resolved, cfg);
    const bucket = applyAction(factsDb, row.id, action, apply);
    if (bucket === "expiredNow") expiredNow += 1;
    else if (bucket === "expiredSoon") expiredSoon += 1;
    else keptStable += 1;
  }

  if (errors.length > 0) {
    logger.warn(
      `lifecycle.github: ${errors.length} non-fatal repo lookup error(s); first=${errors[0].repo}: ${errors[0].message}`,
    );
  }
  logger.info(
    `lifecycle.github: scanned=${rows.length} matched=${matched} expiredNow=${expiredNow} expiredSoon=${expiredSoon} keptStable=${keptStable}`,
  );

  return {
    ok: true,
    scanned: rows.length,
    matched,
    expiredNow,
    expiredSoon,
    keptStable,
    errors,
  };
}
