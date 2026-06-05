import type { AbRunResult, AbTaskId, AbModelId, AbThinkingMode } from "./types.js";
import { MODELS } from "./types.js";

export type TaskRecommendation = {
  task: AbTaskId;
  model: AbModelId;
  thinking: AbThinkingMode;
  score: number;
  rationale: string;
};

/** Map A/B sweep label to production config (`enabled` → `adaptive`). */
export function toProductionThinking(thinking: AbThinkingMode): "disabled" | "adaptive" {
  return thinking === "disabled" ? "disabled" : "adaptive";
}

function wireModelId(model: AbModelId): string {
  return model.startsWith("minimax/") ? model : `minimax/${model}`;
}

/** Primary quality signal per task (higher = richer output). */
export function qualityRichness(cell: AbRunResult["cells"][number]): number {
  if (cell.operational.skipped === true) return 0;
  if (!cell.ok) return -1;
  const op = cell.operational;
  switch (cell.task) {
    case "reflection":
      return typeof op.patternCount === "number" ? op.patternCount : 0;
    case "distill":
      return typeof op.jsonlLines === "number" ? op.jsonlLines : 0;
    case "self-correction":
    case "reinforcement":
      if (typeof op.coveragePct === "number") return op.coveragePct;
      return typeof op.parsed === "number" ? op.parsed * 10 : 100;
    case "consolidation":
      if (op.finishReason === "length") return 0;
      return typeof op.mergedChars === "number" ? op.mergedChars : 50;
    default:
      return 1;
  }
}

/** Operational failure penalties (subtracted from quality score). */
export function operationalPenalty(cell: AbRunResult["cells"][number]): number {
  if (cell.operational.skipped === true) return 0;
  if (!cell.ok) return 10_000;
  let penalty = 0;
  const op = cell.operational;
  if (typeof op.parseFailures === "number") penalty += op.parseFailures * 100;
  if (typeof op.truncations === "number") penalty += op.truncations * 100;
  if (op.truncated === true || op.finishReason === "length") penalty += 500;
  if (typeof op.coveragePct === "number" && op.coveragePct < 100) penalty += (100 - op.coveragePct) * 5;
  if (typeof op.patternCount === "number" && op.patternCount < 2) penalty += 200;
  if (typeof op.jsonlLines === "number" && op.jsonlLines < 3) penalty += 200;
  return penalty;
}

/**
 * Quality-first score for scheduled maintenance: richness and reliability dominate;
 * latency is a minor tie-breaker only (~1 point per minute, max 5).
 */
export function scoreCell(cell: AbRunResult["cells"][number]): number {
  if (cell.operational.skipped === true) return 50;
  const richness = qualityRichness(cell);
  if (richness < 0) return 0;
  const penalty = operationalPenalty(cell);
  const latencyTieBreak = Math.min(5, Math.floor(cell.latencyMs / 60_000));
  return Math.max(0, richness * 10 - penalty - latencyTieBreak);
}

export function compareCells(a: AbRunResult["cells"][number], b: AbRunResult["cells"][number]): number {
  if (a.ok !== b.ok) return a.ok ? -1 : 1;
  const richnessDiff = qualityRichness(b) - qualityRichness(a);
  if (richnessDiff !== 0) return richnessDiff > 0 ? 1 : -1;
  const penaltyDiff = operationalPenalty(a) - operationalPenalty(b);
  if (penaltyDiff !== 0) return penaltyDiff > 0 ? 1 : -1;
  return a.latencyMs - b.latencyMs;
}

function formatRichness(cell: AbRunResult["cells"][number]): string {
  const r = qualityRichness(cell);
  const op = cell.operational;
  switch (cell.task) {
    case "reflection":
      return `patterns=${op.patternCount ?? r}`;
    case "distill":
      return `jsonlLines=${op.jsonlLines ?? r}`;
    case "consolidation":
      return `mergedChars=${op.mergedChars ?? r}`;
    case "self-correction":
    case "reinforcement":
      return `coverage=${op.coveragePct ?? "n/a"}%`;
    default:
      return `richness=${r}`;
  }
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
    "**Scoring policy:** quality-first (richness + operational gates). Latency is a minor tie-breaker only.",
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
    const cells = byTask.get(task)!.sort(compareCells);
    for (const c of cells) {
      const sc = scoreCell(c);
      lines.push(
        `- **${c.model}** thinking=\`${c.thinking}\` — score=${sc} ok=${c.ok} ${formatRichness(c)} latency=${c.latencyMs}ms ${JSON.stringify(c.operational)}`,
      );
    }
    const winner = cells[0];
    if (winner) {
      recommendations.push({
        task,
        model: winner.model,
        thinking: winner.thinking,
        score: scoreCell(winner),
        rationale: `Quality-first winner among ${cells.length} cells (${formatRichness(winner)}, ok=${winner.ok}, latency=${winner.latencyMs}ms). Human spot-check recommended.`,
      });
      lines.push("");
      lines.push(
        `**Recommended:** \`${winner.model}\` with thinking=\`${winner.thinking}\` (score ${scoreCell(winner)})`,
      );
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

/** Suggested Maeve tier wiring from quality-first recommendations. */
export function maeveTierSnippet(recommendations: TaskRecommendation[]): string {
  const pick = (task: AbTaskId) => recommendations.find((r) => r.task === task);
  const sc = pick("self-correction");
  const reinf = pick("reinforcement");
  const refl = pick("reflection");
  const distill = pick("distill");

  const heavyModel = sc?.model ?? MODELS.m3;
  const maintenancePrimary = refl?.model ?? distill?.model ?? MODELS.m3;
  const nanoModel = reinf?.model ?? MODELS.m27Highspeed;

  return JSON.stringify(
    {
      _comment:
        "Quality-first recommendations from A/B harness. Latency ignored unless output quality is similar. Apply with approval.",
      llm: {
        nano: [wireModelId(nanoModel)],
        maintenance: [wireModelId(maintenancePrimary), wireModelId(MODELS.m27Highspeed)],
        default: [wireModelId(MODELS.m3)],
        heavy: [wireModelId(heavyModel)],
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
      selfCorrection: {
        model: wireModelId(sc?.model ?? MODELS.m3),
        thinking: toProductionThinking(sc?.thinking ?? "disabled"),
      },
      reinforcement: {
        model: wireModelId(reinf?.model ?? MODELS.m27Highspeed),
        thinking: toProductionThinking(reinf?.thinking ?? "disabled"),
      },
      distill: {
        modelTier: "maintenance",
        thinking: toProductionThinking(distill?.thinking ?? "disabled"),
      },
      reflection: {
        model: wireModelId(refl?.model ?? MODELS.m3),
        thinking: toProductionThinking(refl?.thinking ?? "adaptive"),
      },
    },
    null,
    2,
  );
}
