/**
 * Re-probe a single matrix cell (default: reflection M3 adaptive) after timeout/thinking-fallback changes.
 *
 *   AB_REUSE_CORPUS=1 npx tsx benchmark/ab-maintenance/probe-cell.ts
 *   AB_PROBE_TASK=reflection AB_PROBE_MODEL=MiniMax-M3 AB_PROBE_THINKING=adaptive npx tsx ...
 */
import OpenAI from "openai";
import { loadCorpusSnapshot } from "./corpus.js";
import { runAbCell } from "./run-task.js";
import { MODELS, type AbModelId, type AbTaskId, type AbThinkingMode } from "./types.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) throw new Error("MINIMAX_API_KEY required");

  const task = (process.env.AB_PROBE_TASK ?? "reflection") as AbTaskId;
  const model = (process.env.AB_PROBE_MODEL ?? MODELS.m3) as AbModelId;
  const thinking = (process.env.AB_PROBE_THINKING ?? "adaptive") as AbThinkingMode;

  const corpusPath = join(__dirname, "../../.ab-fixtures/corpus-snapshot.json");
  const corpus = { ...loadCorpusSnapshot(corpusPath), sessionPaths: [] as string[] };
  const openai = new OpenAI({ apiKey, baseURL: "https://api.minimax.io/v1" });

  console.log(`==> Probing ${task} | ${model} | thinking=${thinking}`);
  const cell = await runAbCell({ openai, corpus, task, model, thinking });
  console.log(JSON.stringify(cell, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
