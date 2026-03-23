import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import type { IdentityReflectionStore, IdentityReflectionEntry } from "../backends/identity-reflection-store.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { chatCompleteWithRetry } from "./chat.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { capturePluginError } from "./error-reporter.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";

const REPLACE_PREFIXES = [
  /^replace the entire file\b/i,
  /^replace entire file\b/i,
  /^replace the whole file\b/i,
  /^replace whole file\b/i,
  /^replace the file\b/i,
] as const;

export interface PersonaProposalItem {
  targetFile: string;
  title: string;
  observation: string;
  suggestedChange: string;
  confidence: number;
}

export interface PersonaProposalOptions {
  dryRun: boolean;
  model: string;
  verbose?: boolean;
  window?: number;
  fallbackModels?: string[];
  resolvePath?: (file: string) => string;
}

export interface PersonaProposalResult {
  created: number;
  insightsUsed: number;
}

function normalizeForDedupe(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseSuggestedChangeType(suggestedChange: string): "append" | "replace" {
  const firstLine = suggestedChange.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return REPLACE_PREFIXES.some((re) => re.test(firstLine)) ? "replace" : "append";
}

function capProposalConfidence(confidence: number, targetFile: string, suggestedChange: string): number {
  const changeType = parseSuggestedChangeType(suggestedChange);
  if (changeType === "replace" && targetFile === "SOUL.md") {
    return Math.min(confidence, 0.5);
  }
  if (changeType === "replace") {
    return Math.min(confidence, 0.6);
  }
  return confidence;
}

export function parsePersonaProposalResponse(raw: string, allowedFiles: string[]): PersonaProposalItem[] {
  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  const json =
    firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket
      ? raw.slice(firstBracket, lastBracket + 1)
      : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const items: PersonaProposalItem[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const targetFile = typeof obj.targetFile === "string" ? obj.targetFile.trim() : "";
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const observation = typeof obj.observation === "string" ? obj.observation.trim() : "";
    const suggestedChange = typeof obj.suggestedChange === "string" ? obj.suggestedChange.trim() : "";
    const confidenceRaw =
      typeof obj.confidence === "number" ? obj.confidence : Number.parseFloat(String(obj.confidence ?? ""));
    if (!allowedFiles.includes(targetFile)) continue;
    if (!title || !observation || !suggestedChange) continue;
    if (title.length > 256 || observation.length > 2000 || suggestedChange.length > 50_000) continue;
    if (!Number.isFinite(confidenceRaw)) continue;
    const confidence = Math.max(0, Math.min(1, confidenceRaw));
    const key = `${targetFile}\u0000${normalizeForDedupe(title)}\u0000${normalizeForDedupe(suggestedChange)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ targetFile, title, observation, suggestedChange, confidence });
  }
  return items;
}

function formatReflectionInsight(entry: IdentityReflectionEntry): string {
  const evidence = entry.evidence.length > 0 ? ` | evidence: ${entry.evidence.join("; ")}` : "";
  return `- [${entry.questionKey}] (${entry.durability}, conf=${entry.confidence.toFixed(2)}) ${entry.insight}${evidence}`;
}

function defaultResolvePath(file: string): string {
  const workspace = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  return join(workspace, file);
}

export class PersonaProposer {
  constructor(
    private readonly proposalsDb: ProposalsDB,
    private readonly identityReflectionStore: IdentityReflectionStore,
    private readonly cfg: HybridMemoryConfig,
    private readonly openai: OpenAI,
    private readonly logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
  ) {}

  async run(opts: PersonaProposalOptions): Promise<PersonaProposalResult> {
    if (!this.cfg.personaProposals.enabled) {
      return { created: 0, insightsUsed: 0 };
    }

    const windowDays = Math.min(90, Math.max(1, Math.floor(opts.window ?? this.cfg.identityReflection.defaultWindow)));
    const cutoff = Math.floor(Date.now() / 1000) - windowDays * 24 * 3600;
    const reflections = this.cfg.identityReflection.questions
      .map((question) => this.identityReflectionStore.getLatestByQuestion(question.key))
      .filter((entry): entry is IdentityReflectionEntry => !!entry && entry.createdAt >= cutoff)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (reflections.length === 0) {
      if (opts.verbose) {
        this.logger.info?.("memory-hybrid: generate-proposals — no identity reflections available; skipping.");
      }
      return { created: 0, insightsUsed: 0 };
    }

    const allowedFiles = this.cfg.personaProposals.allowedFiles;
    const resolvePath = opts.resolvePath ?? defaultResolvePath;
    const identityFilesBlock = allowedFiles
      .map((file) => {
        try {
          const path = resolvePath(file);
          if (!existsSync(path)) return `--- ${file} ---\n(file not found)\n`;
          return `--- ${file} ---\n${readFileSync(path, "utf-8").slice(0, 8000)}\n`;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "persona-proposer",
            operation: "read-identity-file",
            file,
          });
          return `--- ${file} ---\n(error reading file)\n`;
        }
      })
      .join("\n");

    const prompt = fillPrompt(loadPrompt("generate-proposals"), {
      allowed_files: allowedFiles.join(", "),
      min_confidence: String(this.cfg.personaProposals.minConfidence),
      insights: reflections.map(formatReflectionInsight).join("\n"),
      identity_files: identityFilesBlock,
    });

    let rawResponse: string;
    try {
      rawResponse = await chatCompleteWithRetry({
        model: opts.model,
        content: prompt,
        temperature: 0.3,
        maxTokens: 4000,
        openai: this.openai,
        fallbackModels: opts.fallbackModels ?? [],
        label: "memory-hybrid: generate-proposals",
        feature: "persona-proposals",
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn?.(
        `memory-hybrid: generate-proposals LLM call failed (model=${opts.model}, fallbacks=${JSON.stringify(opts.fallbackModels ?? [])}): ${errMsg}`,
      );
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "persona-proposer",
        operation: "llm",
      });
      return { created: 0, insightsUsed: reflections.length };
    }

    const parsed = parsePersonaProposalResponse(rawResponse, allowedFiles);
    const minConfidence = this.cfg.personaProposals.minConfidence;
    const recentCount = this.proposalsDb.countRecentProposals(7);
    const maxPerWeek = this.cfg.personaProposals.maxProposalsPerWeek;
    const expiresAt =
      this.cfg.personaProposals.proposalTTLDays > 0
        ? Math.floor(Date.now() / 1000) + this.cfg.personaProposals.proposalTTLDays * 24 * 3600
        : null;
    const evidenceSessions = reflections.slice(0, Math.max(1, this.cfg.personaProposals.minSessionEvidence)).map((r) => r.id);
    const existingPendingOrApproved = this.proposalsDb
      .list()
      .filter((proposal) => proposal.status === "pending" || proposal.status === "approved");

    let created = 0;
    for (const item of parsed) {
      if (recentCount + created >= maxPerWeek) break;

      const cappedConfidence = capProposalConfidence(item.confidence, item.targetFile, item.suggestedChange);
      if (cappedConfidence < minConfidence) {
        if (opts.verbose) {
          this.logger.info?.(
            `memory-hybrid: proposal dropped — confidence ${cappedConfidence.toFixed(2)} below minConf ${minConfidence}: ${item.title} -> ${item.targetFile}`,
          );
        }
        continue;
      }

      const duplicate = existingPendingOrApproved.some(
        (proposal) =>
          proposal.targetFile === item.targetFile &&
          normalizeForDedupe(proposal.title) === normalizeForDedupe(item.title) &&
          normalizeForDedupe(proposal.suggestedChange) === normalizeForDedupe(item.suggestedChange),
      );
      if (duplicate) continue;

      if (opts.dryRun) {
        created++;
        continue;
      }

      const snapshot = getFileSnapshot(resolvePath(item.targetFile));
      try {
        this.proposalsDb.create({
          targetFile: item.targetFile,
          title: item.title,
          observation: item.observation,
          suggestedChange: item.suggestedChange,
          confidence: cappedConfidence,
          evidenceSessions,
          expiresAt,
          targetMtimeMs: snapshot?.mtimeMs ?? null,
          targetHash: snapshot?.hash ?? null,
        });
        created++;
        if (opts.verbose) {
          this.logger.info?.(`memory-hybrid: proposal created: ${item.title} -> ${item.targetFile}`);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "persona-proposer",
          operation: "create-proposal",
          targetFile: item.targetFile,
        });
      }
    }

    return { created, insightsUsed: reflections.length };
  }
}
