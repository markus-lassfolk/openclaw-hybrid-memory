/**
 * Audit store for LLM feedback signal classifications.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type SignalClassificationRow = {
  id: string;
  sessionFile: string;
  turnIndex: number;
  source: string;
  verdict: string;
  polarity: string;
  confidence: number;
  categories: string[];
  explanation: string;
  recommendedPipeline: string;
  routedTo: string | null;
  model: string | null;
  userMessagePreview: string | null;
  createdAt: number;
};

export function insertSignalClassification(
  db: DatabaseSync,
  entry: Omit<SignalClassificationRow, "id" | "createdAt"> & { id?: string; createdAt?: number },
): string {
  const id = entry.id ?? randomUUID();
  const createdAt = entry.createdAt ?? Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO signal_classifications
      (id, session_file, turn_index, source, verdict, polarity, confidence, categories, explanation,
       recommended_pipeline, routed_to, model, user_message_preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.sessionFile,
    entry.turnIndex,
    entry.source,
    entry.verdict,
    entry.polarity,
    entry.confidence,
    JSON.stringify(entry.categories),
    entry.explanation,
    entry.recommendedPipeline,
    entry.routedTo,
    entry.model,
    entry.userMessagePreview,
    createdAt,
  );
  return id;
}

export function hashClassificationInput(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
