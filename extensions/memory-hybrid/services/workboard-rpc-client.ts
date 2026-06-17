/**
 * Workboard Gateway RPC client — communicates with OpenClaw's Workboard plugin
 * via HTTP Gateway RPC calls, with CLI fallback on OpenClaw 6.8+ hosts.
 *
 * Uses the `workboard.cards.*` RPC namespace. Designed for easy migration to
 * a direct plugin-to-plugin API if that becomes available.
 */

import { spawn } from "../utils/process-runner.js";
import { pluginLogger } from "../utils/logger.js";
import { toWorkboardStatusSlug } from "./workboard-status-slugs.js";

export type WorkboardRpcCard = {
  id: string;
  title: string;
  column: string;
  description?: string;
  tags?: string[];
  externalId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export interface WorkboardRpcClient {
  listCards(opts?: { tag?: string; column?: string }): Promise<WorkboardRpcCard[]>;
  createCard(card: {
    title: string;
    column: string;
    description?: string;
    tags?: string[];
    externalId?: string;
    metadata?: Record<string, string>;
  }): Promise<WorkboardRpcCard | null>;
  updateCard(
    cardId: string,
    patch: {
      title?: string;
      column?: string;
      description?: string;
      tags?: string[];
      metadata?: Record<string, string>;
    },
  ): Promise<WorkboardRpcCard | null>;
  deleteCard(cardId: string): Promise<boolean>;
  findByExternalId(externalId: string): Promise<WorkboardRpcCard | null>;
  isAvailable(): Promise<boolean>;
}

const REQUEST_TIMEOUT_MS = 25_000;

type WorkboardApiCard = {
  id?: string;
  title?: string;
  status?: string;
  column?: string;
  notes?: string;
  description?: string;
  labels?: string[];
  tags?: string[];
  externalId?: string;
  metadata?: { automation?: { idempotencyKey?: string } } & Record<string, unknown>;
  createdAt?: number | string;
  updatedAt?: number | string;
};

function workboardApiExternalId(card: WorkboardApiCard): string | undefined {
  const key = card.metadata?.automation?.idempotencyKey;
  if (typeof key === "string" && key.length > 0) return key;
  if (typeof card.externalId === "string" && card.externalId.length > 0) return card.externalId;
  return undefined;
}

/** Map OpenClaw Workboard card JSON (status/labels/notes) to hybrid-memory RPC shape. */
export function normalizeWorkboardCardFromApi(raw: unknown): WorkboardRpcCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const api = raw as WorkboardApiCard;
  if (typeof api.id !== "string") return null;
  const column = typeof api.status === "string" ? api.status : typeof api.column === "string" ? api.column : "";
  const tags = Array.isArray(api.labels) ? api.labels : Array.isArray(api.tags) ? api.tags : undefined;
  const externalId = workboardApiExternalId(api);
  return {
    id: api.id,
    title: typeof api.title === "string" ? api.title : "",
    column,
    description: typeof api.notes === "string" ? api.notes : api.description,
    tags,
    externalId,
    metadata: api.metadata,
    createdAt: typeof api.createdAt === "number" ? String(api.createdAt) : api.createdAt,
    updatedAt: typeof api.updatedAt === "number" ? String(api.updatedAt) : api.updatedAt,
  };
}

function normalizeWorkboardCardsResult(result: unknown): WorkboardRpcCard[] {
  if (Array.isArray(result)) {
    return result.map((card) => normalizeWorkboardCardFromApi(card)).filter((c): c is WorkboardRpcCard => c != null);
  }
  if (typeof result === "object" && result !== null) {
    const obj = result as { cards?: unknown[]; result?: { cards?: unknown[] } };
    const rawCards = Array.isArray(obj.cards)
      ? obj.cards
      : obj.result && Array.isArray(obj.result.cards)
        ? obj.result.cards
        : [];
    return rawCards.map((card) => normalizeWorkboardCardFromApi(card)).filter((c): c is WorkboardRpcCard => c != null);
  }
  return [];
}

function normalizeWorkboardCardResult(result: unknown): WorkboardRpcCard | null {
  if (typeof result !== "object" || result === null) return null;
  const obj = result as { card?: unknown; result?: { card?: unknown; id?: string } };
  if (obj.card) return normalizeWorkboardCardFromApi(obj.card);
  if (obj.result && typeof obj.result === "object" && obj.result !== null) {
    const nested = obj.result as { card?: unknown; id?: string };
    if (nested.card) return normalizeWorkboardCardFromApi(nested.card);
    if (typeof nested.id === "string") return normalizeWorkboardCardFromApi(nested);
  }
  return normalizeWorkboardCardFromApi(obj);
}

function normalizeWorkboardDeleteResult(result: unknown): boolean {
  if (typeof result === "object" && result !== null) {
    const obj = result as { deleted?: boolean; result?: { deleted?: boolean } };
    if (typeof obj.deleted === "boolean") return obj.deleted;
    if (obj.result && typeof obj.result.deleted === "boolean") return obj.result.deleted;
  }
  return false;
}

function mapWorkboardCreateParams(card: {
  title: string;
  column: string;
  description?: string;
  tags?: string[];
  externalId?: string;
  metadata?: Record<string, string>;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    title: card.title,
    status: toWorkboardStatusSlug(card.column),
  };
  if (card.description) params.notes = card.description;
  if (card.tags?.length) params.labels = card.tags;
  if (card.externalId) params.idempotencyKey = card.externalId;
  if (card.metadata) params.metadata = card.metadata;
  return params;
}

function mapWorkboardUpdatePatch(patch: {
  title?: string;
  column?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.column !== undefined) out.status = toWorkboardStatusSlug(patch.column);
  if (patch.description !== undefined) out.notes = patch.description;
  if (patch.tags !== undefined) out.labels = patch.tags;
  if (patch.metadata !== undefined) out.metadata = patch.metadata;
  return out;
}

function filterCardsByTag(cards: WorkboardRpcCard[], tag?: string): WorkboardRpcCard[] {
  if (!tag) return cards;
  return cards.filter((c) => c.tags?.includes(tag));
}

export function createWorkboardHttpRpcClient(gatewayUrl: string, token?: string): WorkboardRpcClient {
  const baseUrl = gatewayUrl.replace(/\/+$/, "");

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
    const url = `${baseUrl}/rpc/${method}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        pluginLogger.warn(
          `memory-hybrid: workboard RPC ${method} returned ${response.status}: ${await response.text().catch(() => "")}`,
        );
        return null;
      }

      const json = (await response.json()) as { result?: unknown; error?: string };
      if (json.error) {
        pluginLogger.warn(`memory-hybrid: workboard RPC ${method} error: ${json.error}`);
        return null;
      }

      return json.result ?? json;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        pluginLogger.warn(`memory-hybrid: workboard RPC ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      } else {
        pluginLogger.warn(
          `memory-hybrid: workboard RPC ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  }

  return {
    async listCards(opts) {
      const params: Record<string, unknown> = {};
      if (opts?.column) params.status = toWorkboardStatusSlug(opts.column);
      if (opts?.tag) params.labels = [opts.tag];
      const result = await rpc("workboard.cards.list", params);
      return filterCardsByTag(normalizeWorkboardCardsResult(result), opts?.tag);
    },

    async createCard(card) {
      const result = await rpc("workboard.cards.create", mapWorkboardCreateParams(card));
      return normalizeWorkboardCardResult(result);
    },

    async updateCard(cardId, patch) {
      const result = await rpc("workboard.cards.update", { id: cardId, ...mapWorkboardUpdatePatch(patch) });
      return normalizeWorkboardCardResult(result);
    },

    async deleteCard(cardId) {
      const result = await rpc("workboard.cards.delete", { id: cardId });
      return normalizeWorkboardDeleteResult(result);
    },

    async findByExternalId(externalId) {
      const cards = await this.listCards();
      return cards.find((c) => c.externalId === externalId) ?? null;
    },

    async isAvailable() {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch(`${baseUrl}/rpc/workboard.cards.list`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

async function runWorkboardGatewayCliCall(
  method: string,
  params: Record<string, unknown>,
  token?: string,
): Promise<unknown | null> {
  const args = [
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
    "--timeout",
    String(REQUEST_TIMEOUT_MS),
  ];
  const env = token ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: token } : process.env;

  try {
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn("openclaw", args, { env });
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          pluginLogger.warn(
            `memory-hybrid: workboard gateway call ${method} timed out after ${REQUEST_TIMEOUT_MS + 5000}ms`,
          );
          child.kill("SIGTERM");
          resolve(null);
        }
      }, REQUEST_TIMEOUT_MS + 5000);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          pluginLogger.warn(`memory-hybrid: workboard gateway call ${method} failed: ${err.message}`);
          resolve(null);
        }
      });
      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (code !== 0) {
            const detail = (stderr || stdout).trim();
            pluginLogger.warn(
              `memory-hybrid: workboard gateway call ${method} failed${detail ? `: ${detail.slice(0, 200)}` : ""}`,
            );
            resolve(null);
            return;
          }
          const out = stdout.trim();
          if (out.startsWith("{") || out.startsWith("[")) {
            try {
              resolve(JSON.parse(out));
              return;
            } catch {
              /* fall through */
            }
          }
          if (!out) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        }
      });
    });
  } catch (err) {
    pluginLogger.warn(
      `memory-hybrid: workboard gateway call ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Gateway RPC via `openclaw gateway call` (OpenClaw 6.8+ when HTTP /rpc/* is unavailable). */
export function createWorkboardGatewayCliRpcClient(token?: string): WorkboardRpcClient {
  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
    return runWorkboardGatewayCliCall(method, params, token);
  }

  return {
    async listCards(opts) {
      const params: Record<string, unknown> = {};
      if (opts?.column) params.status = toWorkboardStatusSlug(opts.column);
      if (opts?.tag) params.labels = [opts.tag];
      const result = await rpc("workboard.cards.list", params);
      return filterCardsByTag(normalizeWorkboardCardsResult(result), opts?.tag);
    },

    async createCard(card) {
      const result = await rpc("workboard.cards.create", mapWorkboardCreateParams(card));
      return normalizeWorkboardCardResult(result);
    },

    async updateCard(cardId, patch) {
      const result = await rpc("workboard.cards.update", { id: cardId, ...mapWorkboardUpdatePatch(patch) });
      return normalizeWorkboardCardResult(result);
    },

    async deleteCard(cardId) {
      const result = await rpc("workboard.cards.delete", { id: cardId });
      return normalizeWorkboardDeleteResult(result);
    },

    async findByExternalId(externalId) {
      const cards = await this.listCards();
      return cards.find((c) => c.externalId === externalId) ?? null;
    },

    async isAvailable() {
      return (await runWorkboardGatewayCliCall("workboard.cards.list", {}, token)) != null;
    },
  };
}

/**
 * Workboard RPC client with HTTP probe first, then `openclaw gateway call` fallback (#1925).
 */
export function createWorkboardRpcClient(gatewayUrl: string, token?: string): WorkboardRpcClient {
  const httpClient = createWorkboardHttpRpcClient(gatewayUrl, token);
  const cliClient = createWorkboardGatewayCliRpcClient(token);
  let activeClient: WorkboardRpcClient | null = null;

  async function resolveClient(): Promise<WorkboardRpcClient> {
    if (activeClient) return activeClient;
    if (await httpClient.isAvailable()) {
      activeClient = httpClient;
      return httpClient;
    }
    if (await cliClient.isAvailable()) {
      activeClient = cliClient;
      return cliClient;
    }
    return httpClient;
  }

  return {
    async listCards(opts) {
      return (await resolveClient()).listCards(opts);
    },
    async createCard(card) {
      return (await resolveClient()).createCard(card);
    },
    async updateCard(cardId, patch) {
      return (await resolveClient()).updateCard(cardId, patch);
    },
    async deleteCard(cardId) {
      return (await resolveClient()).deleteCard(cardId);
    },
    async findByExternalId(externalId) {
      return (await resolveClient()).findByExternalId(externalId);
    },
    async isAvailable() {
      if (await httpClient.isAvailable()) return true;
      return cliClient.isAvailable();
    },
  };
}
