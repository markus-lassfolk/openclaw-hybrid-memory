/**
 * Workboard Gateway RPC client — communicates with OpenClaw's Workboard plugin
 * via HTTP Gateway RPC calls.
 *
 * Uses the `workboard.cards.*` RPC namespace. Designed for easy migration to
 * a direct plugin-to-plugin API if that becomes available.
 */

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
