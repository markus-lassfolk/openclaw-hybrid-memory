/**
 * Dispatch Lease Registry — Issue #634
 *
 * Prevents the autonomous queue from dispatching the same GitHub issue multiple
 * times before branch visibility catches up on GitHub. A lease is acquired
 * immediately before launching Forge and acts as the authoritative source of
 * truth for "is this issue already in-flight?" — independent of GitHub
 * eventual consistency.
 *
 * Lease lifecycle:
 *   leased       — acquired just before Forge is launched
 *   running      — confirmed running (PID / agent confirmed active)
 *   completed    — terminal: PR created or task finished successfully
 *   failed       — terminal: Forge run ended with an error
 *   lease-expired — lease TTL elapsed without a terminal update
 *
 * Persistence:
 *   Each lease is stored as `<leasesDir>/issue-<number>.json`.
 *   Only one active lease per issue number is allowed at a time.
 *   The directory defaults to
 *   `~/.openclaw/workspace/state/task-queue/leases/`.
 *
 * Addressing Engineering Goal 1: Rock-Solid Stability
 * Addressing Product Goal 4: Autonomous Maintenance
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lifecycle status of a dispatch lease. */
export type DispatchLeaseStatus = "leased" | "running" | "completed" | "failed" | "lease-expired";

/** Terminal statuses — once reached the lease will not block future dispatches. */
const TERMINAL_STATUSES: ReadonlySet<DispatchLeaseStatus> = new Set(["completed", "failed", "lease-expired"]);

/** A single dispatch lease record persisted to disk. */
export interface DispatchLease {
  /** The GitHub issue number being dispatched. */
  issueNumber: number;
  /** Opaque UUID uniquely identifying this dispatch attempt. */
  token: string;
  /** Current lifecycle status. */
  status: DispatchLeaseStatus;
  /** ISO-8601 timestamp when the lease was first acquired. */
  dispatchedAt: string;
  /** ISO-8601 timestamp after which the lease is considered expired. */
  expiresAt: string;
  /** ISO-8601 timestamp of the last status update. */
  updatedAt: string;
  /** Expected git branch name for this dispatch (optional). */
  branch?: string;
  /** ISO-8601 timestamp when a terminal state was reached (optional). */
  completedAt?: string;
  /** Human-readable notes about the outcome (optional). */
  details?: string;
}

/** Configuration for DispatchLeaseRegistry. */
export interface DispatchLeaseRegistryConfig {
  /**
   * Directory that holds lease files.
   * Defaults to `~/.openclaw/workspace/state/task-queue/leases`.
   */
  leasesDir?: string;
  /**
   * How long a lease stays active before it auto-expires (in ms).
   * Defaults to 24 hours.
   */
  defaultTtlMs?: number;
}

/** Returned by acquireLease(). */
export type AcquireLeaseResult =
  | { acquired: true; lease: DispatchLease }
  | { acquired: false; existing: DispatchLease };

/** Input for acquireLease(). */
export interface AcquireLeaseInput {
  /** Issue number to lease. */
  issueNumber: number;
  /** Optional branch name to store in the lease. */
  branch?: string;
  /** Override the default TTL for this lease (ms). */
  ttlMs?: number;
}

/** Input for updateLease(). */
export interface UpdateLeaseInput {
  /** New status. */
  status: DispatchLeaseStatus;
  /** Updated branch (if known). */
  branch?: string;
  /** Human-readable notes. */
  details?: string;
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<string>(["leased", "running", "completed", "failed", "lease-expired"]);

/**
 * Returns `true` when `value` has the required shape of a `DispatchLease`.
 * Guards against corrupted lease files written by external processes.
 */
function isValidLease(value: unknown): value is DispatchLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.issueNumber === "number" &&
    Number.isInteger(v.issueNumber) &&
    v.issueNumber > 0 &&
    typeof v.token === "string" &&
    v.token.length > 0 &&
    typeof v.status === "string" &&
    VALID_STATUSES.has(v.status) &&
    typeof v.dispatchedAt === "string" &&
    typeof v.expiresAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

// ---------------------------------------------------------------------------
// DispatchLeaseRegistry
// ---------------------------------------------------------------------------

/**
 * File-backed registry that maps GitHub issue numbers to their current
 * dispatch leases. Survives process restarts.
 */
export class DispatchLeaseRegistry {
  private readonly leasesDir: string;
  private readonly defaultTtlMs: number;

  constructor(config: DispatchLeaseRegistryConfig = {}) {
    this.leasesDir =
      config.leasesDir ??
      join(homedir(), ".openclaw", "workspace", "state", "task-queue", "leases");
    this.defaultTtlMs = config.defaultTtlMs ?? 24 * 60 * 60 * 1000; // 24 hours
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private leasePath(issueNumber: number): string {
    return join(this.leasesDir, `issue-${issueNumber}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.leasesDir, { recursive: true });
  }

  /** Read a lease from disk; returns null on any error or invalid shape. */
  private async readLease(issueNumber: number): Promise<DispatchLease | null> {
    const filePath = this.leasePath(issueNumber);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      return isValidLease(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Write a lease atomically: write to a `.tmp` file then rename into place.
   * This prevents partial writes from corrupting an existing lease.
   */
  private async writeLease(lease: DispatchLease): Promise<void> {
    await this.ensureDir();
    const finalPath = this.leasePath(lease.issueNumber);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(lease, null, 2), "utf-8");
    await rename(tmpPath, finalPath);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Attempt to acquire a lease for the given issue number.
   *
   * - If no active lease exists (or the existing one is terminal/expired),
   *   creates a new lease with status `leased` and returns
   *   `{ acquired: true, lease }`.
   * - If an active non-expired lease exists, returns
   *   `{ acquired: false, existing }` without modifying anything.
   */
  async acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    const existing = await this.readLease(input.issueNumber);

    if (existing !== null) {
      const isTerminal = TERMINAL_STATUSES.has(existing.status);
      const isExpired = new Date(existing.expiresAt).getTime() <= Date.now();

      if (!isTerminal && !isExpired) {
        // Active lease — block the new dispatch
        return { acquired: false, existing };
      }
    }

    const now = new Date().toISOString();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const lease: DispatchLease = {
      issueNumber: input.issueNumber,
      token: randomUUID(),
      status: "leased",
      dispatchedAt: now,
      expiresAt,
      updatedAt: now,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    };

    await this.writeLease(lease);
    return { acquired: true, lease };
  }

  /**
   * Update the status (and optional metadata) of an existing lease.
   *
   * The `token` must match the one returned by `acquireLease()` to prevent
   * stale writers from clobbering a newer lease for the same issue.
   *
   * Returns the updated lease, or `null` if the lease no longer exists or
   * the token does not match.
   */
  async updateLease(
    issueNumber: number,
    token: string,
    patch: UpdateLeaseInput,
  ): Promise<DispatchLease | null> {
    const existing = await this.readLease(issueNumber);
    if (!existing || existing.token !== token) return null;

    const now = new Date().toISOString();
    const isTerminal = TERMINAL_STATUSES.has(patch.status);

    const updated: DispatchLease = {
      ...existing,
      status: patch.status,
      updatedAt: now,
      ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
      ...(patch.details !== undefined ? { details: patch.details } : {}),
      ...(isTerminal ? { completedAt: now } : {}),
    };

    await this.writeLease(updated);
    return updated;
  }

  /**
   * Retrieve the active (non-terminal, non-expired) lease for an issue.
   * Returns `null` if no such lease exists.
   */
  async getActiveLease(issueNumber: number): Promise<DispatchLease | null> {
    const lease = await this.readLease(issueNumber);
    if (!lease) return null;

    const isTerminal = TERMINAL_STATUSES.has(lease.status);
    const isExpired = new Date(lease.expiresAt).getTime() <= Date.now();

    if (isTerminal || isExpired) return null;
    return lease;
  }

  /**
   * Mark a lease as having reached a terminal state (`completed` or `failed`).
   *
   * The token must match the lease's stored token. Returns `null` if the
   * lease does not exist or the token is wrong.
   */
  async releaseLease(
    issueNumber: number,
    token: string,
    finalStatus: "completed" | "failed",
    details?: string,
  ): Promise<DispatchLease | null> {
    return this.updateLease(issueNumber, token, {
      status: finalStatus,
      ...(details !== undefined ? { details } : {}),
    });
  }

  /**
   * Scan all lease files and mark any whose TTL has elapsed as
   * `lease-expired`. Returns the list of leases that were expired.
   */
  async expireStaleLeases(): Promise<DispatchLease[]> {
    if (!existsSync(this.leasesDir)) return [];

    let files: string[];
    try {
      files = (await readdir(this.leasesDir)).filter(
        (f) => f.startsWith("issue-") && f.endsWith(".json"),
      );
    } catch {
      return [];
    }

    const expired: DispatchLease[] = [];
    const now = Date.now();

    for (const file of files) {
      const filePath = join(this.leasesDir, file);
      let lease: DispatchLease | null = null;
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
        lease = isValidLease(parsed) ? parsed : null;
      } catch {
        continue;
      }
      if (!lease) continue;

      if (TERMINAL_STATUSES.has(lease.status)) continue;
      if (new Date(lease.expiresAt).getTime() > now) continue;

      const expiredLease: DispatchLease = {
        ...lease,
        status: "lease-expired",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      try {
        await this.writeLease(expiredLease);
        expired.push(expiredLease);
      } catch {
        // Non-fatal — leave the lease as-is
      }
    }

    return expired;
  }

  /**
   * Delete the lease file for an issue. Used for cleanup after a confirmed
   * terminal state or during testing. Silently ignores missing files.
   */
  async deleteLease(issueNumber: number): Promise<void> {
    try {
      await unlink(this.leasePath(issueNumber));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * List all leases currently stored on disk, regardless of status.
   * Sorted by `dispatchedAt` descending (newest first).
   */
  async listLeases(): Promise<DispatchLease[]> {
    if (!existsSync(this.leasesDir)) return [];

    let files: string[];
    try {
      files = (await readdir(this.leasesDir)).filter(
        (f) => f.startsWith("issue-") && f.endsWith(".json"),
      );
    } catch {
      return [];
    }

    const leases: DispatchLease[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(this.leasesDir, file), "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (isValidLease(parsed)) leases.push(parsed);
      } catch {
        // Skip unreadable files
      }
    }

    leases.sort(
      (a, b) => new Date(b.dispatchedAt).getTime() - new Date(a.dispatchedAt).getTime(),
    );
    return leases;
  }

  /**
   * Return `true` if the given issue has an active (non-terminal, non-expired)
   * lease. Convenience wrapper around `getActiveLease()`.
   */
  async isLeased(issueNumber: number): Promise<boolean> {
    return (await this.getActiveLease(issueNumber)) !== null;
  }
}
