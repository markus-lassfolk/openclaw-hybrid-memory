import type { AbRunResult, AbTaskId, AbModelId, AbThinkingMode } from "./types.js";
import { MODELS } from "./types.js";

export type TaskRecommendation = {
  task: AbTaskId;
  model: AbModelId;
  thinking: AbThinkingMode;
  score: number;
  rationale: string;
};

function scoreCell(
  cell: AbRunResult["cells"][number],
): number {
  if (cell.operational.skipped === true) return 50;
  if (!cell.ok) return 0;
  let score = 100;
  const op = cell.operational;
  if (typeof op.coveragePct === "number" && op.coveragePct < 100) score -= 40;
  if (typeof op.parseFailures === "number") score -= op.parseFailures * 10;
  if (typeof op.truncations === "number") score -= op.truncations * 15;
  if (typeof op.batchSplits === "number") score -= op.batchSplits * 5;
  if (op.truncated === true || op.finishReason === "length") score -= 25;
  if (typeof op.patternCount === "number" && op.patternCount < 2) score -= 20;
  if (typeof op.jsonlLines === "number" && op.jsonlLines < 3) score -= 30;
  score -= Math.min(20, Math.floor(cell.latencyMs / 10_000));
  return Math.max(0, score);
}

export function buildDecisionReport(result: AbRunResult): {
  summaryMd: string;
  recommendations: TaskRecommendation[];
} {
  const byTask = new Map<AbTaskId, AbRunResult["cells"]>();
  for (const cell of result.cells) {
    const arr = byTask.get(cell.task) ?? [];
    arr.push(cell);
    byTask.set(cell.task, arr);
  }

  const recommendations: TaskRecommendation[] = [];
  const lines: string[] = [
    "# Maintenance model A/B summary",
    "",
    `Run: ${result.timestamp}`,
    "",
    "## Corpus",
    "",
    `- Session files scanned: ${result.corpus.sessionFiles}`,
    `- Self-correction incidents: ${result.corpus.selfCorrectionIncidents}`,
    `- Reinforcement incidents: ${result.corpus.reinforcementIncidents}`,
    `- Facts in sample: ${result.corpus.factsCount}`,
    `- Thinking sweep: ${result.thinkingLevels.join(", ")}`,
    "",
    "## Results matrix",
    "",
  ];

  for (const task of [...byTask.keys()].sort()) {
    lines.push(`### ${task}`);
    lines.push("");
    const cells = byTask.get(task)!.sort((a, b) => scoreCell(b) - scoreCell(a));
    for (const c of cells) {
      const sc = scoreCell(c);
      lines.push(
        `- **${c.model}** thinking=\`${c.thinking}\` — score=${sc} ok=${c.ok} latency=${c.latencyMs}ms ${JSON.stringify(c.operational)}`,
      );
    }
    const winner = cells[0];
    if (winner) {
      recommendations.push({
        task,
        model: winner.model,
        thinking: winner.thinking,
        score: scoreCell(winner),
        rationale: `Highest operational score among ${cells.length} cells (ok=${winner.ok}, latency=${winner.latencyMs}ms). Human spot-check recommended.`,
      });
      lines.push("");
      lines.push(`**Recommended:** \`${winner.model}\` with thinking=\`${winner.thinking}\` (score ${scoreCell(winner)})`);
      lines.push("");
    }
  }

  lines.push("## Default mapping (if recommendations accepted)");
  lines.push("");
  lines.push("| Tier / task | Model | Thinking |");
  lines.push("|-------------|-------|----------|");
  for (const rec of recommendations) {
    lines.push(`| ${rec.task} | ${rec.model} | ${rec.thinking} |`);
  }
  lines.push("");
  lines.push("## Human spot-check");
  lines.push("");
  lines.push("Review `samples/*.md` for side-by-side output quality before applying config.");
  lines.push("");

  return { summaryMd: lines.join("\n"), recommendations };
}

/** Suggested Maeve tier wiring from recommendations. */
export function maeveTierSnippet(recommendations: TaskRecommendation[]): string {
  const heavy = recommendations.find((r) => r.task === "self-correction")?.model ?? MODELS.m3;
  const maintenance =
    recommendations.find((r) => r.task === "reflection")?.model ?? MODELS.m3;
  const nano =
    recommendations.find((r) => r.task === "reinforcement")?.model ?? MODELS.m27Highspeed;
  return JSON.stringify(
    {
      llm: {
        nano: [nano.startsWith("minimax/") ? nano : `minimax/${nano}`],
        maintenance: [maintenance.startsWith("minimax/") ? maintenance : `minimax/${maintenance}`],
        default: [maintenance.startsWith("minimax/") ? maintenance : `minimax/${maintenance}`],
        heavy: [heavy.startsWith("minimax/") ? heavy : `minimax/${heavy}`],
        minimax: { thinking: "disabled" },
      },
      agents: {
        defaults: {
          models: {
            "minimax/MiniMax-M3": { alias: "minimax-m3" },
            "minimax/MiniMax-M2.7-highspeed": { alias: "minimax-fast" },
            "minimax/MiniMax-M2.7": { alias: "minimax" },
          },
        },
      },
    },
    null,
    2,
  );
}
