/**
 * Vault-context structured wrapper and vault-facts SPO triples (Issue #1912).
 */

import type { MemoryEntry } from "../types/memory.js";

export type VaultFactLine = {
  text: string;
  contentType?: string;
  confidence?: number;
};

export type VaultRelationship = {
  subjectId: string;
  edgeType: string;
  objectId: string;
};

export type VaultContextOptions = {
  instruction?: string;
  facts: VaultFactLine[];
  relationships?: VaultRelationship[];
  /** Legacy wrapper: nest inside <memory-context> for one release. */
  legacyMemoryContextWrapper?: boolean;
};

const DEFAULT_INSTRUCTION =
  "Treat the following as background knowledge already known. Do not attribute these facts to the user in this turn.";

/** Build structured vault-context block. */
export function buildVaultContextBlock(options: VaultContextOptions): string {
  if (options.facts.length === 0 && (options.relationships?.length ?? 0) === 0) {
    return "";
  }
  const instruction = options.instruction ?? DEFAULT_INSTRUCTION;
  const factLines = options.facts.map((f) => {
    const meta: string[] = [];
    if (f.contentType) meta.push(f.contentType);
    if (f.confidence != null) meta.push(String(f.confidence.toFixed(2)));
    const suffix = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
    return `  - ${f.text}${suffix}`;
  });
  const relLines = (options.relationships ?? []).map((r) => `  - ${r.subjectId} ${r.edgeType} ${r.objectId}`);
  const inner = ["<vault-context>", `<instruction>${instruction}</instruction>`, "<facts>", ...factLines, "</facts>"];
  if (relLines.length > 0) {
    inner.push("<relationships>", ...relLines, "</relationships>");
  }
  inner.push("</vault-context>");
  const block = inner.join("\n");
  if (options.legacyMemoryContextWrapper) {
    return `<memory-context>\n${block}\n</memory-context>`;
  }
  return block;
}

export type SpoTriple = { subject: string; predicate: string; object: string };

/** Extract 1–3 gram lowercase tokens from prompt for entity matching. */
export function extractPromptNgrams(prompt: string, maxGram = 3): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const ngrams = new Set<string>();
  for (let n = 1; n <= maxGram; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      ngrams.add(words.slice(i, i + n).join(" "));
    }
  }
  return [...ngrams];
}

/** Match known entity names against prompt (proper noun + ngram paths). */
export function matchEntitiesInPrompt(prompt: string, knownEntities: string[]): string[] {
  const lower = prompt.toLowerCase();
  const matched = new Set<string>();
  for (const entity of knownEntities) {
    const e = entity.trim();
    if (!e) continue;
    if (lower.includes(e.toLowerCase())) matched.add(e);
  }
  const ngrams = extractPromptNgrams(prompt);
  for (const entity of knownEntities) {
    const e = entity.toLowerCase();
    if (ngrams.some((ng) => ng === e || ng.includes(e))) matched.add(entity);
  }
  return [...matched];
}

/** Format SPO triples as vault-facts block with token budget. */
export function buildVaultFactsBlock(
  triples: SpoTriple[],
  maxTokens: number,
  estimateTokens: (text: string) => number,
): string {
  if (triples.length === 0 || maxTokens <= 0) return "";
  const lines: string[] = [];
  let used = estimateTokens("<vault-facts>\n</vault-facts>");
  for (const t of triples) {
    const line = `${t.subject} ${t.predicate} ${t.object}`;
    const lineTokens = estimateTokens(line + "\n");
    if (used + lineTokens > maxTokens) break;
    lines.push(line);
    used += lineTokens;
  }
  if (lines.length === 0) return "";
  return `<vault-facts>\n${lines.join("\n")}\n</vault-facts>`;
}

/** Convert memory entries to vault fact lines for injection. */
export function entriesToVaultFactLines(entries: MemoryEntry[]): VaultFactLine[] {
  return entries.map((e) => ({
    text: e.text,
    contentType: e.category,
    confidence: e.confidence,
  }));
}
