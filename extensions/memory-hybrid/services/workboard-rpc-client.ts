/**
 * Workboard Gateway RPC client — communicates with OpenClaw's Workboard plugin
 * via HTTP Gateway RPC calls, with CLI fallback on OpenClaw 6.8+ hosts.
 *
 * Uses the `workboard.cards.*` RPC namespace. Designed for easy migration to
 * a direct plugin-to-plugin API if that becomes available.
 */

import { spawn } from "../utils/process-runner.js";
import { pluginLogger } from "../utils/logger.js";

export type WorkboardRpcCard = {
  id: string;
  title: string;
  column: string;
  description?: string;
  tags?: string[];
  externalId?: string;
  metadata?: Record<string, string>;
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

const REQUEST_TIMEOUT_MS = 10_000;

type WorkboardApiCardRaw = {
  id: string;
  title: string;
  status?: string;
  column?: string;
  notes?: string;
  description?: string;
  labels?: string[];
  tags?: string[];
  externalId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

function extractWorkboardExternalId(raw: WorkboardApiCardRaw): string | undefined {
  if (typeof raw.idempotencyKey === "string" && raw.idempotencyKey) return raw.idempotencyKey;
  if (typeof raw.externalId === "string" && raw.externalId) return raw.externalId;
  const automation = raw.metadata?.automation;
  if (typeof automation === "object" && automation !== null) {
    const key = (automation as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof key === "string" && key) return key;
  }
  return undefined;
}

/** Map OpenClaw 6.8 Workboard API cards to hybrid-memory's internal card shape (#1927). */
export function normalizeWorkboardApiCard(raw: unknown): WorkboardRpcCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const card = raw as WorkboardApiCardRaw;
  if (typeof card.id !== "string" || typeof card.title !== "string") return null;

  const metadata: Record<string, string> | undefined =
    card.metadata && typeof card.metadata === "object"
      ? Object.fromEntries(
          Object.entries(card.metadata).flatMap(([key, value]) =>
            typeof value === "string" ? [[key, value]] : [],
          ),
        )
      : undefined;

  return {
    id: card.id,
    title: card.title,
    column: card.status ?? card.column ?? "",
    description: card.notes ?? card.description,
    tags: card.labels ?? card.tags,
    externalId: extractWorkboardExternalId(card),
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function toWorkboardApiListParams(opts?: { tag?: string; column?: string }): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (opts?.tag) params.label = opts.tag;
  if (opts?.column) params.status = opts.column;
  return params;
}

function toWorkboardApiCreateParams(card: {
  title: string;
  column: string;
  description?: string;
  tags?: string[];
  externalId?: string;
  metadata?: Record<string, string>;
}): Record<string, unknown> {
  const params: Record<string, unknown> = { title: card.title, status: card.column };
  if (card.description) params.notes = card.description;
  if (card.tags?.length) params.labels = card.tags;
  if (card.externalId) params.idempotencyKey = card.externalId;
  if (card.metadata) params.metadata = card.metadata;
  return params;
}

function toWorkboardApiUpdateParams(patch: {
  title?: string;
  column?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (patch.title !== undefined) params.title = patch.title;
  if (patch.column !== undefined) params.status = patch.column;
  if (patch.description !== undefined) params.notes = patch.description;
  if (patch.tags !== undefined) params.labels = patch.tags;
  if (patch.metadata !== undefined) params.metadata = patch.metadata;
  return params;
}

function normalizeWorkboardCardsResult(result: unknown): WorkboardRpcCard[] {
  let cards: unknown[] = [];
  if (Array.isArray(result)) {
    cards = result;
  } else if (typeof result === "object" && result !== null) {
    const obj = result as { cards?: unknown[]; result?: { cards?: unknown[] } };
    if (Array.isArray(obj.cards)) cards = obj.cards;
    else if (obj.result && Array.isArray(obj.result.cards)) cards = obj.result.cards;
  }
  return cards.map(normalizeWorkboardApiCard).filter((card): card is WorkboardRpcCard => card !== null);
}

function normalizeWorkboardCardResult(result: unknown): WorkboardRpcCard | null {
  if (typeof result !== "object" || result === null) return null;
  const obj = result as { card?: unknown; result?: unknown; id?: string };
  if (obj.card) return normalizeWorkboardApiCard(obj.card);
  if (typeof obj.id === "string") return normalizeWorkboardApiCard(obj);
  if (obj.result && typeof obj.result === "object" && obj.result !== null) {
    const inner = obj.result as { card?: unknown; id?: string };
    if (inner.card) return normalizeWorkboardApiCard(inner.card);
    if (typeof inner.id === "string") return normalizeWorkboardApiCard(inner);
  }
  return null;
}

function normalizeWorkboardDeleteResult(result: unknown): boolean {
  if (typeof result === "object" && result !== null) {
    const obj = result as { deleted?: boolean; result?: { deleted?: boolean } };
    if (typeof obj.deleted === "boolean") return obj.deleted;
    if (obj.result && typeof obj.result.deleted === "boolean") return obj.result.deleted;
  }
  return false;
}

export function createWorkboardHttpRpcClient(gatewayUrl: string, token?: string): WorkboardRpcClient {
  const baseUrl = gatewayUrl.replace(/\/+$/, "");

  async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
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

      const json = (await response.json()) as { result?: T; error?: string };
      if (json.error) {
        pluginLogger.warn(`memory-hybrid: workboard RPC ${method} error: ${json.error}`);
        return null;
      }

      return json.result ?? (json as unknown as T);
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
      const result = await rpc<unknown>("workboard.cards.list", toWorkboardApiListParams(opts));
      return normalizeWorkboardCardsResult(result);
    },

    async createCard(card) {
      const result = await rpc<unknown>("workboard.cards.create", toWorkboardApiCreateParams(card));
      return normalizeWorkboardCardResult(result);
    },

    async updateCard(cardId, patch) {
      const result = await rpc<unknown>("workboard.cards.update", {
        id: cardId,
        ...toWorkboardApiUpdateParams(patch),
      });
      return normalizeWorkboardCardResult(result);
    },

    async deleteCard(cardId) {
      const result = await rpc<{ deleted: boolean }>("workboard.cards.delete", { id: cardId });
      return result?.deleted ?? false;
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

function runWorkboardGatewayCliCall(
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

  return new Promise((resolve) => {
    try {
      const env = token ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: token } : process.env;
      const child = spawn("openclaw", args, { env });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (value: unknown | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        child.kill();
        pluginLogger.warn(`memory-hybrid: workboard gateway call ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`);
        finish(null);
      }, REQUEST_TIMEOUT_MS + 2000);

      child.stdout?.on("data", (chunk: string | Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: string | Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        pluginLogger.warn(
          `memory-hybrid: workboard gateway call ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        finish(null);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const detail = (stderr || stdout).trim();
          pluginLogger.warn(
            `memory-hybrid: workboard gateway call ${method} failed${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          );
          finish(null);
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          finish(null);
          return;
        }
        try {
          finish(JSON.parse(trimmed) as unknown);
        } catch (err) {
          pluginLogger.warn(
            `memory-hybrid: workboard gateway call ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          finish(null);
        }
      });
    } catch (err) {
      pluginLogger.warn(
        `memory-hybrid: workboard gateway call ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      resolve(null);
    }
  });
}

/** Gateway RPC via `openclaw gateway call` (OpenClaw 6.8+ when HTTP /rpc/* is unavailable). */
export function createWorkboardGatewayCliRpcClient(token?: string): WorkboardRpcClient {
  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
    return runWorkboardGatewayCliCall(method, params, token);
  }

  return {
    async listCards(opts) {
      const result = await rpc("workboard.cards.list", toWorkboardApiListParams(opts));
      return normalizeWorkboardCardsResult(result);
    },

    async createCard(card) {
      const result = await rpc("workboard.cards.create", toWorkboardApiCreateParams(card));
      return normalizeWorkboardCardResult(result);
    },

    async updateCard(cardId, patch) {
      const result = await rpc("workboard.cards.update", {
        id: cardId,
        ...toWorkboardApiUpdateParams(patch),
      });
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
      const result = await runWorkboardGatewayCliCall("workboard.cards.list", {}, token);
      return result != null;
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
