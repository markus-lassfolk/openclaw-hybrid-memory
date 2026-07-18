/** Agent Runway API — compact preflight context (Issue #2145), front door to the Loom. */

export interface RunwayActiveTaskSummary {
  label: string;
  status: string;
  next: string | null;
  updated: string;
  relatedGoal: string | null;
  source: "facts_ledger" | "projection";
}

export interface RunwayGoalSummary {
  id: string;
  label: string;
  status: string;
  priority: string;
  currentBlockers: string[];
}

export interface RunwayIncidentSummary {
  id: string;
  summary: string;
  occurredAt: string;
}

export interface RunwayCorrectionSummary {
  id: string;
  summary: string;
  occurredAt: string;
}

export interface RunwayFragileSurface {
  name: string;
  risk: string;
  recommendedProcedureId?: string;
}

export interface RunwayLoomSummary {
  topClaims: Array<{ id: string; entity: string; predicate: string; value: string; status: string }>;
  mustLiveCheck: Array<{ claimId: string; text: string }>;
  openLoops: Array<{ id: string; title: string; status: string }>;
  driftWarnings: Array<{ id: string; oldText: string; severity: string }>;
  recommendedProcedures: Array<{ clusterId: string; why: string }>;
  attentionTop: Array<{ targetKind: string; targetId: string; title: string; category: string }>;
}

export interface RunwayOptions {
  agent?: string;
  scope?: string;
  sinceHours?: number;
}

export interface RunwayBundle {
  generatedAt: string;
  agent: string | null;
  activeTasks: RunwayActiveTaskSummary[];
  goals: RunwayGoalSummary[];
  recentIncidents: RunwayIncidentSummary[];
  corrections: RunwayCorrectionSummary[];
  fragileSurfaces: RunwayFragileSurface[];
  warnings: string[];
  loom: RunwayLoomSummary;
}
