/**
 * Auto-Classifier Service
 *
 * LLM-based classification of "other" facts into proper categories.
 * Includes optional category discovery (grouping by free-form labels).
 */

import type OpenAI from "openai";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { FactsDB } from "../backends/facts-db.js";
import { getMemoryCategories, setMemoryCategories, isValidCategory } from "../config.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { capturePluginError } from "./error-reporter.js";

/** Minimum "other" facts before category discovery kicks in. */
const MIN_OTHER_FOR_DISCOVERY = 15;
/** Batch size for discovery prompts (leave room for JSON array of labels). */
const DISCOVERY_BATCH_SIZE = 25;

/**
 * Normalize a free-form label to a valid category slug: lowercase, alphanumeric + underscore.
 * Returns empty string if result would be "other" or invalid.
 */
function normalizeSuggestedLabel(s: string): string {
  const t = s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return t && t !== "other" && t.length <= 40 ? t : "";
}

/**
 * Ask the LLM to group "other" facts by topic (free-form labels). Labels with at least
 * minFactsForNewCategory facts become new categories; we do not tell the LLM the threshold.
 * Returns list of newly created category names; updates DB and persists to discoveredCategoriesPath.
 */
async function discoverCategoriesFromOther(
  factsDb: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number; suggestCategories?: boolean; minFactsForNewCategory?: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  discoveredCategoriesPath: string,
): Promise<string[]> {
  if (config.suggestCategories !== true) return [];
  const minForNew = config.minFactsForNewCategory ?? 10;
  const others = factsDb.getByCategory("other");
  if (others.length < MIN_OTHER_FOR_DISCOVERY) return [];

  logger.info(`memory-hybrid: category discovery on ${others.length} "other" facts (min ${minForNew} per label)`);

  const existingCategories = new Set(getMemoryCategories());
  const labelToIds = new Map<string, string[]>();

  for (let i = 0; i < others.length; i += DISCOVERY_BATCH_SIZE) {
    const batch = others.slice(i, i + DISCOVERY_BATCH_SIZE);
    const factLines = batch.map((f, idx) => `${idx + 1}. ${f.text.slice(0, 280)}`).join("\n");
    const prompt = fillPrompt(loadPrompt("category-discovery"), { facts: factLines });

    try {
      // Retry logic for transient errors (rate limits, 5xx)
      const maxRetries = 2;
      let lastError: Error | undefined;
      let resp;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          resp = await openai.chat.completions.create({
            model: config.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            max_tokens: batch.length * 24,
          });
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      if (!resp) throw lastError;
      const content = resp.choices[0]?.message?.content?.trim() || "[]";
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;
      const labels: unknown[] = JSON.parse(jsonMatch[0]);
      for (let j = 0; j < Math.min(labels.length, batch.length); j++) {
        const raw = typeof labels[j] === "string" ? (labels[j] as string) : "";
        const label = normalizeSuggestedLabel(raw);
        if (!label) continue;
        if (!labelToIds.has(label)) labelToIds.set(label, []);
        labelToIds.get(label)!.push(batch[j].id);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "auto-classifier",
        operation: "category-discovery-batch",
      });
      logger.warn(`memory-hybrid: category discovery batch failed: ${err}`);
    }
    if (i + DISCOVERY_BATCH_SIZE < others.length) await new Promise((r) => setTimeout(r, 400));
  }

  const newCategoryNames: string[] = [];
  for (const [label, ids] of labelToIds) {
    if (existingCategories.has(label)) continue;
    if (ids.length < minForNew) continue;
    newCategoryNames.push(label);
    for (const id of ids) factsDb.updateCategory(id, label);
  }

  if (newCategoryNames.length === 0) return [];

  setMemoryCategories([...getMemoryCategories(), ...newCategoryNames]);
  logger.info(`memory-hybrid: discovered ${newCategoryNames.length} new categories: ${newCategoryNames.join(", ")} (${newCategoryNames.reduce((acc, c) => acc + (labelToIds.get(c)?.length ?? 0), 0)} facts reclassified)`);

  await mkdir(dirname(discoveredCategoriesPath), { recursive: true });
  let existingList: string[] = [];
  try {
    existingList = JSON.parse(await readFile(discoveredCategoriesPath, "utf-8")) as string[];
  } catch (err) {
    capturePluginError(err as Error, {
      operation: 'read-discovered-categories',
      severity: 'info',
      subsystem: 'classifier'
    });
    // file doesn't exist yet
  }
  const merged = [...new Set([...existingList, ...newCategoryNames])];
  await writeFile(discoveredCategoriesPath, JSON.stringify(merged, null, 2), "utf-8");

  return newCategoryNames;
}

/**
 * Classify a batch of "other" facts into proper categories using a cheap LLM.
 * Returns a map of factId → newCategory.
 */
async function classifyBatch(
  openai: OpenAI,
  model: string,
  facts: { id: string; text: string }[],
  categories: readonly string[],
): Promise<Map<string, string>> {
  const catList = categories.filter((c) => c !== "other").join(", ");
  const factLines = facts
    .map((f, i) => `${i + 1}. ${f.text.slice(0, 300)}`)
    .join("\n");

  const prompt = `You are a memory classifier. Categorize each fact into exactly one category.

Available categories: ${catList}
Use "other" ONLY if no category fits at all.

Facts to classify:
${factLines}

Respond with ONLY a JSON array of category strings, one per fact, in order. Example: ["fact","entity","preference"]`;

  try {
    // Retry logic for transient errors (rate limits, 5xx)
    const maxRetries = 2;
    let lastError: Error | undefined;
    let resp;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        resp = await openai.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: facts.length * 20,
        });
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    if (!resp) throw lastError;

    const content = resp.choices[0]?.message?.content?.trim() || "[]";
    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return new Map();

    const results: string[] = JSON.parse(jsonMatch[0]);
    const map = new Map<string, string>();

    for (let i = 0; i < Math.min(results.length, facts.length); i++) {
      const cat = results[i]?.toLowerCase()?.trim();
      if (cat && cat !== "other" && isValidCategory(cat)) {
        map.set(facts[i].id, cat);
      }
    }
    return map;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: 'classify-batch',
      severity: 'info',
      subsystem: 'classifier'
    });
    return new Map();
  }
}

/** Progress reporter for batch CLI commands (optional). */
type ClassifyProgressReporter = { update: (current: number) => void; done: () => void };

/** Progress bar when stdout is TTY; otherwise no-op (caller can use sink.log). */
function createProgressReporter(
  sink: { log: (s: string) => void },
  total: number,
  label: string,
): { update: (current: number, extra?: string) => void; done: () => void } {
  const isTTY = typeof process.stdout?.isTTY === "boolean" && process.stdout.isTTY;
  const width = 40;
  let lastLen = 0;
  let lastPct = -1;
  return {
    update(current: number, extra?: string) {
      if (total <= 0) return;
      const pct = Math.min(100, Math.floor((current / total) * 100));
      if (!isTTY) {
        // Only log at milestones to avoid spam in non-TTY (25%, 50%, 75%, 100%)
        if (pct === 100 || (pct >= 25 && pct !== lastPct && pct % 25 === 0)) {
          sink.log(`${label}: ${pct}% (${current}/${total})${extra ? ` ${extra}` : ""}`);
          lastPct = pct;
        }
        return;
      }
      const filled = Math.min(width, Math.round((current / total) * width));
      const arrow = filled < width ? 1 : 0;
      const dots = Math.max(0, width - filled - arrow);
      const bar = "=".repeat(filled) + ">".repeat(arrow) + ".".repeat(dots);
      const line = `${label}: ${pct}% [${bar}] ${current}/${total}${extra ? ` (${extra})` : ""}`;
      process.stdout.write("\r" + line + " ".repeat(Math.max(0, lastLen - line.length)));
      lastLen = line.length;
    },
    done() {
      if (isTTY && lastLen > 0) process.stdout.write("\n");
    },
  };
}

/**
 * Run classify command: optional discovery, then batch classify with limit and dryRun.
 * Used by CLI; returns counts and optional breakdown for printing.
 */
async function runClassifyForCli(
  factsDb: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number; suggestCategories?: boolean; minFactsForNewCategory?: number },
  opts: { dryRun: boolean; limit: number; model?: string },
  discoveredPath: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  progressReporter?: ClassifyProgressReporter,
): Promise<{ reclassified: number; total: number; breakdown?: Record<string, number> }> {
  const classifyModel = opts.model || config.model;
  const categories = getMemoryCategories();
  let others = factsDb.getByCategory("other").slice(0, opts.limit);
  if (others.length === 0) {
    return { reclassified: 0, total: 0 };
  }

  if (!opts.dryRun && config.suggestCategories && others.length >= MIN_OTHER_FOR_DISCOVERY) {
    await discoverCategoriesFromOther(factsDb, openai, { ...config, model: classifyModel }, logger, discoveredPath);
    others = factsDb.getByCategory("other").slice(0, opts.limit);
  }

  const numBatches = Math.ceil(others.length / config.batchSize);
  if (!progressReporter && numBatches > 0) {
    const sink = { log: (m: string) => logger.info(m) };
    progressReporter = createProgressReporter(sink, numBatches, "Classifying");
  }
  let totalReclassified = 0;
  let batchIndex = 0;
  for (let i = 0; i < others.length; i += config.batchSize) {
    progressReporter?.update(batchIndex + 1);
    const batch = others.slice(i, i + config.batchSize).map((e) => ({ id: e.id, text: e.text }));
    const results = await classifyBatch(openai, classifyModel, batch, categories);
    for (const [id, newCat] of results) {
      if (!opts.dryRun) factsDb.updateCategory(id, newCat);
      totalReclassified++;
    }
    batchIndex++;
    if (i + config.batchSize < others.length) await new Promise((r) => setTimeout(r, 500));
  }
  progressReporter?.done();

  const breakdown = !opts.dryRun ? factsDb.statsBreakdown() : undefined;
  return { reclassified: totalReclassified, total: others.length, breakdown };
}

/**
 * Run auto-classification on all "other" facts. Called on schedule or manually.
 * If opts.discoveredCategoriesPath and config.suggestCategories are set, runs category discovery first
 * (LLM groups "other" by free-form label; labels with ≥ minFactsForNewCategory become new categories).
 */
async function runAutoClassify(
  factsDb: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number; suggestCategories?: boolean; minFactsForNewCategory?: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  opts?: { discoveredCategoriesPath?: string },
): Promise<{ reclassified: number; suggested: string[] }> {
  const categories = getMemoryCategories();

  // Optionally discover new categories from "other" (free-form grouping; threshold not told to LLM)
  if (opts?.discoveredCategoriesPath && config.suggestCategories) {
    await discoverCategoriesFromOther(factsDb, openai, config, logger, opts.discoveredCategoriesPath);
  }

  // Get all "other" facts (after discovery some may have been reclassified)
  const others = factsDb.getByCategory("other");
  if (others.length === 0) {
    return { reclassified: 0, suggested: [] };
  }

  logger.info(`memory-hybrid: auto-classify starting on ${others.length} "other" facts`);

  let totalReclassified = 0;

  // Process in batches
  for (let i = 0; i < others.length; i += config.batchSize) {
    const batch = others.slice(i, i + config.batchSize).map((e) => ({
      id: e.id,
      text: e.text,
    }));

    const results = await classifyBatch(openai, config.model, batch, categories);

    for (const [id, newCat] of results) {
      factsDb.updateCategory(id, newCat);
      totalReclassified++;
    }

    // Small delay between batches to avoid rate limits
    if (i + config.batchSize < others.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  logger.info(`memory-hybrid: auto-classify done — reclassified ${totalReclassified}/${others.length} facts`);
  return { reclassified: totalReclassified, suggested: [] };
}

// ============================================================================
// Exports
// ============================================================================

export {
  runAutoClassify,
  runClassifyForCli,
  normalizeSuggestedLabel,
  type ClassifyProgressReporter,
};
