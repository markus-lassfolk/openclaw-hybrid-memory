/**
 * Workboard Gateway RPC client — communicates with OpenClaw's Workboard plugin
 * via HTTP Gateway RPC calls, with CLI fallback on OpenClaw 6.8+ hosts.
 *
 * Uses the `workboard.cards.*` RPC namespace. Designed for easy migration to
 * a direct plugin-to-plugin API if that becomes available.
 */

import { spawnSync } from "node:child_process";

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

function normalizeWorkboardCardsResult(result: unknown): WorkboardRpcCard[] {
  if (Array.isArray(result)) return result as WorkboardRpcCard[];
  if (typeof result === "object" && result !== null) {
    const obj = result as { cards?: WorkboardRpcCard[]; result?: { cards?: WorkboardRpcCard[] } };
    if (Array.isArray(obj.cards)) return obj.cards;
    if (obj.result && Array.isArray(obj.result.cards)) return obj.result.cards;
  }
  return [];
}

function normalizeWorkboardCardResult(result: unknown): WorkboardRpcCard | null {
  if (typeof result !== "object" || result === null) return null;
  const obj = result as WorkboardRpcCard & { result?: WorkboardRpcCard };
  if (typeof obj.id === "string") return obj;
  if (obj.result && typeof obj.result.id === "string") return obj.result;
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
      const params: Record<string, unknown> = {};
      if (opts?.tag) params.tag = opts.tag;
      if (opts?.column) params.column = opts.column;
      const result = await rpc<{ cards: WorkboardRpcCard[] }>("workboard.cards.list", params);
      return result?.cards ?? [];
    },

    async createCard(card) {
      return rpc<WorkboardRpcCard>("workboard.cards.create", card);
    },

    async updateCard(cardId, patch) {
      return rpc<WorkboardRpcCard>("workboard.cards.update", { id: cardId, ...patch });
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

function runWorkboardGatewayCliCall(method: string, params: Record<string, unknown>, token?: string): unknown | null {
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
  if (token) args.push("--token", token);

  try {
    const result = spawnSync("openclaw", args, {
      encoding: "utf-8",
      env: process.env,
      timeout: REQUEST_TIMEOUT_MS + 2000,
    });
    if (result.error || result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      pluginLogger.warn(
        `memory-hybrid: workboard gateway call ${method} failed${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      return null;
    }
    const stdout = result.stdout.trim();
    if (!stdout) return null;
    return JSON.parse(stdout) as unknown;
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
      if (opts?.tag) params.tag = opts.tag;
      if (opts?.column) params.column = opts.column;
      const result = await rpc("workboard.cards.list", params);
      return normalizeWorkboardCardsResult(result);
    },

    async createCard(card) {
      const result = await rpc("workboard.cards.create", card);
      return normalizeWorkboardCardResult(result);
    },

    async updateCard(cardId, patch) {
      const result = await rpc("workboard.cards.update", { id: cardId, ...patch });
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
      const result = runWorkboardGatewayCliCall("workboard.cards.list", {}, token);
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
    activeClient = httpClient;
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
