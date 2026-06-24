import OpenAI from "openai";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRunIdSlug } from "../../utils/dates.js";
import { MODELS, type AbTaskId, type AbRunResult } from "./types.js";
import { loadCorpus, writeCorpusSnapshot } from "./corpus.js";
import { writeThinkingProbeReport } from "./probe-thinking.js";
import { runAbCell } from "./run-task.js";
import { buildDecisionReport, maeveTierSnippet } from "./decide.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "../../.ab-fixtures");

const TASKS: AbTaskId[] = ["self-correction", "reinforcement", "distill", "reflection", "consolidation"];

const MODELS_LIST = [MODELS.m27Highspeed, MODELS.m3] as const;

async function main(): Promise<void> {
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    console.error("MINIMAX_API_KEY required");
    process.exit(1);
  }

  const timestamp = formatRunIdSlug();
  const outDir = join(FIXTURES_ROOT, "out", timestamp);
  mkdirSync(outDir, { recursive: true });

  console.log("==> Probing thinking levels...");
  const { sweep, m3, m27 } = await writeThinkingProbeReport(apiKey, join(outDir, "thinking-probe.json"));
  console.log(`    sweep: ${sweep.join(", ")} (M3: ${m3.accepted.join(",")} | M2.7-hs: ${m27.accepted.join(",")})`);

  console.log("==> Loading corpus...");
  const corpusPath = join(FIXTURES_ROOT, "corpus-snapshot.json");
  let corpus;
  if (existsSync(corpusPath) && process.env.AB_REUSE_CORPUS === "1") {
    corpus = { ...JSON.parse(readFileSync(corpusPath, "utf-8")), sessionPaths: [] };
    console.log("    reused corpus snapshot");
  } else {
    corpus = await loadCorpus(FIXTURES_ROOT, 40);
    writeCorpusSnapshot(corpus, corpusPath);
  }
  writeFileSync(join(outDir, "corpus-meta.json"), JSON.stringify(corpus.meta, null, 2));
  console.log(
    `    SC=${corpus.meta.selfCorrectionIncidents} RE=${corpus.meta.reinforcementIncidents} facts=${corpus.meta.factsCount}`,
  );

  const openai = new OpenAI({ apiKey, baseURL: "https://api.minimax.io/v1" });
  const cells: AbRunResult["cells"] = [];
  const total = TASKS.length * MODELS_LIST.length * sweep.length;
  let done = 0;

  for (const task of TASKS) {
    for (const model of MODELS_LIST) {
      for (const thinking of sweep) {
        done++;
        const label = `${task} | ${model} | thinking=${thinking}`;
        console.log(`==> [${done}/${total}] ${label}`);
        const cell = await runAbCell({ openai, corpus, task, model, thinking });
        cells.push(cell);
        const samplePath = join(outDir, "samples", `${task}__${model}__${thinking}.md`);
        mkdirSync(dirname(samplePath), { recursive: true });
        writeFileSync(
          samplePath,
          `# ${label}\n\nok: ${cell.ok}\nlatencyMs: ${cell.latencyMs}\n\n## Operational\n\n\`\`\`json\n${JSON.stringify(cell.operational, null, 2)}\n\`\`\`\n\n## Output preview\n\n\`\`\`\n${cell.outputPreview ?? cell.error ?? "(empty)"}\n\`\`\`\n`,
          "utf-8",
        );
      }
    }
  }

  const result: AbRunResult = {
    timestamp,
    thinkingLevels: sweep,
    corpus: corpus.meta,
    cells,
  };
  writeFileSync(join(outDir, "metrics.json"), JSON.stringify(result, null, 2));

  const { summaryMd, recommendations } = buildDecisionReport(result);
  writeFileSync(join(outDir, "summary.md"), summaryMd);
  writeFileSync(join(outDir, "recommendations.json"), JSON.stringify(recommendations, null, 2));
  writeFileSync(join(outDir, "maeve-tier-snippet.json"), maeveTierSnippet(recommendations));

  console.log(`\n==> Done. Output: ${outDir}`);
  console.log(summaryMd);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
