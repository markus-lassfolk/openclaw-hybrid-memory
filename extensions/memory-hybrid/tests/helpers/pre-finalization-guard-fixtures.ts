import type { MemoryEntry } from "../../types/memory.js";

export const NOW_ISO = "2026-05-10T08:31:00.000Z";
export const NOW_MS = Date.parse(NOW_ISO);

export function projectFact(params: {
  id: string;
  entity: string;
  key: string;
  value: string;
  createdAt?: number;
}): MemoryEntry {
  return {
    id: params.id,
    text: `Task [${params.entity}] ${params.key}: ${params.value}`,
    category: "project",
    importance: 0.7,
    entity: params.entity,
    key: params.key,
    value: params.value,
    source: "test",
    createdAt: params.createdAt ?? Math.floor(NOW_MS / 1000),
    decayClass: "permanent",
    expiresAt: null,
    lastConfirmedAt: Math.floor(NOW_MS / 1000),
    confidence: 1,
  };
}
