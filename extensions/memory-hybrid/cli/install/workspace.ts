/**
 * CLI Install/Uninstall/Upgrade Command Handlers
 *
 * Contains all install-related functions extracted from handlers.ts:
 * - buildPreFilterConfig
 * - Cron constants and helpers (PLUGIN_JOB_ID_PREFIX, MIN_INTERVAL_MS,
 *   MAINTENANCE_CRON_JOBS, LEGACY_JOB_MATCHERS, resolveCronJob,
 *   ensureMaintenanceCronJobs, createProgressReporter)
 * - deepMerge
 * - runResetAuthBackoffForCli
 * - runInstallForCli
 * - runUninstallForCli
 * - runUpgradeForCli
 */

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as pathResolve, relative } from "node:path";

import { atomicWriteFile } from "../../utils/atomic-write.js";
import { getEnv } from "../../utils/env-manager.js";
import { expandTilde } from "../../utils/path.js";
import { escapeRegExp } from "../../utils/text.js";
import {
  loadOpenclawRootForWorkspace,
  resolveAgentWorkspaceRoot,
  resolveOpenclawJsonPathForWorkspace,
} from "../../utils/openclaw-workspace.js";
export { loadOpenclawRootForWorkspace, resolveAgentWorkspaceRoot, resolveOpenclawJsonPathForWorkspace };
import {
  TOOLS_MD_MANAGED_BEGIN,
  TOOLS_MD_MANAGED_END,
} from "../../services/tools-md-rewrite.js";

import type { HybridMemoryConfig } from "../../config.js";
import { compileHeartbeatMatchers } from "../../services/goal-stewardship-heartbeat.js";
import type { PreFilterConfig } from "../../services/session-pre-filter.js";

/** Subfolder under workspace `skills/` — OpenClaw loads this with highest precedence vs shared/bundled skills. */
const HYBRID_MEMORY_SKILL_DIR = "hybrid-memory";

/** Returns a unique sibling temp-dir path under `skillsDir` for atomic rename into `destDir`. */
function skillTmpDir(skillsDir: string): string {
  return join(skillsDir, `.${HYBRID_MEMORY_SKILL_DIR}-tmp-${randomBytes(6).toString("hex")}`);
}

function resolvedPathOrFallback(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return pathResolve(path);
  }
}

export function isPathInsideDir(rootDirAbs: string, candidatePath: string): boolean {
  const rootResolved = resolvedPathOrFallback(rootDirAbs);
  const candidateAbs = isAbsolute(candidatePath) ? candidatePath : pathResolve(candidatePath);
  const candidateResolved = resolvedPathOrFallback(candidateAbs);
  const rel = relative(rootResolved, candidateResolved);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function hasNoWhitespace(s: string): boolean {
  return !/[\s\r\n\t]/.test(s);
}

export function npxExecutable(): string {
  if (process.platform !== "win32") return "npx";
  const candidate = join(dirname(process.execPath), "npx.cmd");
  return existsSync(candidate) ? candidate : "npx.cmd";
}

export function assertSafeRequestedVersionArg(version: string): void {
  const v = version.trim();
  if (!v) throw new Error("Upgrade version is empty");
  if (!hasNoWhitespace(v)) throw new Error("Upgrade version contains whitespace");
  if (v.startsWith("-")) throw new Error("Upgrade version must not start with '-'");
}

function bundledHybridMemorySkillDir(pluginRootDir: string): string {
  return join(pluginRootDir, "skills", HYBRID_MEMORY_SKILL_DIR);
}

function bundledHybridMemorySkillPath(pluginRootDir: string): string {
  return join(bundledHybridMemorySkillDir(pluginRootDir), "SKILL.md");
}

/** @internal Exported for tests — copies bundled `skills/hybrid-memory/` (SKILL.md + references/) into the workspace. */
export function installHybridMemoryWorkspaceSkill(opts: {
  mergedOpenclawConfig: Record<string, unknown>;
  pluginRootDir: string;
  dryRun: boolean;
}): { path: string; error?: string } {
  const srcDir = bundledHybridMemorySkillDir(opts.pluginRootDir);
  const skillMd = bundledHybridMemorySkillPath(opts.pluginRootDir);
  const workspaceRoot = resolveAgentWorkspaceRoot(opts.mergedOpenclawConfig);
  const dest = join(workspaceRoot, "skills", HYBRID_MEMORY_SKILL_DIR, "SKILL.md");
  if (!existsSync(skillMd)) {
    return { path: dest, error: `Bundled skill missing at ${skillMd}` };
  }
  if (opts.dryRun) {
    return { path: dest };
  }
  try {
    const skillsDir = join(workspaceRoot, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const destDir = join(skillsDir, HYBRID_MEMORY_SKILL_DIR);
    const tmpDir = skillTmpDir(skillsDir);
    let destRemoved = false;
    try {
      cpSync(srcDir, tmpDir, { recursive: true });
      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
        destRemoved = true;
      }
      renameSync(tmpDir, destDir);
    } catch (copyErr) {
      // Only clean up tmpDir if destDir wasn't removed — otherwise tmpDir is the only remaining copy
      if (!destRemoved) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore temp-cleanup failure */
        }
      }
      throw copyErr;
    }
    return { path: dest };
  } catch (err) {
    return { path: dest, error: String(err) };
  }
}

/**
 * Copy bundled `skills/hybrid-memory/` into the workspace **only when** `{workspace}/skills/hybrid-memory/SKILL.md`
 * is missing — so the skill appears without a manual `hybrid-mem install`, without overwriting operator edits on every restart.
 * Full overwrite (including references) remains the job of `installHybridMemoryWorkspaceSkill` from **`hybrid-mem install`**.
 */
export function ensureHybridMemoryWorkspaceSkillIfMissing(opts: {
  pluginRootDir: string;
  mergedOpenclawConfig: Record<string, unknown>;
}): {
  path: string;
  deployed: boolean;
  skippedReason?: "already_exists" | "bundled_missing" | string;
} {
  const skillMd = bundledHybridMemorySkillPath(opts.pluginRootDir);
  const workspaceRoot = resolveAgentWorkspaceRoot(opts.mergedOpenclawConfig);
  const destDir = join(workspaceRoot, "skills", HYBRID_MEMORY_SKILL_DIR);
  const dest = join(destDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    return { path: dest, deployed: false, skippedReason: "bundled_missing" };
  }
  if (existsSync(dest)) {
    return { path: dest, deployed: false, skippedReason: "already_exists" };
  }
  if (existsSync(destDir)) {
    try {
      mkdirSync(destDir, { recursive: true });
      cpSync(skillMd, dest);
      const srcRefs = join(bundledHybridMemorySkillDir(opts.pluginRootDir), "references");
      const destRefs = join(destDir, "references");
      if (existsSync(srcRefs) && !existsSync(destRefs)) {
        cpSync(srcRefs, destRefs, { recursive: true });
      }
      return { path: dest, deployed: true };
    } catch (err) {
      return { path: dest, deployed: false, skippedReason: String(err) };
    }
  }
  try {
    const skillsDir = join(workspaceRoot, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const srcDir = bundledHybridMemorySkillDir(opts.pluginRootDir);
    const tmpDir = skillTmpDir(skillsDir);
    try {
      cpSync(srcDir, tmpDir, { recursive: true });
      renameSync(tmpDir, destDir);
    } catch (copyErr) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore temp-cleanup failure */
      }
      throw copyErr;
    }
    return { path: dest, deployed: true };
  } catch (err) {
    return { path: dest, deployed: false, skippedReason: String(err) };
  }
}

export { TOOLS_MD_MANAGED_BEGIN, TOOLS_MD_MANAGED_END } from "../../services/tools-md-rewrite.js";

function getToolsMdManagedBlockRe(): RegExp {
  return new RegExp(`${escapeRegExp(TOOLS_MD_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(TOOLS_MD_MANAGED_END)}`);
}

/** True if applying the managed block would modify `existing` (append, replace, or replace with different body). */
function toolsMdManagedBlockWouldChange(existing: string, newBlock: string): boolean {
  const re = getToolsMdManagedBlockRe();
  if (!re.test(existing)) return true;
  return existing.replace(re, newBlock) !== existing;
}

function buildHybridMemoryToolsMdManagedBlock(innerBody: string): string {
  const inner = innerBody.trimEnd();
  return [
    TOOLS_MD_MANAGED_BEGIN,
    "",
    "## Hybrid memory (`openclaw-hybrid-memory`)",
    "",
    "_This section is refreshed by `openclaw hybrid-mem install` / `upgrade`. Add your own tool notes elsewhere in this file._",
    "",
    inner,
    "",
    TOOLS_MD_MANAGED_END,
  ].join("\n");
}

/** @internal Merges or refreshes the managed Hybrid memory block in workspace `TOOLS.md`. */
export function applyHybridMemoryToolsMd(opts: {
  mergedOpenclawConfig: Record<string, unknown>;
  pluginRootDir: string;
  dryRun: boolean;
}): { path: string; error?: string; updated: boolean } {
  const workspaceRoot = resolveAgentWorkspaceRoot(opts.mergedOpenclawConfig);
  const toolsPath = join(workspaceRoot, "TOOLS.md");
  const snippetPath = join(opts.pluginRootDir, "workspace-snippets", "TOOLS-hybrid-memory-body.md");
  if (!existsSync(snippetPath)) {
    return { path: toolsPath, error: `Bundled TOOLS snippet missing at ${snippetPath}`, updated: false };
  }
  let innerBody: string;
  try {
    innerBody = readFileSync(snippetPath, "utf-8");
  } catch (err) {
    return { path: toolsPath, error: String(err), updated: false };
  }
  const block = buildHybridMemoryToolsMdManagedBlock(innerBody);
  if (opts.dryRun) {
    let wouldChange = !existsSync(toolsPath);
    if (!wouldChange && existsSync(toolsPath)) {
      try {
        const cur = readFileSync(toolsPath, "utf-8");
        wouldChange = !cur.includes(TOOLS_MD_MANAGED_BEGIN) || toolsMdManagedBlockWouldChange(cur, block);
      } catch {
        wouldChange = true;
      }
    }
    return { path: toolsPath, updated: wouldChange };
  }
  const managedRe = getToolsMdManagedBlockRe();
  try {
    mkdirSync(workspaceRoot, { recursive: true });
    if (!existsSync(toolsPath)) {
      atomicWriteFile(toolsPath, `# TOOLS\n\n${block}\n`);
      return { path: toolsPath, updated: true };
    }
    const existing = readFileSync(toolsPath, "utf-8");
    if (managedRe.test(existing)) {
      const next = existing.replace(managedRe, block);
      if (next !== existing) {
        atomicWriteFile(toolsPath, next);
        return { path: toolsPath, updated: true };
      }
      return { path: toolsPath, updated: false };
    }
    atomicWriteFile(toolsPath, `${existing.trimEnd()}\n\n${block}\n`);
    return { path: toolsPath, updated: true };
  } catch (err) {
    return { path: toolsPath, error: String(err), updated: false };
  }
}

/**
 * Build a PreFilterConfig from the plugin config.
 * Resolves the Ollama endpoint from extraction.preFilter.endpoint,
 * then llm.providers.ollama.baseURL, then the default localhost URL.
 */
export function buildPreFilterConfig(cfg: HybridMemoryConfig): PreFilterConfig {
  const pf = cfg.extraction?.preFilter;
  const ollamaEndpoint = pf?.endpoint ?? cfg.llm?.providers?.ollama?.baseURL ?? "http://localhost:11434";
  return {
    enabled: pf?.enabled === true,
    model: pf?.model ?? "qwen3:8b",
    endpoint: ollamaEndpoint,
    maxCharsPerSession: pf?.maxCharsPerSession ?? 2000,
  };
}
// Re-export preFilterSessions so callers in other handler modules can import from here.

// Shared cron job definitions used by install and verify --fix.
// Canonical schedule per #86 (7 jobs, non-overlapping). Model is resolved dynamically from user config via getLLMModelPreference.
// modelTier: "default" = standard LLM, "heavy" = larger context; resolved via getDefaultCronModel at install/verify time.
// Order: daily 02:00 → daily 02:30 → Sun 03:00 → Sun 04:00 → Sat 04:00 → Sun 10:00 → 1st 05:00.
export const PLUGIN_JOB_ID_PREFIX = "hybrid-mem:";
export const GOAL_STEWARDSHIP_HEARTBEAT_JOB_ID = "goal-stewardship-heartbeat";
export const GOAL_STEWARDSHIP_HEARTBEAT_CRON_EXPR = "*/30 * * * *";

function extractPlainHeartbeatPatternHints(patterns: string[]): string[] {
  const out: string[] = [];
  for (const rawPattern of patterns) {
    const raw = rawPattern.trim();
    if (!raw) continue;
    let hint: string | null = null;
    if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
      const last = raw.lastIndexOf("/");
      const body = raw.slice(1, last).trim().replace(/^\^/, "").replace(/\$$/, "").trim();
      if (/^[\w -]+$/.test(body)) hint = body;
    } else if (/^[\w -]+$/.test(raw)) {
      hint = raw;
    }
    if (!hint) continue;
    const normalized = hint.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function selectGoalStewardshipHeartbeatMessage(heartbeatPatterns: string[]): string | null {
  const matchers = compileHeartbeatMatchers(heartbeatPatterns);
  const candidates = ["cron heartbeat"];
  for (const hint of extractPlainHeartbeatPatternHints(heartbeatPatterns)) {
    const candidate = `cron heartbeat ${hint}`.replace(/\s+/g, " ").trim();
    if (!candidates.includes(candidate)) candidates.push(candidate);
    if (!candidates.includes(hint)) candidates.push(hint);
  }
  return candidates.find((candidate) => matchers.some((re) => re.test(candidate))) ?? null;
}

function collectHeartbeatMessageCandidatesFromJob(job: Record<string, unknown>): string[] {
  const out: string[] = [];
  const payload =
    typeof job.payload === "object" && job.payload !== null && !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : undefined;
  const candidates = [payload?.text, payload?.message, job.text, job.message];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim();
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

export function selectExistingGoalStewardshipHeartbeatMessage(
  existing: Record<string, unknown> | undefined,
  heartbeatPatterns: string[],
): string | null {
  if (!existing) return null;
  const matchers = compileHeartbeatMatchers(heartbeatPatterns);
  const candidates = collectHeartbeatMessageCandidatesFromJob(existing);
  return candidates.find((candidate) => matchers.some((re) => re.test(candidate))) ?? null;
}

/**
 * Ensure there is one enabled, heartbeat-shaped cron job for goal stewardship.
 * The job is intentionally simple and should be safe to run continuously.
 */
