/**
 * Tests for ApitapStore — SQLite backend for discovered API endpoints (Issue #614).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApitapStore } from "../backends/apitap-store.js";

let tmpDir: string;
let store: ApitapStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "apitap-store-test-"));
  store = new ApitapStore(join(tmpDir, "apitap.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("ApitapStore.create", () => {
  it("creates an endpoint with required fields and assigns id", () => {
    const ep = store.create({
      siteUrl: "https://example.com",
      endpoint: "/api/users",
      method: "GET",
      sessionId: "session-1",
    });
    expect(ep.id).toBeDefined();
    expect(ep.siteUrl).toBe("https://example.com");
    expect(ep.endpoint).toBe("/api/users");
    expect(ep.method).toBe("GET");
    expect(ep.status).toBe("pending");
    expect(ep.sessionId).toBe("session-1");
    expect(ep.createdAt).toBeDefined();
  });

  it("stores parameters and sampleResponse as parsed objects", () => {
    const params = { page: 1, limit: 20 };
    const sample = { data: [], total: 0 };
    const ep = store.create({
      siteUrl: "https://example.com",
      endpoint: "/api/items",
      method: "GET",
      parameters: params,
      sampleResponse: sample,
      sessionId: "session-2",
    });
    expect(ep.parameters).toEqual(params);
    expect(ep.sampleResponse).toEqual(sample);
  });

  it("assigns a TTL-based expires_at when endpointTtlDays is provided", () => {
    const ep = store.create({
      siteUrl: "https://example.com",
      endpoint: "/api/data",
      method: "POST",
      sessionId: "session-3",
      endpointTtlDays: 30,
    });
    expect(ep.expiresAt).toBeDefined();
    expect(ep.expiresAt).not.toBeNull();
  });

  it("method is uppercased", () => {
    const ep = store.create({
      siteUrl: "https://example.com",
      endpoint: "/api/posts",
      method: "post",
      sessionId: "s",
    });
    expect(ep.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// GetById
// ---------------------------------------------------------------------------

describe("ApitapStore.getById", () => {
  it("returns the endpoint by id", () => {
    const ep = store.create({
      siteUrl: "https://example.com",
      endpoint: "/api/v1/posts",
      method: "GET",
      sessionId: "sess",
    });
    const found = store.getById(ep.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(ep.id);
    expect(found?.endpoint).toBe("/api/v1/posts");
  });

  it("returns null for unknown id", () => {
    expect(store.getById("nonexistent-id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("ApitapStore.list", () => {
  beforeEach(() => {
    store.create({ siteUrl: "https://a.com", endpoint: "/api/a", method: "GET", sessionId: "s1" });
    store.create({ siteUrl: "https://b.com", endpoint: "/api/b", method: "POST", sessionId: "s1" });
    store.create({ siteUrl: "https://c.com", endpoint: "/api/c", method: "GET", sessionId: "s2" });
  });

  it("lists all endpoints", () => {
    expect(store.list()).toHaveLength(3);
  });

  it("filters by sessionId", () => {
    const results = store.list({ sessionId: "s1" });
    expect(results).toHaveLength(2);
    expect(results.every((ep) => ep.sessionId === "s1")).toBe(true);
  });

  it("filters by status", () => {
    const ep = store.list()[0];
    store.updateStatus(ep.id, "accepted");
    const accepted = store.list({ status: "accepted" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].id).toBe(ep.id);
  });

  it("filters by siteUrl", () => {
    const results = store.list({ siteUrl: "https://a.com" });
    expect(results).toHaveLength(1);
    expect(results[0].endpoint).toBe("/api/a");
  });

  it("respects limit", () => {
    expect(store.list({ limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// UpdateStatus
// ---------------------------------------------------------------------------

describe("ApitapStore.updateStatus", () => {
  it("transitions status from pending to reviewed", () => {
    const ep = store.create({ siteUrl: "https://x.com", endpoint: "/ep", method: "GET", sessionId: "sx" });
    store.updateStatus(ep.id, "reviewed");
    const updated = store.getById(ep.id);
    expect(updated?.status).toBe("reviewed");
  });

  it("transitions to accepted", () => {
    const ep = store.create({ siteUrl: "https://x.com", endpoint: "/ep2", method: "DELETE", sessionId: "sx" });
    store.updateStatus(ep.id, "accepted");
    expect(store.getById(ep.id)?.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// DeleteExpired
// ---------------------------------------------------------------------------

describe("ApitapStore.deleteExpired", () => {
  it("returns 0 when no endpoints have expired", () => {
    store.create({ siteUrl: "https://x.com", endpoint: "/ep", method: "GET", sessionId: "sx", endpointTtlDays: 30 });
    expect(store.deleteExpired()).toBe(0);
  });

  it("removes already-expired endpoints and excludes them from list()", () => {
    // Insert one endpoint that expired in the past
    const pastExpiry = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    store.create({ siteUrl: "https://x.com", endpoint: "/old", method: "GET", sessionId: "sx", expiresAt: pastExpiry });
    // Insert one endpoint that expires in the future
    store.create({ siteUrl: "https://x.com", endpoint: "/fresh", method: "GET", sessionId: "sx", endpointTtlDays: 30 });

    const deleted = store.deleteExpired();
    expect(deleted).toBe(1);

    const remaining = store.list({ includeExpired: false });
    expect(remaining.map((e) => e.endpoint)).not.toContain("/old");
    expect(remaining.map((e) => e.endpoint)).toContain("/fresh");
  });
});

// ---------------------------------------------------------------------------
// CountForSession
// ---------------------------------------------------------------------------

describe("ApitapStore.countForSession", () => {
  it("counts endpoints for a session", () => {
    store.create({ siteUrl: "https://x.com", endpoint: "/a", method: "GET", sessionId: "s-count" });
    store.create({ siteUrl: "https://x.com", endpoint: "/b", method: "POST", sessionId: "s-count" });
    store.create({ siteUrl: "https://y.com", endpoint: "/c", method: "GET", sessionId: "other" });
    expect(store.countForSession("s-count")).toBe(2);
    expect(store.countForSession("other")).toBe(1);
    expect(store.countForSession("nonexistent")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IsOpen / Close
// ---------------------------------------------------------------------------

describe("ApitapStore.isOpen / close", () => {
  it("isOpen returns true after construction", () => {
    expect(store.isOpen()).toBe(true);
  });

  it("isOpen returns false after close", () => {
    store.close();
    expect(store.isOpen()).toBe(false);
  });

  it("double-close does not throw", () => {
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
