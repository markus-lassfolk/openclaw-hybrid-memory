/**
 * Curation actions: call a GraphQL mutation and optimistically apply the change to the store. The
 * live SSE echo also delivers the same change (idempotent by id), so the graph stays correct whether
 * or not the subscription is connected. All actions surface a friendly auth message when the
 * dashboard token is missing.
 */
import { GraphQLAuthError } from "../api/client";
import * as q from "../api/queries";
import { estimateStrength } from "../api/strength";
import { useGraphStore } from "../store/graphStore";

export interface Result {
  ok: boolean;
  error?: string;
}

function toError(e: unknown): string {
  if (e instanceof GraphQLAuthError) return "A dashboard token is required for this action.";
  return e instanceof Error ? e.message : String(e);
}

export async function addFact(input: {
  text: string;
  category?: string;
  importance?: number;
  tags?: string[];
}): Promise<Result> {
  try {
    const { id } = await q.createFact(input);
    const store = useGraphStore.getState();
    store.upsertNode({
      id,
      label: input.text.length > 50 ? `${input.text.slice(0, 50)}…` : input.text,
      category: input.category ?? "fact",
      importance: input.importance ?? 0.5,
      confidence: 1,
      decayClass: "stable",
      strength: estimateStrength({ importance: input.importance ?? 0.5, confidence: 1, textLength: input.text.length }),
      tags: input.tags ?? [],
      degree: 0,
    });
    store.addActivity("store", input.text.slice(0, 40));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function editFactText(id: string, text: string): Promise<Result> {
  try {
    await q.updateFactText(id, text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function removeFact(id: string): Promise<Result> {
  try {
    const ok = await q.deleteFact(id);
    if (ok) useGraphStore.getState().removeNode(id);
    return { ok };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function setPinned(id: string, pinned: boolean): Promise<Result> {
  try {
    if (pinned) await q.pinFact(id, "pinned from graph");
    else await q.unpinFact(id);
    const store = useGraphStore.getState();
    const node = store.nodeIndex.get(id);
    if (node) store.upsertNode({ ...node, pinned });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function addLink(sourceId: string, targetId: string, linkType: string, weight: number): Promise<Result> {
  try {
    const link = await q.createLink(sourceId, targetId, linkType, weight);
    useGraphStore.getState().upsertEdge({
      id: link.id,
      source: link.sourceId,
      target: link.targetId,
      linkType: link.linkType,
      weight: link.weight,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function changeLink(id: string, linkType?: string, weight?: number): Promise<Result> {
  try {
    await q.updateLink(id, linkType, weight);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function removeLink(id: string): Promise<Result> {
  try {
    const ok = await q.deleteLink(id);
    if (ok) useGraphStore.getState().removeEdgeById(id);
    return { ok };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function acceptSuggested(sourceId: string, targetId: string): Promise<Result> {
  try {
    const link = await q.acceptSuggestedLink(sourceId, targetId);
    useGraphStore.getState().upsertEdge({
      id: link.id,
      source: link.sourceId,
      target: link.targetId,
      linkType: link.linkType,
      weight: link.weight,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}
