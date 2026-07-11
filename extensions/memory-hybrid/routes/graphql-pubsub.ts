import { createPubSub } from "graphql-yoga";

type FactSubscriptionPayload = { fact: unknown; category?: string; scope?: string };
type FactUpdatedPayload = { fact: unknown; factId?: string; category?: string };
type FactDeletedPayload = { id: string; category?: string; scope?: string; scopeTarget?: string | null };
type LinkCreatedPayload = { link: unknown; sourceId?: string; targetId?: string };
type StatsUpdatedPayload = { stats: unknown };
type RecallHit = { factId: string; score: number };
type RecallOccurredPayload = {
  query: string | null;
  source: string;
  sessionKey: string | null;
  agentId: string | null;
  occurredAt: number;
  hits: RecallHit[];
};

export const graphqlPubSub = createPubSub<{
  factCreated: [FactSubscriptionPayload];
  factUpdated: [FactUpdatedPayload];
  factDeleted: [FactDeletedPayload];
  linkCreated: [LinkCreatedPayload];
  linkUpdated: [LinkCreatedPayload];
  statsUpdated: [StatsUpdatedPayload];
  recallOccurred: [RecallOccurredPayload];
}>();

function recordValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function factCategory(fact: unknown, fallback?: string): string | undefined {
  return typeof recordValue(fact, "category") === "string" ? (recordValue(fact, "category") as string) : fallback;
}

function factScope(fact: unknown, fallback?: string): string | undefined {
  return typeof recordValue(fact, "scope") === "string" ? (recordValue(fact, "scope") as string) : fallback;
}

function factId(fact: unknown): string | undefined {
  return typeof recordValue(fact, "id") === "string" ? (recordValue(fact, "id") as string) : undefined;
}

function linkEndpoint(link: unknown, key: "sourceId" | "targetId", fallback?: string): string | undefined {
  const direct = recordValue(link, key);
  return typeof direct === "string" ? direct : fallback;
}

export function notifyGraphqlFactCreated(fact: unknown, category?: string, scope?: string): void {
  graphqlPubSub.publish("factCreated", {
    fact,
    category: category ?? factCategory(fact),
    scope: scope ?? factScope(fact),
  });
}

export function notifyGraphqlFactUpdated(fact: unknown): void {
  graphqlPubSub.publish("factUpdated", { fact, factId: factId(fact), category: factCategory(fact) });
}

export function notifyGraphqlFactDeleted(
  id: string,
  category?: string,
  scope?: string,
  scopeTarget?: string | null,
): void {
  graphqlPubSub.publish("factDeleted", { id, category, scope, scopeTarget });
}

export function notifyGraphqlLinkCreated(link: unknown): void {
  graphqlPubSub.publish("linkCreated", {
    link,
    sourceId: linkEndpoint(link, "sourceId"),
    targetId: linkEndpoint(link, "targetId"),
  });
}

export function notifyGraphqlLinkUpdated(link: unknown): void {
  graphqlPubSub.publish("linkUpdated", {
    link,
    sourceId: linkEndpoint(link, "sourceId"),
    targetId: linkEndpoint(link, "targetId"),
  });
}

export function notifyGraphqlStatsUpdated(stats: unknown): void {
  graphqlPubSub.publish("statsUpdated", { stats });
}

export function notifyGraphqlRecallOccurred(payload: RecallOccurredPayload): void {
  graphqlPubSub.publish("recallOccurred", payload);
}
