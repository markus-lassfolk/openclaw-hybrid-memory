/**
 * Task Queue Dispatch Leases — Issue #634
 *
 * Durable, local idempotency guard for autonomous queue dispatches.
 *
 * - Persists leases under `<stateDir>/dispatch-leases.json`
 * - Uses a lock file to make cross-process acquire/update atomic
 * - Separates queue authority from eventual GitHub branch visibility
 */

import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const LEASES_FILE = "dispatch-leases.json";
const LOCK_FILE = "dispatch-leases.lock";
const LEASES_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;
const STALE_LOCK_MS = 2 * 60 * 1000;

export type DispatchLeaseState = "leased" | "running" | "completed" | "failed" | "lease-expired";

export interface DispatchLeaseRecord {
  issue: number;
  token: string;
  state: DispatchLeaseState;
  branch?: string;
  pid?: number;
  runId?: string;
  attempt: number;
  leasedAt: string;
  expiresAt?: string;
  completedAt?: string;
  reason?: string;
  updatedAt: string;
}

interface DispatchLeaseEvent {
  issue: number;
  token: string;
  state: DispatchLeaseState;
  at: string;
  reason?: string;
}

interface DispatchLeaseRegistry {
  version: number;
  leases: Record<string, DispatchLeaseRecord>;
  events: DispatchLeaseEvent[];
}

export interface AcquireDispatchLeaseInput {
  stateDir: string;
  issue: number;
  branch?: string;
  runId?: string;
  leaseTtlMs?: number;
  now?: Date;
}

export interface AcquireDispatchLeaseResult {
  acquired: boolean;
  lease?: DispatchLeaseRecord;
  existing?: DispatchLeaseRecord;
  reason?: string;
}

export interface TransitionDispatchLeaseInput {
  stateDir: string;
  issue: number;
  token?: string;
  toState: DispatchLeaseState;
  pid?: number;
  reason?: string;
  now?: Date;
}

function issueKey(issue: number): string {
  return String(issue);
}

function makeNowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function parseIsoMs(iso?: string): number {
  if (!iso) return Number.NaN;
  return new Date(iso).getTime();
}

function isActiveState(state: DispatchLeaseState): boolean {
  return state === "leased" || state === "running";
}

function emptyRegistry(): DispatchLeaseRegistry {
  return {
    version: LEASES_SCHEMA_VERSION,
    leases: {},
    events: [],
  };
}

function normalizeRegistry(raw: unknown): DispatchLeaseRegistry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyRegistry();
  }

  const obj = raw as Partial<DispatchLeaseRegistry>;
  const leases: Record<string, DispatchLeaseRecord> = {};
  const rawLeases = obj.leases;
  if (rawLeases && typeof rawLeases === "object" && !Array.isArray(rawLeases)) {
    for (const [key, value] of Object.entries(rawLeases)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const lease = value as Partial<DispatchLeaseRecord>;
      if (typeof lease.issue !== "number" || !Number.isInteger(lease.issue)) continue;
      if (typeof lease.token !== "string" || lease.token.length === 0) continue;
      if (
        lease.state !== "leased" &&
        lease.state !== "running" &&
        lease.state !== "completed" &&
        lease.state !== "failed" &&
        lease.state !== "lease-expired"
      ) {
        continue;
      }
      if (typeof lease.attempt !== "number" || !Number.isInteger(lease.attempt) || lease.attempt <= 0) continue;
      if (typeof lease.leasedAt !== "string" || typeof lease.updatedAt !== "string") continue;

      leases[key] = {
        issue: lease.issue,
        token: lease.token,
        state: lease.state,
        branch: typeof lease.branch === "string" ? lease.branch : undefined,
        pid: typeof lease.pid === "number" ? lease.pid : undefined,
        runId: typeof lease.runId === "string" ? lease.runId : undefined,
        attempt: lease.attempt,
        leasedAt: lease.leasedAt,
        expiresAt: typeof lease.expiresAt === "string" ? lease.expiresAt : undefined,
        completedAt: typeof lease.completedAt === "string" ? lease.completedAt : undefined,
        reason: typeof lease.reason === "string" ? lease.reason : undefined,
        updatedAt: lease.updatedAt,
      };
    }
  }

  const events = Array.isArray(obj.events)
    ? obj.events.filter(
        (evt): evt is DispatchLeaseEvent =>
          !!evt &&
          typeof evt === "object" &&
          !Array.isArray(evt) &&
          typeof (evt as DispatchLeaseEvent).issue === "number" &&
          typeof (evt as DispatchLeaseEvent).token === "string" &&
          typeof (evt as DispatchLeaseEvent).state === "string" &&
          typeof (evt as DispatchLeaseEvent).at === "string",
      )
    : [];

  return {
    version: LEASES_SCHEMA_VERSION,
    leases,
    events,
  };
}

async function loadRegistry(filePath: string): Promise<DispatchLeaseRegistry> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizeRegistry(JSON.parse(raw));
  } catch {
    return emptyRegistry();
  }
}

async function writeRegistry(filePath: string, registry: DispatchLeaseRegistry): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
  await rename(tmpPath, filePath);
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf-8");
    await fh.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    return false;
  }
}

async function isLockStale(lockPath: string, nowMs: number): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return nowMs - lockStat.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

async function withRegistryLock<T>(stateDir: string, fn: (registryPath: string) => Promise<T>): Promise<T> {
  await mkdir(stateDir, { recursive: true });
  const registryPath = join(stateDir, LEASES_FILE);
  const lockPath = join(stateDir, LOCK_FILE);

  const start = Date.now();
  while (true) {
    const acquired = await tryAcquireLock(lockPath);
    if (acquired) break;

    const nowMs = Date.now();
    if (await isLockStale(lockPath, nowMs)) {
      try {
        await unlink(lockPath);
      } catch {
        // Another process may have cleaned it; keep retrying.
      }
      continue;
    }

    if (nowMs - start > DEFAULT_LOCK_TIMEOUT_MS) {
      throw new Error("Timed out waiting for task queue lease lock");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, LOCK_POLL_MS);
    });
  }

  try {
    return await fn(registryPath);
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      // Ignore lock cleanup errors.
    }
  }
}

function pushEvent(registry: DispatchLeaseRegistry, lease: DispatchLeaseRecord, reason?: string): void {
  registry.events.push({
    issue: lease.issue,
    token: lease.token,
    state: lease.state,
    at: lease.updatedAt,
    reason,
  });

  // Keep recent events bounded.
  if (registry.events.length > 500) {
    registry.events.splice(0, registry.events.length - 500);
  }
}

function expireActiveLeases(registry: DispatchLeaseRegistry, now: Date): boolean {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  let changed = false;

  for (const lease of Object.values(registry.leases)) {
    if (!isActiveState(lease.state)) continue;
    const expiresAtMs = parseIsoMs(lease.expiresAt);
    if (!Number.isFinite(expiresAtMs) || nowMs <= expiresAtMs) continue;

    lease.state = "lease-expired";
    lease.reason = `lease expired at ${lease.expiresAt}`;
    lease.completedAt = nowIso;
    lease.updatedAt = nowIso;
    pushEvent(registry, lease, lease.reason);
    changed = true;
  }

  return changed;
}

export async function getDispatchLease(stateDir: string, issue: number): Promise<DispatchLeaseRecord | null> {
  const registryPath = join(stateDir, LEASES_FILE);
  if (!existsSync(registryPath)) return null;
  const registry = await loadRegistry(registryPath);
  return registry.leases[issueKey(issue)] ?? null;
}

export async function acquireDispatchLease(input: AcquireDispatchLeaseInput): Promise<AcquireDispatchLeaseResult> {
  const now = input.now ?? new Date();
  const nowIso = makeNowIso(now);

  return withRegistryLock(input.stateDir, async (registryPath) => {
    const registry = await loadRegistry(registryPath);
    const changedByExpiry = expireActiveLeases(registry, now);

    const key = issueKey(input.issue);
    const existing = registry.leases[key];
    if (existing && isActiveState(existing.state)) {
      if (changedByExpiry) {
        await writeRegistry(registryPath, registry);
      }
      return {
        acquired: false,
        existing,
        reason: `issue #${input.issue} already has active lease (${existing.state})`,
      };
    }

    const attempt = existing ? existing.attempt + 1 : 1;
    const ttlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

    const lease: DispatchLeaseRecord = {
      issue: input.issue,
      token: randomUUID(),
      state: "leased",
      branch: input.branch,
      runId: input.runId,
      attempt,
      leasedAt: nowIso,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      updatedAt: nowIso,
      reason: undefined,
    };

    registry.leases[key] = lease;
    pushEvent(registry, lease, "lease acquired");
    await writeRegistry(registryPath, registry);

    return {
      acquired: true,
      lease,
    };
  });
}

export async function transitionDispatchLease(input: TransitionDispatchLeaseInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  return withRegistryLock(input.stateDir, async (registryPath) => {
    const registry = await loadRegistry(registryPath);
    const changedByExpiry = expireActiveLeases(registry, now);

    const key = issueKey(input.issue);
    const lease = registry.leases[key];
    if (!lease) {
      if (changedByExpiry) {
        await writeRegistry(registryPath, registry);
      }
      return false;
    }

    if (input.token && lease.token !== input.token) {
      if (changedByExpiry) {
        await writeRegistry(registryPath, registry);
      }
      return false;
    }

    if (input.toState === "leased") {
      // Explicitly disallow transitioning back to leased from the API.
      if (changedByExpiry) {
        await writeRegistry(registryPath, registry);
      }
      return false;
    }

    lease.state = input.toState;
    lease.updatedAt = nowIso;

    if (input.pid != null) {
      lease.pid = input.pid;
    }

    if (input.toState === "running") {
      // Refresh expiry while work is active.
      lease.expiresAt = undefined;
    } else {
      lease.completedAt = nowIso;
    }

    if (input.reason) {
      lease.reason = input.reason;
    }

    pushEvent(registry, lease, input.reason);
    await writeRegistry(registryPath, registry);
    return true;
  });
}

export async function expireDispatchLeases(stateDir: string, now?: Date): Promise<number> {
  return withRegistryLock(stateDir, async (registryPath) => {
    const registry = await loadRegistry(registryPath);
    const before = Object.values(registry.leases).filter((l) => l.state === "lease-expired").length;
    const changed = expireActiveLeases(registry, now ?? new Date());
    if (!changed) return 0;
    const after = Object.values(registry.leases).filter((l) => l.state === "lease-expired").length;
    await writeRegistry(registryPath, registry);
    return Math.max(0, after - before);
  });
}

export async function readDispatchLeaseRegistry(stateDir: string): Promise<DispatchLeaseRegistry> {
  const registryPath = join(stateDir, LEASES_FILE);
  return loadRegistry(registryPath);
}
