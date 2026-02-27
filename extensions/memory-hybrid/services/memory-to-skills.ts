/**
 * Memory-to-skills: cluster procedures by task similarity, apply quality gates,
 * synthesize SKILL.md drafts via LLM, write to skills/auto-generated/ (issue #114).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProcedureEntry } from "../types/memory.js";
import type { MemoryToSkillsConfig } from "../config.js";
import type { Embeddings } from "./embeddings.js";
import type OpenAI from "openai";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { slugifyForSkill } from "../utils/text.js";
import { normalizeVector, cosineSimilarity } from "./reflection.js";
import { unionFind, getRoot } from "./consolidation.js";
import { chatCompleteWithRetry } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";

const CLUSTER_SIMILARITY_THRESHOLD = 0.75;
const MAX_SKILLS_PER_RUN = 10;
const SYNTHESIS_TEMPERATURE = 0.3;

export type SkillsSuggestResult = {
  proceduresCollected: number;
  clustersConsidered: number;
  qualifyingClusters: number;
  pathsWritten: string[];
  skippedOther: number;
  /** Count of clusters skipped because recipe (tool sequence) already exists in an existing skill. */
  skippedDuplicate: number;
  drafts: Array<{ pattern: string; count: number; path: string }>;
  /** When dryRun and verbose: full SKILL.md and recipe.json content that would be written. */
  draftPreviews?: Array<{ path: string; skillMd: string; recipeJson: string }>;
  /** True when run was preview-only (no files written). CLI uses this to show "Use --apply to write". */
  dryRun?: boolean;
};

export type SkillsSuggestOptions = {
  windowDays: number;
  minInstances: number;
  consistencyThreshold: number;
  outputDir: string;
  /** Explicit workspace root (default from OPENCLAW_WORKSPACE or cwd when not set). */
  workspaceRoot?: string;
  dryRun?: boolean;
  /** When true with dryRun, include full draft content in result.draftPreviews for display. */
  verbose?: boolean;
  model: string;
  fallbackModels?: string[];
};

/** Parse recipe_json to list of tool names. Exported for tests. */
export function getToolNamesFromRecipe(recipeJson: string): string[] {
  let arr: Array<{ tool?: string }>;
  try {
    const parsed = JSON.parse(recipeJson);
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  return arr.map((s) => (s && typeof s.tool === "string" ? s.tool : "")).filter(Boolean);
}

/** Shared helper: compute mode (most frequent tool) and its count at each position. */
function computePositionModes(procedures: ProcedureEntry[]): Array<{ tool: string; count: number; total: number }> {
  const sequences = procedures.map((p) => getToolNamesFromRecipe(p.recipeJson)).filter((s) => s.length > 0);
  if (sequences.length === 0) return [];
  const maxLen = Math.max(...sequences.map((s) => s.length));
  const modes: Array<{ tool: string; count: number; total: number }> = [];
  for (let i = 0; i < maxLen; i++) {
    const atPosition = sequences.map((s) => s[i]).filter(Boolean);
    if (atPosition.length === 0) break;
    const freq = new Map<string, number>();
    for (const t of atPosition) freq.set(t, (freq.get(t) ?? 0) + 1);
    const mode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (mode) {
      modes.push({ tool: mode[0], count: mode[1], total: atPosition.length });
    }
  }
  return modes;
}

/** Step consistency: fraction of step positions where the majority tool matches (0–1). Exported for tests. */
export function stepConsistency(procedures: ProcedureEntry[]): number {
  const sequences = procedures.map((p) => getToolNamesFromRecipe(p.recipeJson)).filter((s) => s.length > 0);
  if (sequences.length === 0) return 0;
  const modes = computePositionModes(procedures);
  if (modes.length === 0) return 0;
  const totalSequences = sequences.length;
  const minQuorum = Math.max(2, Math.ceil(totalSequences * 0.5));
  let matchSum = 0;
  let count = 0;
  for (const m of modes) {
    if (m.total >= minQuorum) {
      matchSum += m.count;
      count += m.total;
    }
  }
  return count === 0 ? 0 : matchSum / count;
}

/** Distinct tools across all procedures in cluster. Exported for tests. */
export function distinctToolCount(procedures: ProcedureEntry[]): number {
  const set = new Set<string>();
  for (const p of procedures) {
    for (const t of getToolNamesFromRecipe(p.recipeJson)) set.add(t);
  }
  return set.size;
}

/** Majority tool sequence across procedures (mode at each position). Used for recipe.json. */
function majorityToolSequence(procedures: ProcedureEntry[]): string[] {
  const modes = computePositionModes(procedures);
  return modes.map((m) => m.tool);
}

/** Fraction of recipe steps (across majority sequence) taken by the single most common tool (0–1). Exported for tests. */
export function singleToolDominanceRatio(procedures: ProcedureEntry[]): number {
  const seq = majorityToolSequence(procedures);
  if (seq.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const t of seq) freq.set(t, (freq.get(t) ?? 0) + 1);
  const max = Math.max(...freq.values());
  return max / seq.length;
}

/** Task patterns that look like injected context or non-actionable boilerplate (e.g. "relevant memories"). Exported for tests. */
export function isLikelyBoilerplateTaskPattern(task: string): boolean {
  const t = task.trim().toLowerCase();
  if (t.length < 10) return true;
  // Match common injection preamble (task is the snippet text, not user intent)
  if (t.startsWith("<relevant-memories>") || t.startsWith("the following memories")) return true;
  const boilerplate = [
    "relevant memories",
    "relevant context",
    "memories may be relevant",
    "following memories may be",
    "injected context",
    "pre-injected",
    "memory context",
    "context provided",
    "given context",
    "retrieved memories",
    "memory snippet",
    "memory block",
  ];
  return boilerplate.some((phrase) => t.includes(phrase));
}

/** Descriptions that are too vague to be a useful skill (e.g. "access and review based on context"). Exported for tests. */
export function isGenericSkillDescription(description: string): boolean {
  const d = description.trim().toLowerCase();
  if (!d || d.length < 20) return true;
  const vague = [
    "based on the current context",
    "as needed",
    "access and review",
    "access relevant memories",
    "use the relevant",
    "depending on context",
    "when appropriate",
  ];
  return vague.some((phrase) => d.includes(phrase));
}

/** Collect existing skill slugs under workspace (skills/, skills/auto/, skills/auto-generated/). Exported for tests. */
export function getExistingSkillSlugs(workspaceRoot: string): Set<string> {
  const slugs = new Set<string>();
  for (const sub of ["skills", "skills/auto", "skills/auto-generated"]) {
    const dir = join(workspaceRoot, sub);
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const skillPath = join(dir, e.name, "SKILL.md");
          if (existsSync(skillPath)) slugs.add(e.name);
        }
      }
    } catch {
      // ignore
    }
  }
  return slugs;
}

/** Ensure unique slug by appending -1, -2, etc. if collision detected. */
function ensureUniqueSlug(basePath: string, slug: string, existingSlugs: Set<string>): string {
  let candidate = slug;
  let n = 0;
  while (existingSlugs.has(candidate) || existsSync(join(basePath, candidate))) {
    n++;
    candidate = `${slug}-${n}`;
  }
  return candidate;
}

/** Load existing skill recipe sequences from a directory. Returns map: recipeKey (JSON array of tool names) -> slug. */
function loadExistingRecipeKeys(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const recipePath = join(dir, e.name, "recipe.json");
      if (!existsSync(recipePath)) continue;
      try {
        const raw = readFileSync(recipePath, "utf-8");
        const arr = JSON.parse(raw) as Array<{ tool?: string }>;
        const tools = Array.isArray(arr) ? arr.map((s) => (s && typeof s.tool === "string" ? s.tool : "")).filter(Boolean) : [];
        const key = JSON.stringify(tools);
        if (key.length > 0) out.set(key, e.name);
      } catch {
        // ignore malformed recipe
      }
    }
  } catch {
    // ignore
  }
  return out;
}

/** Collect all existing recipe keys from workspace skill dirs (skills, skills/auto, skills/auto-generated). Returns map: recipeKey -> slug (first slug wins). */
function getExistingRecipeKeys(workspaceRoot: string): Map<string, string> {
  const combined = new Map<string, string>();
  for (const sub of ["skills", "skills/auto", "skills/auto-generated"]) {
    const dir = join(workspaceRoot, sub);
    const m = loadExistingRecipeKeys(dir);
    for (const [key, slug] of m) {
      if (!combined.has(key)) combined.set(key, slug);
    }
  }
  return combined;
}

/** Parse LLM response: optional YAML frontmatter (name, description) and body. Exported for tests. Strips markdown code fences if present. */
export function parseSynthesizedSkill(raw: string): { name: string; description: string; body: string } {
  let name = "skill";
  let description = "";
  let body = raw.trim();
  // Strip optional markdown code block wrapper (LLMs often wrap in ```markdown ... ```)
  body = body.replace(/^```[a-z]*\r?\n/i, "").replace(/\r?\n```\s*$/, "").trim();
  const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    const yaml = fmMatch[1];
    body = fmMatch[2].trim();
    const nameM = yaml.match(/^\s*name:\s*["']?([^"'\n]+)["']?/m);
    const descM = yaml.match(/^\s*description:\s*["']?([^"'\n]+)["']?/m);
    if (nameM) name = nameM[1].trim();
    if (descM) description = descM[1].trim();
  }
  // Strip redundant first heading when it is the literal "skill" (generic placeholder)
  const firstLine = body.split(/\r?\n/)[0] ?? "";
  const headingMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch && headingMatch[1].trim().toLowerCase() === "skill") {
    body = body.replace(/^[^\n]+\n?/, "").trim();
  }
  return { name, description, body };
}

/**
 * Run memory-to-skills pipeline: collect, cluster, filter, synthesize, write, dedup.
 */
export async function runMemoryToSkills(
  factsDb: FactsDB,
  embeddings: Embeddings,
  openai: OpenAI,
  config: MemoryToSkillsConfig,
  opts: SkillsSuggestOptions,
  logger: { info: (s: string) => void; warn: (s: string) => void },
): Promise<SkillsSuggestResult> {
  const result: SkillsSuggestResult = {
    proceduresCollected: 0,
    clustersConsidered: 0,
    qualifyingClusters: 0,
    pathsWritten: [],
    skippedOther: 0,
    skippedDuplicate: 0,
    drafts: [],
    draftPreviews: opts.dryRun && opts.verbose ? [] : undefined,
    dryRun: opts.dryRun,
  };

  if (!config.enabled) {
    return result;
  }

  const procedures = factsDb.listProceduresUpdatedInLastNDays(opts.windowDays, 500);
  result.proceduresCollected = procedures.length;

  if (procedures.length < opts.minInstances) {
    logger.info(`memory-to-skills: ${procedures.length} procedures in window (min ${opts.minInstances})`);
    return result;
  }

  // Embed task_pattern for each procedure
  const idToProc = new Map(procedures.map((p) => [p.id, p]));
  const ids = procedures.map((p) => p.id);
  logger.info(`memory-to-skills: embedding ${ids.length} procedures...`);
  const vectors: number[][] = [];
  for (let i = 0; i < ids.length; i++) {
    const p = idToProc.get(ids[i])!;
    try {
      const vec = await embeddings.embed(p.taskPattern);
      vectors.push(normalizeVector(vec));
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "memory-to-skills-embed",
        subsystem: "embeddings",
        procedureId: p.id,
      });
      vectors.push([]);
    }
    if ((i + 1) % 20 === 0 && i + 1 < ids.length) await new Promise((r) => setTimeout(r, 100));
  }

  // Cluster by similarity (union-find)
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    if (vectors[i].length === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      if (vectors[j].length === 0) continue;
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim >= CLUSTER_SIMILARITY_THRESHOLD) edges.push([ids[i], ids[j]]);
    }
  }
  const parent = unionFind(ids, edges);
  const rootToCluster = new Map<string, string[]>();
  for (const id of ids) {
    const r = getRoot(parent, id);
    if (!rootToCluster.has(r)) rootToCluster.set(r, []);
    rootToCluster.get(r)!.push(id);
  }
  const clusters = [...rootToCluster.values()].filter((c) => c.length >= opts.minInstances);
  result.clustersConsidered = clusters.length;

  const workspaceRoot = opts.workspaceRoot?.trim() || process.env.OPENCLAW_WORKSPACE || process.cwd();
  if (!workspaceRoot) {
    logger.warn("memory-to-skills: no workspace root; skipping write");
    return result;
  }
  const basePath = opts.outputDir.startsWith("/")
    ? opts.outputDir
    : join(workspaceRoot, opts.outputDir);
  const existingSlugs = getExistingSkillSlugs(workspaceRoot);
  /** Recipe key -> existing slug (from disk + skills written this run). Used to skip duplicate tool sequences. */
  const existingRecipeKeys = getExistingRecipeKeys(workspaceRoot);

  let written = 0;
  for (const clusterIds of clusters) {
    if (written >= MAX_SKILLS_PER_RUN) {
      result.skippedOther++;
      continue;
    }
    const procs = clusterIds.map((id) => idToProc.get(id)!).filter(Boolean);
    const consistency = stepConsistency(procs);
    if (consistency < opts.consistencyThreshold) {
      result.skippedOther++;
      continue;
    }
    const numTools = distinctToolCount(procs);
    if (numTools < 2) {
      result.skippedOther++;
      continue;
    }
    if (singleToolDominanceRatio(procs) > 0.6) {
      logger.info(`memory-to-skills: skip cluster (recipe dominated by one tool; not actionable)`);
      result.skippedOther++;
      continue;
    }
    const repTask = procs[0].taskPattern;
    if (isLikelyBoilerplateTaskPattern(repTask)) {
      logger.info(`memory-to-skills: skip cluster (task pattern looks like injected context: "${repTask.slice(0, 50)}…")`);
      result.skippedOther++;
      continue;
    }
    const newRecipe = majorityToolSequence(procs);
    const newRecipeKey = JSON.stringify(newRecipe);
    if (existingRecipeKeys.has(newRecipeKey)) {
      const existingSlug = existingRecipeKeys.get(newRecipeKey)!;
      logger.info(`memory-to-skills: skip cluster (duplicate recipe of existing skill "${existingSlug}")`);
      result.skippedDuplicate++;
      continue;
    }
    result.qualifyingClusters++;

    const proceduresBlock = procs
      .map((p, i) => {
        const steps = getToolNamesFromRecipe(p.recipeJson);
        const stepStr = steps.map((t, j) => `${j + 1}. ${t}`).join("; ");
        return `[${i + 1}] Task: ${p.taskPattern}\nSteps: ${stepStr || "(none)"}`;
      })
      .join("\n\n");

    const prompt = fillPrompt(loadPrompt("memory-to-skills-synthesize"), {
      count: String(procs.length),
      procedures: proceduresBlock,
    });

    let rawResponse: string;
    try {
      rawResponse = await chatCompleteWithRetry({
        model: opts.model,
        content: prompt,
        temperature: SYNTHESIS_TEMPERATURE,
        maxTokens: 2000,
        openai,
        fallbackModels: opts.fallbackModels ?? [],
        label: "memory-to-skills",
      });
    } catch (err) {
      logger.warn(`memory-to-skills: LLM failed for cluster: ${err}`);
      result.skippedOther++;
      continue;
    }

    const { name, description, body } = parseSynthesizedSkill(rawResponse);
    // Skip if LLM returned generic name and no specific description (low-quality draft)
    const genericName = name.toLowerCase().trim() === "skill";
    const genericDesc = !description || /auto-generated from \d+ procedure/i.test(description);
    if (genericName && genericDesc) {
      logger.info(`memory-to-skills: skip cluster (LLM returned generic name/description; ask for a specific skill name and one-line description)`);
      result.skippedOther++;
      continue;
    }
    if (description && isGenericSkillDescription(description)) {
      logger.info(`memory-to-skills: skip cluster (description too vague for a useful skill)`);
      result.skippedOther++;
      continue;
    }
    const baseSlug = slugifyForSkill(name);
    const slug = ensureUniqueSlug(basePath, baseSlug, existingSlugs);

    const skillDir = join(basePath, slug);
    const skillPath = join(skillDir, "SKILL.md");
    // Always use slug for name; quote description for YAML safety (JSON.stringify for escaping)
    const descEscaped = JSON.stringify(description || `Auto-generated from ${procs.length} procedure instance(s).`);
    const fullContent = `---
name: ${JSON.stringify(slug)}
description: ${descEscaped}
---

${body}`;

    if (opts.dryRun) {
      logger.info(`[dry-run] Would write ${skillPath}`);
      existingSlugs.add(slug);
      existingRecipeKeys.set(newRecipeKey, slug);
      result.pathsWritten.push(skillPath);
      result.drafts.push({ pattern: procs[0].taskPattern.slice(0, 60), count: procs.length, path: skillPath });
      if (result.draftPreviews) {
        const steps = majorityToolSequence(procs);
        const recipeArr = steps.map((t) => ({ tool: t }));
        result.draftPreviews.push({
          path: skillPath,
          skillMd: fullContent,
          recipeJson: JSON.stringify(recipeArr, null, 2),
        });
      }
      written++;
      continue;
    }

    try {
      mkdirSync(skillDir, { recursive: true });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "memory-to-skills",
        operation: "mkdir",
      });
      result.skippedOther++;
      continue;
    }

    try {
      writeFileSync(skillPath, fullContent, "utf-8");
      const steps = majorityToolSequence(procs);
      const recipeArr = steps.map((t) => ({ tool: t }));
      writeFileSync(join(skillDir, "recipe.json"), JSON.stringify(recipeArr, null, 2), "utf-8");
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "memory-to-skills",
        operation: "write",
      });
      try {
        rmSync(skillDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
      result.skippedOther++;
      continue;
    }

    const relativePath = join(opts.outputDir, slug);
    for (const p of procs) {
      factsDb.markProcedurePromoted(p.id, relativePath);
    }
    existingSlugs.add(slug);
    existingRecipeKeys.set(newRecipeKey, slug);
    result.pathsWritten.push(skillPath);
    result.drafts.push({ pattern: procs[0].taskPattern.slice(0, 60), count: procs.length, path: skillPath });
    written++;
    logger.info(`memory-to-skills: wrote ${skillPath}`);
  }

  return result;
}
