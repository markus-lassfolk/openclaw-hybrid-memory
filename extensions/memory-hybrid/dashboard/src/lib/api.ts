// API layer — fetches from extension dashboard server at /api (same origin when served by hybrid-mem dashboard).
const API_BASE = typeof import.meta.env?.VITE_API_BASE === "string" ? import.meta.env.VITE_API_BASE : "";

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(API_BASE + path, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json() as Promise<T>;
}

export async function fetchStats() {
  return get<{
    totalFacts: number;
    activeFacts: number;
    categories: number;
    links: number;
    openIssues: number;
    costThisMonth: number;
    byCategory: Array<{ category: string; count: number }>;
    byTier: Array<{ tier: string; count: number }>;
    byDecayClass: Array<{ decay_class: string; count: number }>;
  }>("/api/stats");
}

export async function fetchFacts(params?: { limit?: number; offset?: number; category?: string; search?: string; tier?: string }) {
  const search: Record<string, string> = {};
  if (params?.limit != null) search.limit = String(params.limit);
  if (params?.offset != null) search.offset = String(params.offset);
  if (params?.category) search.category = params.category;
  if (params?.search) search.search = params.search;
  if (params?.tier) search.tier = params.tier;
  return get<{ facts: unknown[]; total: number }>("/api/facts", search);
}

export async function fetchFact(id: string) {
  return get<{ fact: unknown; links: unknown[] }>(`/api/facts/${encodeURIComponent(id)}`);
}

export async function fetchGraph(params?: { limit?: number; category?: string; entity?: string }) {
  const search: Record<string, string> = {};
  if (params?.limit != null) search.limit = String(params.limit);
  if (params?.category) search.category = params.category ?? "";
  if (params?.entity) search.entity = params.entity ?? "";
  return get<{ nodes: unknown[]; edges: unknown[] }>("/api/graph", search);
}

export async function fetchIssues(params?: { status?: string; severity?: string }) {
  const search: Record<string, string> = {};
  if (params?.status) search.status = params.status;
  if (params?.severity) search.severity = params.severity;
  return get<{ issues: unknown[] }>("/api/issues", search);
}

export async function fetchClusters() {
  return get<{ clusters: unknown[] }>("/api/clusters");
}

export async function fetchCost(range?: string) {
  return get<unknown>("/api/cost" + (range ? `?range=${encodeURIComponent(range)}` : ""));
}

export async function fetchConfig() {
  return get<{ features: Array<{ name: string; enabled: boolean; description: string }> }>("/api/config");
}

export async function fetchWorkflows() {
  return get<{ patterns: unknown[] }>("/api/workflows");
}
