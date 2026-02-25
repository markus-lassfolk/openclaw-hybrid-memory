/**
 * Memory-to-skills: cluster procedures by task similarity, apply quality gates,
 * synthesize SKILL.md drafts via LLM, write to skills/auto-generated/ (issue #114).
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  drafts: Array<{ pattern: string; count: number; path: string }>;
};

export type SkillsSuggestOptions = {
  windowDays: number;
  minInstances: number;
  consistencyThreshold: number;
  outputDir: string;
  /** Explicit workspace root (default from OPENCLAW_WORKSPACE or cwd when not set). */
  workspaceRoot?: string;
  dryRun?: boolean;
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

/** Step consistency: fraction of step positions where the majority tool matches (0–1). Exported for tests. */
export function stepConsistency(procedures: ProcedureEntry[]): number {
  const sequences = procedures.map((p) => getToolNamesFromRecipe(p.recipeJson)).filter((s) => s.length > 0);
  if (sequences.length === 0) return 0;
  const maxLen = Math.max(...sequences.map((s) => s.length));
  if (maxLen === 0) return 0;
  let matchSum = 0;
  let count = 0;
  for (let i = 0; i < maxLen; i++) {
    const atPosition = sequences.map((s) => s[i]).filter(Boolean);
    if (atPosition.length === 0) continue;
    const freq = new Map<string, number>();
    for (const t of atPosition) freq.set(t, (freq.get(t) ?? 0) + 1);
    const mode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (mode) {
      matchSum += mode[1];
      count += atPosition.length;
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
  const sequences = procedures.map((p) => getToolNamesFromRecipe(p.recipeJson)).filter((s) => s.length > 0);
  if (sequences.length === 0) return [];
  const maxLen = Math.max(...sequences.map((s) => s.length));
  const result: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const atPosition = sequences.map((s) => s[i]).filter(Boolean);
    if (atPosition.length === 0) break;
    const freq = new Map<string, number>();
    for (const t of atPosition) freq.set(t, (freq.get(t) ?? 0) + 1);
    const mode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (mode) result.push(mode[0]);
  }
  return result;
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
    drafts: [],
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
    const baseSlug = slugifyForSkill(name);
    let slug = baseSlug;
    let n = 0;
    while (existingSlugs.has(slug) || existsSync(join(basePath, slug))) {
      n++;
      slug = `${baseSlug}-${n}`;
    }

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
      result.pathsWritten.push(skillPath);
      result.drafts.push({ pattern: procs[0].taskPattern.slice(0, 60), count: procs.length, path: skillPath });
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

    existingSlugs.add(slug);
    result.pathsWritten.push(skillPath);
    result.drafts.push({ pattern: procs[0].taskPattern.slice(0, 60), count: procs.length, path: skillPath });
    written++;
    logger.info(`memory-to-skills: wrote ${skillPath}`);
  }

  return result;
}
