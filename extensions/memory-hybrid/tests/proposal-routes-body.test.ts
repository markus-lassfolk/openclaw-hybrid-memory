import { describe, expect, it } from "vitest";

/** Mirrors proposal-routes parseBody merge logic for regression coverage. */
function parseBody(req: { url: string; body?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
  } catch {
    // ignore
  }
  const rawBody = req.body?.trim();
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (out[k] === undefined) out[k] = v;
        }
      }
    } catch {
      // ignore
    }
  }
  return out;
}

describe("proposal HTTP body parsing", () => {
  it("merges JSON POST body with query params (query wins on conflict)", () => {
    const body = parseBody({
      url: "/plugins/memory-proposals/approve?id=from-query",
      body: JSON.stringify({ id: "persona:abc", reason: "looks good" }),
    });
    expect(body.id).toBe("from-query");
    expect(body.reason).toBe("looks good");
  });

  it("reads id from JSON body when query param absent", () => {
    const body = parseBody({
      url: "/plugins/memory-proposals/approve",
      body: JSON.stringify({ id: "persona:abc-123" }),
    });
    expect(body.id).toBe("persona:abc-123");
  });
});
