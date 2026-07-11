/**
 * Thin GraphQL client for the Memory Graph app.
 *
 * Queries/mutations go over POST /graphql (same-origin — the dashboard server serves both the app
 * and the API). Subscriptions use graphql-sse over the same endpoint (Yoga's native SSE transport;
 * there is no WebSocket server). The optional dashboard token (required only for mutations when
 * `dashboard.token` is configured) is attached as a Bearer header and persisted in localStorage.
 */
import { createClient, type Client as SseClient } from "graphql-sse";

const GRAPHQL_URL = "/graphql";
const TOKEN_KEY = "memoryGraph.dashboardToken";

export class GraphQLAuthError extends Error {
  constructor() {
    super("Unauthorized: a dashboard token is required for this action.");
    this.name = "GraphQLAuthError";
  }
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
  // Deliberately do NOT dispose the SSE client here. Subscriptions are unauthenticated reads, so a
  // token change doesn't affect them — but disposing would tear down the already-registered live
  // subscriptions with nothing to re-create them, silently killing the live overlay for the rest of
  // the session. Mutations pick up the new token per-request via authHeaders() in gqlRequest.
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Run a GraphQL query or mutation. Throws GraphQLAuthError on 401, Error on GraphQL errors. */
export async function gqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) throw new GraphQLAuthError();
  // A non-2xx that isn't 401 is usually a server/proxy error page (HTML), so don't try to parse it
  // as GraphQL JSON — that would surface a cryptic "Unexpected token <" instead of the real status.
  if (!res.ok) throw new Error(`Server error (${res.status} ${res.statusText})`);
  let json: { data?: T; errors?: Array<{ message: string }> };
  try {
    json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  } catch {
    throw new Error("Server returned a non-JSON response");
  }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  if (!json.data) throw new Error("Empty GraphQL response");
  return json.data;
}

let sseClient: SseClient | null = null;

function getSseClient(): SseClient {
  if (!sseClient) {
    sseClient = createClient({ url: GRAPHQL_URL, headers: authHeaders });
  }
  return sseClient;
}

/**
 * Subscribe to a GraphQL subscription over SSE. Returns an unsubscribe function.
 * `onData` receives the `data` field of each event; errors are routed to `onError`.
 */
export function gqlSubscribe<T>(
  query: string,
  handlers: { onData: (data: T) => void; onError?: (err: unknown) => void },
  variables?: Record<string, unknown>,
): () => void {
  return getSseClient().subscribe<{ [k: string]: unknown }>(
    { query, variables },
    {
      next: (value) => {
        if (value.data) handlers.onData(value.data as T);
      },
      error: (err) => handlers.onError?.(err),
      complete: () => {},
    },
  );
}

/** Does the server require a token for mutations? (GET /api/graph-app/config) */
export async function fetchRequiresToken(): Promise<boolean> {
  try {
    const res = await fetch("/api/graph-app/config");
    if (!res.ok) return false;
    const json = (await res.json()) as { requiresToken?: boolean };
    return Boolean(json.requiresToken);
  } catch {
    return false;
  }
}
