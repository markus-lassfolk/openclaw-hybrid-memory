/** Governed, narrowly-scoped operator updates for goal stewardship limits. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hybridConfigSchema } from "../config.js";
import { resolveOpenclawJsonPathForWorkspace } from "../utils/openclaw-workspace.js";
import { getRestartPendingPath } from "../utils/constants.js";
import { getPluginConfigFromFile } from "./cmd-install.js";

const ALLOWED_KEYS = new Set(["globalLimits.maxActiveGoals", "globalLimits.maxDispatchesPerHour"]);
const AUDIT_FILE = "stewardship-settings-audit.jsonl";
const LOCK_FILE = "stewardship-settings.lock";

export interface StewardshipSettingsRequest {
  key: string;
  value: string | number;
  actor: string;
  reason: string;
  approved: boolean;
  dryRun?: boolean;
  requestId?: string;
}
export type StewardshipSettingsResult =
  | { ok: true; changed: boolean; dryRun: boolean; oldValue: number; newValue: number; auditPath: string }
  | { ok: false; error: string };

function auditPath(configPath: string): string {
  return join(dirname(configPath), AUDIT_FILE);
}
function parseValue(value: string | number): number | null {
  const n = typeof value === "number" ? value : /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}
function requestAlreadyApplied(path: string, requestId: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => {
      try {
        return (
          (JSON.parse(line) as { requestId?: string; result?: string }).requestId === requestId &&
          JSON.parse(line).result === "applied"
        );
      } catch {
        return false;
      }
    });
}
function writeAudit(path: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Supported local-operator path. It never calls generic config mutation and only
 * changes one allowlisted goalStewardship limit after explicit approval.
 */
export function runStewardshipSettingsForCli(request: StewardshipSettingsRequest): StewardshipSettingsResult {
  if (!request.approved) return { ok: false, error: "Explicit administrative approval is required (--approve)." };
  if (!ALLOWED_KEYS.has(request.key)) return { ok: false, error: `Unsupported stewardship setting: ${request.key}` };
  if (!request.actor.trim()) return { ok: false, error: "Actor is required." };
  if (!request.reason.trim() || request.reason.trim().length > 500)
    return { ok: false, error: "A reason of 1-500 characters is required." };
  const value = parseValue(request.value);
  if (value === null) return { ok: false, error: `${request.key} must be an integer >= 1.` };

  const configPath = resolveOpenclawJsonPathForWorkspace();
  const aPath = auditPath(configPath);
  if (request.requestId && requestAlreadyApplied(aPath, request.requestId)) {
    return { ok: true, changed: false, dryRun: false, oldValue: value, newValue: value, auditPath: aPath };
  }
  const lockPath = join(dirname(configPath), LOCK_FILE);
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    return { ok: false, error: "Another stewardship settings update is in progress; retry with the same request id." };
  }
  try {
    // Re-read while holding the lock so concurrent approved requests cannot clobber each other.
    const out = getPluginConfigFromFile(configPath);
    if ("error" in out) return { ok: false, error: out.error };
    const gs = out.config.goalStewardship;
    const stewardship = typeof gs === "object" && gs !== null ? { ...(gs as Record<string, unknown>) } : {};
    const globalLimits =
      typeof stewardship.globalLimits === "object" && stewardship.globalLimits !== null
        ? { ...(stewardship.globalLimits as Record<string, unknown>) }
        : {};
    const field = request.key.slice("globalLimits.".length);
    const oldRaw = globalLimits[field];
    const oldValue =
      typeof oldRaw === "number" && Number.isFinite(oldRaw) ? Math.floor(oldRaw) : field === "maxActiveGoals" ? 5 : 6;
    globalLimits[field] = value;
    stewardship.globalLimits = globalLimits;
    const nextConfig = { ...out.config, goalStewardship: stewardship };
    try {
      hybridConfigSchema.parse(nextConfig);
    } catch (err) {
      return { ok: false, error: `Invalid stewardship setting: ${String(err)}` };
    }
    if (request.dryRun)
      return { ok: true, changed: oldValue !== value, dryRun: true, oldValue, newValue: value, auditPath: aPath };

    // Atomic replacement preserves unrelated root/plugin configuration.
    const nextRoot = structuredClone(out.root) as Record<string, unknown>;
    const entries = (nextRoot.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const entry = entries["openclaw-hybrid-memory"] as Record<string, unknown>;
    entry.config = nextConfig;
    const tmp = `${configPath}.stewardship-${process.pid}-${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(nextRoot, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, configPath);
    const event = {
      timestamp: new Date().toISOString(),
      actor: request.actor.trim(),
      reason: request.reason.trim(),
      requestId: request.requestId ?? null,
      key: `goalStewardship.${request.key}`,
      oldValue,
      newValue: value,
      result: "applied",
    };
    writeAudit(aPath, event);
    try {
      writeFileSync(getRestartPendingPath(), "", { encoding: "utf8", mode: 0o600 });
    } catch {
      /* advisory marker */
    }
    return { ok: true, changed: oldValue !== value, dryRun: false, oldValue, newValue: value, auditPath: aPath };
  } finally {
    closeSync(lock!);
    try {
      unlinkSync(lockPath);
    } catch {
      /* lock cleanup is best effort */
    }
  }
}
