import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import { extractJsonArray } from "./json-array-parser.js";

export interface GradeableDocument {
  factId: string;
  text: string;
}

export interface DocumentGrade {
  factId: string;
  answer: "yes" | "no";
  relevant: boolean;
}

export interface DocumentGraderConfig {
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "openai/gpt-4.1-nano";

function buildGradePrompt(query: string, docs: GradeableDocument[]): string {
  const renderedDocs = docs
    .map((doc, index) => {
      const snippet = doc.text.length > 220 ? `${doc.text.slice(0, 217)}...` : doc.text;
      return `${index + 1}. ${snippet}`;
    })
    .join("\n\n");

  return (
    `You are grading retrieval relevance for a memory system. ` +
    `For each document, answer if it helps answer the query. ` +
    `Return ONLY a JSON array with one string per document: \"yes\" or \"no\".\n\n` +
    `Query: "${query}"\n\n` +
    `Documents:\n${renderedDocs}`
  );
}

function parseGrades(response: string, count: number): Array<"yes" | "no"> {
  const parsed = extractJsonArray(response)
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter((value): value is "yes" | "no" => value === "yes" || value === "no")
    .slice(0, count);

  if (parsed.length !== count) {
    return new Array(count).fill("yes");
  }

  return parsed;
}

function buildRewritePrompt(query: string, previousQueries: string[]): string {
  const previous = previousQueries.length > 0 ? previousQueries.map((q) => `- ${q}`).join("\n") : "- none";
  return (
    `Rewrite this memory lookup query so retrieval is more precise and grounded in likely stored facts. ` +
    `Prefer concise concrete nouns, entities, file names, settings, projects, dates, or error terms when helpful. ` +
    `Do not repeat any previous query exactly. Return ONLY the rewritten query text.\n\n` +
    `Original query: ${query}\n` +
    `Previous queries:\n${previous}`
  );
}

export class DocumentGrader {
  constructor(
    private readonly openai: OpenAI,
    private readonly config: DocumentGraderConfig = {},
  ) {}

  async gradeDocuments(query: string, docs: GradeableDocument[]): Promise<DocumentGrade[]> {
    if (docs.length === 0) return [];

    try {
      const response = await chatComplete({
        model: this.config.model ?? DEFAULT_MODEL,
        content: buildGradePrompt(query, docs),
        temperature: 0,
        maxTokens: 250,
        openai: this.openai,
        timeoutMs: this.config.timeoutMs,
      });

      const answers = parseGrades(response, docs.length);
      return docs.map((doc, index) => ({
        factId: doc.factId,
        answer: answers[index],
        relevant: answers[index] === "yes",
      }));
    } catch {
      return docs.map((doc) => ({ factId: doc.factId, answer: "yes", relevant: true }));
    }
  }

  async rewriteQuery(query: string, previousQueries: string[]): Promise<string | null> {
    try {
      const response = await chatComplete({
        model: this.config.model ?? DEFAULT_MODEL,
        content: buildRewritePrompt(query, previousQueries),
        temperature: 0.2,
        maxTokens: 80,
        openai: this.openai,
        timeoutMs: this.config.timeoutMs,
      });

      const rewritten =
        response
          .replace(/^['"`\s]+|['"`\s]+$/g, "")
          .split(/\r?\n/, 1)[0]
          ?.trim() ?? "";
      if (!rewritten) return null;
      if (previousQueries.some((previous) => previous.toLowerCase() === rewritten.toLowerCase())) return null;
      return rewritten;
    } catch {
      return null;
    }
  }
}
