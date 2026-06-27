import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectEpisodeFailureContradictions } from "../backends/facts-db/contradictions.js";
import { stripLeadingSqlAnd } from "../backends/facts-db/scope-sql.js";

describe("detectEpisodeFailureContradictions (#1976)", () => {
  let tmp: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = join(tmpdir(), `mh-ep-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    db = new DatabaseSync(join(tmp, "facts.db"));
    db.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        text TEXT,
        value TEXT,
        category TEXT,
        entity TEXT,
        key TEXT,
        scope TEXT DEFAULT 'global',
        scope_target TEXT,
        superseded_at INTEGER,
        expires_at INTEGER,
        created_at INTEGER DEFAULT 0
      );
    `);
    db.prepare(
      `INSERT INTO facts (id, text, value, category, scope, scope_target, created_at)
       VALUES (?, ?, ?, 'procedure', 'agent', ?, ?)`,
    ).run("proc-1", "Deploy app to production", "run deploy script", "agent:main", 1000);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("stripLeadingSqlAnd removes AND without requiring a leading space", () => {
    expect(stripLeadingSqlAnd("AND ( scope = 'global' OR scope = 'agent' )")).toBe("( scope = 'global' OR scope = 'agent' )");
  });

  it("does not throw near AND syntax error when agent scope filter is applied", () => {
    expect(() =>
      detectEpisodeFailureContradictions(db, "deploy failed due to missing env", null, {
        agentId: "agent:main",
      }),
    ).not.toThrow();
    const hits = detectEpisodeFailureContradictions(db, "deploy failed due to missing env", null, {
      agentId: "agent:main",
    });
    expect(Array.isArray(hits)).toBe(true);
  });
});
