/**
 * Task Queue Dispatch Leases — Issue #634
 *
 * Durable, local idempotency guard for autonomous queue dispatches.
 *
 * - Persists leases under `<stateDir>/dispatch-leases.json`
 * - Uses a lock file to make cross-process acquire/update atomic
 * - Separates queue authority from eventual GitHub branch visibility
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nowIso, parseTimestampMs, formatTimestampUtcFromMs } from "../utils/dates.js";

const LEASES_FILE = "dispatch-leases.json";
const LOCK_FILE = "dispatch-leases.lock";
const LEASES_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_COMPLETED_VISIBILITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;
const STALE_LOCK_MS = 2 * 60 * 1000;

type DispatchLeaseState = "leased" | "running" | "completed" | "failed" | "lease-expired";

interface DispatchLeaseRecord {
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

interface AcquireDispatchLeaseInput {
  stateDir: string;
  issue: number;
  branch?: string;
  runId?: string;
  leaseTtlMs?: number;
  now?: Date;
}

interface AcquireDispatchLeaseResult {
  acquired: boolean;
  lease?: DispatchLeaseRecord;
  existing?: DispatchLeaseRecord;
  reason?: string;
}

interface TransitionDispatchLeaseInput {
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
  return now ? formatTimestampUtcFromMs(now.getTime()) : nowIso();
}

function parseIsoMs(iso?: string): number {
  if (!iso) return Number.NaN;
  return parseTimestampMs(iso) ?? Number.NaN;
}

function isActiveState(state: DispatchLeaseState): boolean {
  return state === "leased" || state === "running";
}

function blocksAcquire(lease: DispatchLeaseRecord, now: Date): boolean {
  if (isActiveState(lease.state)) {
    return true;
  }

  if (lease.state !== "completed") {
    return false;
  }

  let expiresAtMs = parseIsoMs(lease.expiresAt);

  // For legacy or partially written records that lack expiresAt, fall back to
  // completedAt + DEFAULT_COMPLETED_VISIBILITY_WINDOW_MS to enforce cooldown.
  if (!Number.isFinite(expiresAtMs)) {
    const completedAtMs = parseIsoMs(lease.completedAt);
    if (Number.isFinite(completedAtMs)) {
      expiresAtMs = completedAtMs + DEFAULT_COMPLETED_VISIBILITY_WINDOW_MS;
    }
  }

  return Number.isFinite(expiresAtMs) && now.getTime() < expiresAtMs;
}

function formatAcquireBlockReason(issue: number, lease: DispatchLeaseRecord): string {
  if (isActiveState(lease.state)) {
    return `issue #${issue} already has active lease (${lease.state})`;
  }

  return `issue #${issue} is cooling down after completed dispatch (${lease.state})`;
}

function emptyRegistry(): DispatchLeaseRegistry {
  return {
    version: LEASES_SCHEMA_VERSION,
    leases: Object.create(null) as Record<string, DispatchLeaseRecord>,
    events: [],
  };
}

function normalizeRegistry(raw: unknown): DispatchLeaseRegistry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyRegistry();
  }

  const obj = raw as Partial<DispatchLeaseRegistry>;
  const leases: Record<string, DispatchLeaseRecord> = Object.create(null) as Record<string, DispatchLeaseRecord>;
  const rawLeases = obj.leases;
  if (rawLeases && typeof rawLeases === "object" && !Array.isArray(rawLeases)) {
    for (const [key, value] of Object.entries(rawLeases)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
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
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(lockPath, "wx");
    await fh.writeFile(`${process.pid}\n${nowIso()}\n`, "utf-8");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    return false;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        // Ignore close errors to avoid masking earlier failures.
      }
    }
  }
}

async function getLockMtimeMs(lockPath: string): Promise<number | null> {
  try {
    const lockStat = await stat(lockPath);
    return lockStat.mtimeMs;
  } catch {
    return null;
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
    const staleMtimeMs = await getLockMtimeMs(lockPath);
    if (staleMtimeMs !== null && nowMs - staleMtimeMs > STALE_LOCK_MS) {
      try {
        // Re-check the lock's mtime immediately before deleting it: if another process
        // refreshed or re-acquired the lock between our staleness check above and this
        // point, its mtime will have changed, and unlinking now would steal a lock that
        // process legitimately holds. Only unlink when the mtime we judged stale is the
        // same one still on disk.
        const currentMtimeMs = await getLockMtimeMs(lockPath);
        if (currentMtimeMs === staleMtimeMs) {
          await unlink(lockPath);
        }
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
  const nowIsoStr = formatTimestampUtcFromMs(nowMs);
  let changed = false;

  for (const lease of Object.values(registry.leases)) {
    if (!isActiveState(lease.state)) continue;
    const expiresAtMs = parseIsoMs(lease.expiresAt);
    if (!Number.isFinite(expiresAtMs) || nowMs <= expiresAtMs) continue;

    lease.state = "lease-expired";
    lease.reason = `lease expired at ${lease.expiresAt}`;
    lease.completedAt = nowIsoStr;
    lease.updatedAt = nowIsoStr;
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
    if (existing && blocksAcquire(existing, now)) {
      if (changedByExpiry) {
        await writeRegistry(registryPath, registry);
      }
      return {
        acquired: false,
        existing,
        reason: formatAcquireBlockReason(input.issue, existing),
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
      expiresAt: formatTimestampUtcFromMs(now.getTime() + ttlMs),
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
  const nowIsoStr = makeNowIso(now);

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

    // Prevent transitions from terminal states to preserve audit trail.
    if (!isActiveState(lease.state)) {
      if (changedByExpiry) {
        await writeRegistry(registryPath, registry);
      }
      return false;
    }

    lease.state = input.toState;
    lease.updatedAt = nowIsoStr;

    if (input.pid != null) {
      lease.pid = input.pid;
    }

    if (input.toState === "running") {
      // Refresh expiry while work is active: give the lease a fresh TTL window from the moment
      // work starts, rather than clearing expiresAt entirely. A cleared expiresAt is unparseable
      // (parseIsoMs -> NaN), so expireActiveLeases() can never reclaim this lease again — a
      // worker that crashes after transitioning to "running" without ever reaching a terminal
      // state would otherwise leave the issue permanently un-dispatchable.
      lease.expiresAt = formatTimestampUtcFromMs(now.getTime() + DEFAULT_LEASE_TTL_MS);
    } else if (input.toState === "completed") {
      lease.completedAt = nowIsoStr;
      // NOTE: `expiresAt` is overloaded:
      // - for active/leased states, it represents the lease TTL;
      // - for the `completed` state, it acts as a visibility cooldown / acquire-block-until timestamp.
      lease.expiresAt = formatTimestampUtcFromMs(now.getTime() + DEFAULT_COMPLETED_VISIBILITY_WINDOW_MS);
    } else {
      // Other terminal states clear `expiresAt`; callers must not assume it is set for all non-active states.
      lease.completedAt = nowIsoStr;
      lease.expiresAt = undefined;
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
