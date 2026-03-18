/**
 * ApiTap Store — SQLite backend for discovered API endpoints (Issue #614).
 *
 * Persists endpoints discovered by `apitap capture` / `apitap peek` with TTL expiry.
 * Each entry represents one parameterized API endpoint with sample request/response.
 *
 * Schema follows IssueStore / ToolProposalStore conventions.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApitapEndpointStatus = "pending" | "reviewed" | "accepted" | "rejected";

export interface ApitapEndpoint {
  id: string;
  /** Original site URL that was captured. */
  siteUrl: string;
  /** Discovered API endpoint path (e.g. /api/v1/users). */
  endpoint: string;
  /** HTTP method (GET, POST, PUT, DELETE, PATCH). */
  method: string;
  /** Parsed parameters object. */
  parameters: Record<string, unknown>;
  /** Parsed sample response body. */
  sampleResponse: unknown;
  /** Content-Type of response. */
  contentType: string;
  /** Session ID that captured this endpoint. */
  sessionId: string;
  /** ISO timestamp when captured. */
  capturedAt: string;
  /** ISO timestamp when TTL expires (null = never). */
  expiresAt: string | null;
  status: ApitapEndpointStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApitapEndpointInput {
  siteUrl: string;
  endpoint: string;
  method: string;
  /** Parameters as an object (serialized to JSON) or JSON string. */
  parameters?: Record<string, unknown> | string;
  /** Sample response (serialized to JSON) or JSON string. */
  sampleResponse?: unknown | string;
  contentType?: string;
  sessionId?: string;
  capturedAt?: string;
  /** ISO timestamp for expiry (null = never). Takes priority over endpointTtlDays. */
  expiresAt?: string | null;
  /** Convenience: compute expiresAt from TTL days from now. */
  endpointTtlDays?: number;
}

export interface ApitapEndpointFilter {
  siteUrl?: string;
  sessionId?: string;
  status?: ApitapEndpointStatus;
  includeExpired?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// ApitapStore
// ---------------------------------------------------------------------------

export class ApitapStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apitap_endpoints (
        id              TEXT PRIMARY KEY,
        site_url        TEXT NOT NULL,
        endpoint        TEXT NOT NULL,
        method          TEXT NOT NULL DEFAULT 'GET',
        parameters      TEXT NOT NULL DEFAULT '{}',
        sample_response TEXT NOT NULL DEFAULT '',
        content_type    TEXT NOT NULL DEFAULT '',
        session_id      TEXT NOT NULL DEFAULT '',
        captured_at     TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at      TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_apitap_site_url  ON apitap_endpoints(site_url);
      CREATE INDEX IF NOT EXISTS idx_apitap_session   ON apitap_endpoints(session_id);
      CREATE INDEX IF NOT EXISTS idx_apitap_status    ON apitap_endpoints(status);
      CREATE INDEX IF NOT EXISTS idx_apitap_expires   ON apitap_endpoints(expires_at);
    `);
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  create(input: CreateApitapEndpointInput): ApitapEndpoint {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Serialize parameters/sampleResponse objects to JSON strings for SQLite
    const parametersStr =
      typeof input.parameters === "string" ? input.parameters : JSON.stringify(input.parameters ?? {});
    const sampleResponseStr =
      typeof input.sampleResponse === "string" ? input.sampleResponse : JSON.stringify(input.sampleResponse ?? null);

    // Compute expiresAt: explicit value wins; endpointTtlDays computes if no explicit expiresAt
    let expiresAt: string | null = input.expiresAt !== undefined ? (input.expiresAt ?? null) : null;
    if (expiresAt === null && !("expiresAt" in input) && input.endpointTtlDays && input.endpointTtlDays > 0) {
      expiresAt = new Date(Date.now() + input.endpointTtlDays * 24 * 60 * 60_000).toISOString();
    }

    this.db
      .prepare(
        `INSERT INTO apitap_endpoints
           (id, site_url, endpoint, method, parameters, sample_response, content_type,
            session_id, captured_at, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.siteUrl,
        input.endpoint,
        input.method.toUpperCase(),
        parametersStr,
        sampleResponseStr,
        input.contentType ?? "",
        input.sessionId ?? "",
        input.capturedAt ?? now,
        expiresAt,
        now,
        now,
      );

    return this.getById(id)!;
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  getById(id: string): ApitapEndpoint | null {
    const row = this.db.prepare("SELECT * FROM apitap_endpoints WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToEndpoint(row);
  }

  // -------------------------------------------------------------------------
  // list — filtered listing
  // -------------------------------------------------------------------------

  list(filter?: ApitapEndpointFilter): ApitapEndpoint[] {
    let query = "SELECT * FROM apitap_endpoints WHERE 1=1";
    const params: SQLInputValue[] = [];

    if (filter?.siteUrl) {
      query += " AND site_url LIKE ?";
      params.push(`%${filter.siteUrl}%`);
    }
    if (filter?.sessionId) {
      query += " AND session_id = ?";
      params.push(filter.sessionId);
    }
    if (filter?.status) {
      query += " AND status = ?";
      params.push(filter.status);
    }
    if (!filter?.includeExpired) {
      query += " AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
    }

    query += " ORDER BY created_at DESC";

    if (filter?.limit && filter.limit > 0) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEndpoint(r));
  }

  // -------------------------------------------------------------------------
  // updateStatus
  // -------------------------------------------------------------------------

  updateStatus(id: string, status: ApitapEndpointStatus): ApitapEndpoint | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE apitap_endpoints SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  // -------------------------------------------------------------------------
  // deleteExpired — prune endpoints past their TTL
  // -------------------------------------------------------------------------

  deleteExpired(): number {
    const result = this.db
      .prepare(
        "DELETE FROM apitap_endpoints WHERE expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      )
      .run();
    return Number(result.changes);
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  count(status?: ApitapEndpointStatus): number {
    const row = status
      ? (this.db.prepare("SELECT COUNT(*) as n FROM apitap_endpoints WHERE status = ?").get(status) as { n: number })
      : (this.db.prepare("SELECT COUNT(*) as n FROM apitap_endpoints").get() as { n: number });
    return row.n;
  }

  // -------------------------------------------------------------------------
  // existsForSession — check if a session has already been captured
  // -------------------------------------------------------------------------

  countForSession(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM apitap_endpoints WHERE session_id = ?").get(sessionId) as {
      n: number;
    };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // close / isOpen
  // -------------------------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "db-close",
        subsystem: "apitap-store",
        severity: "info",
      });
    }
  }

  isOpen(): boolean {
    return !this.closed;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rowToEndpoint(row: Record<string, unknown>): ApitapEndpoint {
    let parameters: Record<string, unknown> = {};
    try {
      parameters = JSON.parse((row.parameters as string) ?? "{}");
    } catch {
      /* keep empty */
    }
    let sampleResponse: unknown = null;
    try {
      sampleResponse = JSON.parse((row.sample_response as string) ?? "null");
    } catch {
      /* keep null */
    }
    return {
      id: row.id as string,
      siteUrl: row.site_url as string,
      endpoint: row.endpoint as string,
      method: row.method as string,
      parameters,
      sampleResponse,
      contentType: row.content_type as string,
      sessionId: row.session_id as string,
      capturedAt: row.captured_at as string,
      expiresAt: (row.expires_at as string | null) ?? null,
      status: row.status as ApitapEndpointStatus,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
