/**
 * Required / optional artifact checklist for full offline QA (run-all parity).
 * Used by verify-fixtures.ts and fetch manifest.
 */

export type FixtureTier = "required" | "recommended" | "optional" | "forbidden";

export type FixtureSpec = {
  id: string;
  tier: FixtureTier;
  /** Path relative to .offline-qa/raw/ */
  rawPath: string;
  /** Path relative to sandbox HOME (.offline-qa/sandbox/) */
  sandboxPath?: string;
  /** run-all steps that depend on this */
  usedBy: string[];
  notes?: string;
};

export const FIXTURE_SPECS: FixtureSpec[] = [
  {
    id: "facts-db",
    tier: "required",
    rawPath: "memory/facts.db",
    sandboxPath: ".openclaw/memory/facts.db",
    usedBy: ["all"],
    notes: "Core facts, scan cursors, procedures, patterns",
  },
  {
    id: "language-keywords",
    tier: "required",
    rawPath: "memory/.language-keywords.json",
    sandboxPath: ".openclaw/memory/.language-keywords.json",
    usedBy: ["extract-directives", "extract-reinforcement", "self-correction-run", "build-languages"],
  },
  {
    id: "adaptive-llm-limits",
    tier: "recommended",
    rawPath: "memory/.adaptive-llm-limits.json",
    sandboxPath: ".openclaw/memory/.adaptive-llm-limits.json",
    usedBy: ["distill", "reflect", "reflect-rules", "reflect-meta", "generate-proposals"],
  },
  {
    id: "lancedb",
    tier: "recommended",
    rawPath: "memory/lancedb",
    sandboxPath: ".openclaw/memory/lancedb",
    usedBy: ["prune", "distill", "extract-*", "reflect*"],
    notes: "Vector dedup/search fidelity; can rebuild locally but slow",
  },
  {
    id: "distill-last-run",
    tier: "optional",
    rawPath: "memory/.distill_last_run",
    sandboxPath: ".openclaw/memory/.distill_last_run",
    usedBy: ["distill"],
    notes: "Incremental distill watermark; omit for full rescan",
  },
  {
    id: "reflect-last-run",
    tier: "optional",
    rawPath: "memory/.reflect_last_run",
    sandboxPath: ".openclaw/memory/.reflect_last_run",
    usedBy: ["reflect"],
  },
  {
    id: "proposals-db",
    tier: "recommended",
    rawPath: "memory/proposals.db",
    sandboxPath: ".openclaw/memory/proposals.db",
    usedBy: ["generate-proposals"],
    notes: "Only if personaProposals.enabled",
  },
  {
    id: "identity-reflections-db",
    tier: "recommended",
    rawPath: "memory/identity-reflections.db",
    sandboxPath: ".openclaw/memory/identity-reflections.db",
    usedBy: ["reflect-identity", "generate-proposals"],
  },
  {
    id: "persona-state-db",
    tier: "optional",
    rawPath: "memory/persona-state.db",
    sandboxPath: ".openclaw/memory/persona-state.db",
    usedBy: ["generate-proposals"],
  },
  {
    id: "provenance-db",
    tier: "optional",
    rawPath: "memory/provenance.db",
    sandboxPath: ".openclaw/memory/provenance.db",
    usedBy: ["reflect*"],
    notes: "If provenance.enabled on Maeve",
  },
  {
    id: "edicts-db",
    tier: "optional",
    rawPath: "memory/edicts.db",
    sandboxPath: ".openclaw/memory/edicts.db",
    usedBy: ["prune"],
  },
  {
    id: "workspace-soul",
    tier: "required",
    rawPath: "workspace/SOUL.md",
    sandboxPath: ".openclaw/workspace/SOUL.md",
    usedBy: ["generate-proposals", "reflect-identity"],
  },
  {
    id: "workspace-identity",
    tier: "required",
    rawPath: "workspace/IDENTITY.md",
    sandboxPath: ".openclaw/workspace/IDENTITY.md",
    usedBy: ["generate-proposals"],
  },
  {
    id: "workspace-user",
    tier: "required",
    rawPath: "workspace/USER.md",
    sandboxPath: ".openclaw/workspace/USER.md",
    usedBy: ["generate-proposals"],
  },
  {
    id: "workspace-tools",
    tier: "recommended",
    rawPath: "workspace/TOOLS.md",
    sandboxPath: ".openclaw/workspace/TOOLS.md",
    usedBy: ["self-correction-run"],
  },
  {
    id: "workspace-agents",
    tier: "recommended",
    rawPath: "workspace/AGENTS.md",
    sandboxPath: ".openclaw/workspace/AGENTS.md",
    usedBy: ["self-correction-run"],
  },
  {
    id: "daily-logs",
    tier: "required",
    rawPath: "workspace/memory",
    sandboxPath: ".openclaw/workspace/memory",
    usedBy: ["extract-daily (source)"],
    notes: "Copied into memory/YYYY-MM-DD.md at setup for extract-daily CLI path",
  },
  {
    id: "daily-logs-memory-dir",
    tier: "required",
    rawPath: "memory/daily-logs",
    sandboxPath: ".openclaw/memory",
    usedBy: ["extract-daily"],
    notes: "YYYY-MM-DD.md files symlinked/copied here at setup",
  },
  {
    id: "sessions-main",
    tier: "required",
    rawPath: "sessions/main",
    sandboxPath: ".openclaw/agents/main/sessions",
    usedBy: ["distill", "extract-*", "self-correction-run"],
  },
  {
    id: "config-redacted",
    tier: "required",
    rawPath: "config/openclaw.redacted.json",
    sandboxPath: ".openclaw/openclaw.json",
    usedBy: ["all"],
  },
  {
    id: "credentials-db",
    tier: "forbidden",
    rawPath: "memory/credentials.db",
    usedBy: [],
    notes: "NEVER copy — secrets",
  },
  {
    id: "memory-wal",
    tier: "forbidden",
    rawPath: "memory/memory.wal",
    usedBy: [],
    notes: "NEVER copy — may contain pending credential writes",
  },
];

/** run-all step list for full QA coverage */
export const RUN_ALL_STEPS = [
  "backfill-decay",
  "prune",
  "compact",
  "distill (3 days)",
  "extract-daily (7 days)",
  "extract-directives (7 days)",
  "extract-reinforcement (7 days)",
  "extract-implicit (3 days)",
  "extract-procedures (7 days)",
  "generate-auto-skills",
  "reflect",
  "reflect-rules",
  "reflect-meta",
  "reflect-identity",
  "generate-proposals",
  "self-correction-run",
  "build-languages",
] as const;

/** Steps covered by run-offline-qa.ts maintenance-tasks phase (subset) */
export const OFFLINE_QA_SUBSET_STEPS = [
  "distill (3 days)",
  "extract-reinforcement (7 days)",
  "self-correction-run",
  "reflect",
] as const;
