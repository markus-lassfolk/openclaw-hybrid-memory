import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { SKILL_ATOMIC_TEMP_PREFIX, isSkillDirComplete } from "./atomic-write.js";

export interface DiscoveredSkillDir {
  /** Directory name under the scanned skills root. */
  name: string;
  /** Absolute path to the completed skill directory. */
  dirPath: string;
  /** Absolute path to the directory's SKILL.md file. */
  skillPath: string;
}

/**
 * Returns true for hidden scratch directories left behind by interrupted
 * atomic skill writes. These are never valid loader candidates.
 */
export function isAtomicSkillWriteScratchDir(name: string): boolean {
  return name.startsWith(SKILL_ATOMIC_TEMP_PREFIX) || /^\..+\.bak-/.test(name);
}

/**
 * Discover skill directories that are safe for loader-style consumption.
 *
 * Auto-generated skill directories must contain `.openclaw-skill-complete`;
 * markerless directories are treated as in-progress writes and skipped even if
 * they already contain `SKILL.md`. Legacy compatibility belongs in migration or
 * duplicate-detection paths, not in active loader discovery.
 */
export function discoverCompletedSkillDirs(skillsDir: string): DiscoveredSkillDir[] {
  const out: DiscoveredSkillDir[] = [];
  if (!existsSync(skillsDir)) return out;

  for (const entry of safeReadSkillDir(skillsDir)) {
    if (isAtomicSkillWriteScratchDir(entry.name)) continue;
    if (!entry.isDirectory) continue;

    const dirPath = join(skillsDir, entry.name);
    if (!isSkillDirComplete(dirPath)) continue;

    const skillPath = join(dirPath, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    out.push({ name: entry.name, dirPath, skillPath });
  }

  return out;
}

function safeReadSkillDir(dir: string): Array<{ name: string; isDirectory: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/**
 * List absolute paths to every `SKILL.md` under `{workspaceRoot}/skills/**`,
 * skipping atomic-write scratch dirs and dot directories.
 */
export function listWorkspaceSkillMdPaths(workspaceRoot: string): string[] {
  const skillsRoot = join(workspaceRoot, "skills");
  const out: string[] = [];

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) out.push(skillMd);

    for (const entry of safeReadSkillDir(dir)) {
      if (entry.name.startsWith(".")) continue;
      if (isAtomicSkillWriteScratchDir(entry.name)) continue;
      if (!entry.isDirectory) continue;
      walk(join(dir, entry.name));
    }
  }

  walk(skillsRoot);
  return out;
}

export type WorkspaceSkillTarget = {
  /** Primary slug for SKILL_UPDATE (`slug: change` or `auto/slug: change`). */
  slug: string;
  /** Workspace-relative path to SKILL.md. */
  relPath: string;
};

/**
 * Index installed workspace skills for SKILL_UPDATE targeting.
 * When `skills/foo` and `skills/auto/foo` both exist, top-level `foo` maps to
 * `skills/foo/SKILL.md` and auto uses alias `auto/foo`.
 */
export function listWorkspaceSkillTargets(workspaceRoot: string): WorkspaceSkillTarget[] {
  const paths = listWorkspaceSkillMdPaths(workspaceRoot);
  const topLevelBySlug = new Map<string, string>();
  const autoBySlug = new Map<string, string>();

  for (const absPath of paths) {
    const rel = relative(workspaceRoot, absPath).replace(/\\/g, "/");
    const autoMatch = rel.match(/^skills\/auto\/([^/]+)\/SKILL\.md$/);
    if (autoMatch) {
      autoBySlug.set(autoMatch[1]!, rel);
      continue;
    }
    const topMatch = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (topMatch && topMatch[1] !== "auto") {
      topLevelBySlug.set(topMatch[1]!, rel);
    }
  }

  const targets: WorkspaceSkillTarget[] = [];
  const slugs = new Set([...topLevelBySlug.keys(), ...autoBySlug.keys()]);
  for (const slug of [...slugs].sort()) {
    const topRel = topLevelBySlug.get(slug);
    const autoRel = autoBySlug.get(slug);
    if (topRel) targets.push({ slug, relPath: topRel });
    if (autoRel) {
      targets.push({ slug: topRel ? `auto/${slug}` : slug, relPath: autoRel });
    }
  }
  return targets;
}

/** JSON array of `{ slug, path }` for self-correction analyze prompts. */
export function serializeWorkspaceSkillTargetsForPrompt(workspaceRoot: string): string {
  const targets = listWorkspaceSkillTargets(workspaceRoot);
  return JSON.stringify(targets.map((t) => ({ slug: t.slug, path: t.relPath })));
}
