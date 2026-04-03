/**
 * Fact variants and multi-model embeddings (Issue #954).
 */
import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export function bufferToFloat32Array(buf: Buffer): Float32Array {
  const byteLen = buf.byteLength;
  const ab = new ArrayBuffer(byteLen);
  new Uint8Array(ab).set(new Uint8Array(buf.buffer, buf.byteOffset, byteLen));
  return new Float32Array(ab);
}

export function storeVariant(db: DatabaseSync, factId: string, variantType: string, variantText: string): number {
  const result = db
    .prepare(
      `INSERT INTO fact_variants (fact_id, variant_type, variant_text)
       VALUES (?, ?, ?)`,
    )
    .run(factId, variantType, variantText);
  return result.lastInsertRowid as number;
}

export function getVariants(
  db: DatabaseSync,
  factId: string,
): Array<{ id: number; variantType: string; variantText: string; createdAt: string }> {
  return (
    db
      .prepare("SELECT id, variant_type, variant_text, created_at FROM fact_variants WHERE fact_id = ?")
      .all(factId) as Array<{
      id: number;
      variant_type: string;
      variant_text: string;
      created_at: string;
    }>
  ).map((r) => ({
    id: r.id,
    variantType: r.variant_type,
    variantText: r.variant_text,
    createdAt: r.created_at,
  }));
}

export function hasVariants(db: DatabaseSync, factId: string): boolean {
  const row = db.prepare("SELECT 1 FROM fact_variants WHERE fact_id = ? LIMIT 1").get(factId);
  return row !== undefined;
}

export function deleteVariants(db: DatabaseSync, factId: string): void {
  db.prepare("DELETE FROM fact_variants WHERE fact_id = ?").run(factId);
}

export function storeEmbedding(
  db: DatabaseSync,
  factId: string,
  model: string,
  variant: string,
  embedding: Float32Array,
  dimensions: number,
): void {
  const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.prepare(
    `INSERT INTO fact_embeddings (fact_id, model, variant, embedding, dimensions)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fact_id, model, variant) DO UPDATE SET
       embedding = excluded.embedding,
       dimensions = excluded.dimensions,
       created_at = datetime('now')`,
  ).run(factId, model, variant, blob, dimensions);
}

export function getEmbeddings(
  db: DatabaseSync,
  factId: string,
): Array<{ model: string; variant: string; embedding: Float32Array }> {
  const rows = db
    .prepare("SELECT model, variant, embedding FROM fact_embeddings WHERE fact_id = ?")
    .all(factId) as Array<{ model: string; variant: string; embedding: Buffer }>;
  return rows.map((r) => ({
    model: r.model,
    variant: r.variant,
    embedding: bufferToFloat32Array(r.embedding),
  }));
}

export function getEmbeddingsByModel(
  db: DatabaseSync,
  model: string,
  limit?: number,
): Array<{ factId: string; embedding: Float32Array }> {
  const sql =
    limit != null
      ? `SELECT fact_id, embedding FROM fact_embeddings WHERE model = ? AND variant = 'canonical' ORDER BY id DESC LIMIT ?`
      : `SELECT fact_id, embedding FROM fact_embeddings WHERE model = ? AND variant = 'canonical'`;
  const rows = (limit != null ? db.prepare(sql).all(model, limit) : db.prepare(sql).all(model)) as Array<{
    fact_id: string;
    embedding: Buffer;
  }>;
  return rows.map((r) => ({
    factId: r.fact_id,
    embedding: bufferToFloat32Array(r.embedding),
  }));
}

export function deleteEmbeddings(db: DatabaseSync, factId: string): void {
  db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?").run(factId);
}

export function countCanonicalEmbeddings(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM fact_embeddings WHERE variant = 'canonical'").get() as {
    c: number;
  };
  return Number(row?.c ?? 0);
}

export function estimateStorageBytesOnDisk(dbPath: string): {
  sqliteBytes: number;
  walBytes: number;
  shmBytes: number;
} {
  let sqliteBytes = 0;
  let walBytes = 0;
  let shmBytes = 0;

  try {
    if (existsSync(dbPath)) {
      sqliteBytes = statSync(dbPath).size;
    }
  } catch {
    // ignore
  }

  try {
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      walBytes = statSync(walPath).size;
    }
  } catch {
    // ignore
  }

  try {
    const shmPath = `${dbPath}-shm`;
    if (existsSync(shmPath)) {
      shmBytes = statSync(shmPath).size;
    }
  } catch {
    // ignore
  }

  return { sqliteBytes, walBytes, shmBytes };
}
