import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSelfCorrectionExtract } from "../../services/self-correction-extract.js";
import { runReinforcementExtract } from "../../services/reinforcement-extract.js";
import { getCorrectionSignalRegex, getReinforcementSignalRegex } from "../../utils/language-keywords.js";
import type { CorrectionIncident } from "../../services/self-correction-extract.js";
import type { ReinforcementIncident } from "../../services/reinforcement-extract.js";
import type { AbCorpusMeta } from "./types.js";

export type FactsSample = {
  facts: Array<{
    id: string;
    text: string;
    category: string;
    entity?: string | null;
    key?: string | null;
  }>;
  consolidationClusters: Array<Array<{ id: string; text: string; category: string }>>;
};

export type AbCorpus = {
  meta: AbCorpusMeta;
  sessionPaths: string[];
  selfCorrectionIncidents: CorrectionIncident[];
  reinforcementIncidents: ReinforcementIncident[];
  factsSample: FactsSample;
  distillText: string;
};

function listSessionJsonl(sessionsRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(sessionsRoot)) return out;
  for (const agent of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const dir = join(sessionsRoot, agent.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      if (
        f.name.includes("trajectory") ||
        f.name.includes("codex-app-server") ||
        f.name.includes("deleted") ||
        f.name.includes("checkpoint")
      ) {
        continue;
      }
      out.push(join(dir, f.name));
    }
  }
  out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return out;
}

function buildDistillText(sessionPaths: string[], maxChars: number): string {
  const blocks: string[] = [];
  let total = 0;
  for (const fp of sessionPaths) {
    if (total >= maxChars) break;
    try {
      const raw = readFileSync(fp, "utf-8");
      const slice = raw.slice(0, Math.min(raw.length, maxChars - total));
      blocks.push(`--- SESSION: ${fp.split("/").pop()} ---\n${slice}`);
      total += slice.length;
    } catch {
      /* skip unreadable */
    }
  }
  return blocks.join("\n\n");
}

export async function loadCorpus(fixturesRoot: string, incidentCap = 40): Promise<AbCorpus> {
  const sessionsRoot = join(fixturesRoot, "sessions");
  const factsPath = join(fixturesRoot, "facts-sample.json");
  const sessionPaths = listSessionJsonl(sessionsRoot);

  const scAll = runSelfCorrectionExtract({
    filePaths: sessionPaths,
    correctionRegex: getCorrectionSignalRegex(),
  });
  const reinfAll = await runReinforcementExtract({
    filePaths: sessionPaths,
    reinforcementRegex: getReinforcementSignalRegex(),
  });

  const selfCorrectionIncidents = scAll.incidents.slice(0, incidentCap);
  const reinforcementIncidents = reinfAll.incidents.slice(0, incidentCap);

  const factsSample = JSON.parse(readFileSync(factsPath, "utf-8")) as FactsSample;
  const distillText = buildDistillText(sessionPaths, 120_000);

  const meta: AbCorpusMeta = {
    sessionFiles: sessionPaths.length,
    selfCorrectionIncidents: selfCorrectionIncidents.length,
    reinforcementIncidents: reinforcementIncidents.length,
    factsCount: factsSample.facts.length,
    consolidationClusters: factsSample.consolidationClusters.length,
    distillChars: distillText.length,
    extractedAt: new Date().toISOString(),
  };

  return {
    meta,
    sessionPaths,
    selfCorrectionIncidents,
    reinforcementIncidents,
    factsSample,
    distillText,
  };
}

/** Persist extracted corpus for reproducible reruns without re-scanning sessions. */
export function writeCorpusSnapshot(corpus: AbCorpus, path: string): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        meta: corpus.meta,
        selfCorrectionIncidents: corpus.selfCorrectionIncidents,
        reinforcementIncidents: corpus.reinforcementIncidents,
        factsSample: corpus.factsSample,
        distillText: corpus.distillText,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export function loadCorpusSnapshot(path: string): Omit<AbCorpus, "sessionPaths"> & { sessionPaths: string[] } {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as AbCorpus;
  return raw;
}
