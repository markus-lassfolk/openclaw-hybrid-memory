/**
 * Provenance Service for fact-to-source tracing (Issue #163).
 *
 * Tracks provenance chains for every fact: from knowledge store back
 * through consolidation events to the original session and conversation turn.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvenanceEdgeType = "DERIVED_FROM" | "CONSOLIDATED_FROM" | "REFLECTED_FROM";
export type ProvenanceSourceType = "event_log" | "active_store" | "consolidation" | "reflection" | "document";

export interface ProvenanceEdge {
  edgeType: ProvenanceEdgeType;
  sourceType: ProvenanceSourceType;
  sourceId: string;
  sourceText?: string;
}

export interface ProvenanceEdgeRecord extends ProvenanceEdge {
  id: string;
  factId: string;
  createdAt: string;
}

export interface ProvenanceChain {
  fact: { id: string; text: string; confidence: number };
  source: {
    sessionId?: string;
    turn?: number;
    extractionMethod?: string;
    extractionConfidence?: number;
  };
  edges: Array<{
    edgeType: ProvenanceEdgeType;
    sourceType: ProvenanceSourceType;
    sourceId: string;
    sourceText?: string;
    createdAt: string;
  }>;
}

// ---------------------------------------------------------------------------
// Raw SQLite row types
// ---------------------------------------------------------------------------

interface ProvenanceEdgeRow {
  id: string;
  fact_id: string;
  edge_type: string;
  source_type: string;
  source_id: string;
  source_text: string | null;
  created_at: string;
}

interface FactProvenanceRow {
  id: string;
  text: string;
  confidence: number | null;
  provenance_session: string | null;
  source_turn: number | null;
  extraction_method: string | null;
  extraction_confidence: number | null;
}

// ---------------------------------------------------------------------------
// ProvenanceService
// ---------------------------------------------------------------------------

export class ProvenanceService {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.applyPragmas();
    this.initSchema();
  }

  private applyPragmas(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provenance_edges (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_text TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provenance_fact_id ON provenance_edges(fact_id);
      CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_provenance_created_at ON provenance_edges(created_at);
    `);
  }

  // -------------------------------------------------------------------------
  // addEdge — record a provenance edge for a fact
  // -------------------------------------------------------------------------

  addEdge(factId: string, edge: ProvenanceEdge): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO provenance_edges (id, fact_id, edge_type, source_type, source_id, source_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, factId, edge.edgeType, edge.sourceType, edge.sourceId, edge.sourceText ?? null, now);
    return id;
  }

  // -------------------------------------------------------------------------
  // getEdges — get all edges for a fact
  // -------------------------------------------------------------------------

  getEdges(factId: string): ProvenanceEdgeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM provenance_edges WHERE fact_id = ? ORDER BY created_at ASC`)
      .all(factId) as ProvenanceEdgeRow[];
    return rows.map((r) => ({
      id: r.id,
      factId: r.fact_id,
      edgeType: r.edge_type as ProvenanceEdgeType,
      sourceType: r.source_type as ProvenanceSourceType,
      sourceId: r.source_id,
      sourceText: r.source_text ?? undefined,
      createdAt: r.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // getProvenance — full provenance chain for a fact
  // -------------------------------------------------------------------------

  getProvenance(factId: string, factsDb?: Database.Database): ProvenanceChain {
    const edges = this.getEdges(factId);

    let factData: { id: string; text: string; confidence: number } = {
      id: factId,
      text: "",
      confidence: 0,
    };
    let source: ProvenanceChain["source"] = {};

    if (factsDb) {
      const row = factsDb
        .prepare(
          `SELECT id, text,
            COALESCE(importance, 0.0) as confidence,
            provenance_session, source_turn, extraction_method, extraction_confidence
           FROM facts WHERE id = ?`,
        )
        .get(factId) as FactProvenanceRow | undefined;

      if (row) {
        factData = { id: row.id, text: row.text, confidence: row.confidence ?? 0 };
        source = {
          sessionId: row.provenance_session ?? undefined,
          turn: row.source_turn ?? undefined,
          extractionMethod: row.extraction_method ?? undefined,
          extractionConfidence: row.extraction_confidence ?? undefined,
        };
      }
    }

    return {
      fact: factData,
      source,
      edges: edges.map((e) => ({
        edgeType: e.edgeType,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        sourceText: e.sourceText,
        createdAt: e.createdAt,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // getFactsFromSource — reverse lookup: all facts derived from a source
  // -------------------------------------------------------------------------

  getFactsFromSource(sourceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT fact_id FROM provenance_edges WHERE source_id = ?`)
      .all(sourceId) as Array<{ fact_id: string }>;
    return rows.map((r) => r.fact_id);
  }

  // -------------------------------------------------------------------------
  // prune — remove old provenance edges, keep recent ones
  // -------------------------------------------------------------------------

  prune(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM provenance_edges WHERE created_at < ?`).run(cutoff);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // close — release SQLite connection
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
