// Mock data for OpenClaw Memory Dashboard

export const CATEGORY_COLORS: Record<string, string> = {
  technical: "#3b82f6",
  fact: "#6b7280",
  project: "#8b5cf6",
  rule: "#f59e0b",
  preference: "#ec4899",
  decision: "#10b981",
  entity: "#06b6d4",
  place: "#f97316",
  pattern: "#6366f1",
  person: "#f43f5e",
  monitoring: "#eab308",
  other: "#64748b",
};

const now = Date.now() / 1000;
const day = 86400;

export const mockFacts = [
  { id: "a1b2c3d4", text: "System event hardening deployed 2026-03-09: config patched with tools.exec.notifyOnExit", category: "technical", importance: 0.95, entity: "system-event-hardening", key: null, value: null, tags: "system-events,gateway,reliability", tier: "warm", decay_class: "stable", scope: "global", confidence: 0.95, created_at: now - 1 * day, recall_count: 12 },
  { id: "e5f6g7h8", text: "Markus prefers posh British, slightly sarcastic tone", category: "preference", importance: 0.85, entity: "Markus", key: null, value: null, tags: "communication,tone", tier: "warm", decay_class: "permanent", scope: "user", confidence: 0.9, created_at: now - 22 * day, recall_count: 45 },
  { id: "i9j0k1l2", text: "Villa Polly smart home uses HA, Zigbee, Hue, Plejd, Apollo sensors", category: "place", importance: 0.8, entity: "Villa Polly", key: null, value: null, tags: "smart-home,home-assistant", tier: "warm", decay_class: "permanent", scope: "global", confidence: 0.88, created_at: now - 36 * day, recall_count: 23 },
  { id: "m3n4o5p6", text: "PR #272 council review round 2 completed: all 3 reviewers confirmed 6/6 requirements MET", category: "project", importance: 0.9, entity: "PR #272", key: null, value: null, tags: "pr-272,council-review", tier: "warm", decay_class: "active", scope: "global", confidence: 0.98, created_at: now - 1.1 * day, recall_count: 8 },
  { id: "q7r8s9t0", text: "Keep exec+PTY for Forge/Claude Code rather than switching to sessions_spawn", category: "decision", importance: 0.9, entity: null, key: null, value: null, tags: "forge,reliability,architecture", tier: "warm", decay_class: "stable", scope: "global", confidence: 0.92, created_at: now - 1.2 * day, recall_count: 15 },
  { id: "f1a2b3c4", text: "Gateway uses port 3001 for WebSocket connections", category: "technical", importance: 0.7, entity: "Gateway", key: "port", value: "3001", tags: "gateway,networking", tier: "warm", decay_class: "stable", scope: "global", confidence: 0.99, created_at: now - 5 * day, recall_count: 32 },
  { id: "d5e6f7g8", text: "MCP server restart required after config changes", category: "rule", importance: 0.75, entity: "MCP", key: null, value: null, tags: "mcp,operations", tier: "warm", decay_class: "permanent", scope: "global", confidence: 0.85, created_at: now - 10 * day, recall_count: 18 },
  { id: "h9i0j1k2", text: "Claude 3.5 Sonnet costs $3/MTok input, $15/MTok output", category: "fact", importance: 0.6, entity: "Claude", key: null, value: null, tags: "pricing,llm", tier: "warm", decay_class: "stable", scope: "global", confidence: 0.95, created_at: now - 15 * day, recall_count: 7 },
  { id: "l3m4n5o6", text: "Markus's timezone is Europe/Stockholm (CET/CEST)", category: "person", importance: 0.7, entity: "Markus", key: "timezone", value: "Europe/Stockholm", tags: "personal,scheduling", tier: "warm", decay_class: "permanent", scope: "user", confidence: 0.99, created_at: now - 30 * day, recall_count: 55 },
  { id: "p7q8r9s0", text: "Pattern: tool failures often cascade when Gateway is under memory pressure", category: "pattern", importance: 0.85, entity: "Gateway", key: null, value: null, tags: "reliability,patterns", tier: "warm", decay_class: "stable", scope: "global", confidence: 0.78, created_at: now - 3 * day, recall_count: 4 },
  { id: "t1u2v3w4", text: "Session cleanup runs at 03:00 UTC nightly", category: "monitoring", importance: 0.5, entity: null, key: null, value: null, tags: "cron,maintenance", tier: "warm", decay_class: "stable", scope: "global", confidence: 0.9, created_at: now - 7 * day, recall_count: 2 },
  { id: "x5y6z7a8", text: "OpenClaw architecture follows hub-and-spoke model with Gateway as central coordinator", category: "technical", importance: 0.95, entity: "OpenClaw", key: null, value: null, tags: "architecture,design", tier: "warm", decay_class: "permanent", scope: "global", confidence: 0.97, created_at: now - 45 * day, recall_count: 67 },
];

export const mockStats = {
  totalFacts: 7493,
  activeFacts: 7493,
  categories: 12,
  links: 44172,
  avgImportance: 0.72,
  lastFactAt: now - 0.5 * day,
  openIssues: 3,
  costThisMonth: 47.82,
  byCategory: [
    { category: "technical", count: 2429 },
    { category: "fact", count: 2010 },
    { category: "project", count: 709 },
    { category: "rule", count: 622 },
    { category: "preference", count: 461 },
    { category: "decision", count: 391 },
    { category: "entity", count: 245 },
    { category: "place", count: 230 },
    { category: "pattern", count: 224 },
    { category: "person", count: 132 },
    { category: "monitoring", count: 39 },
    { category: "other", count: 1 },
  ],
  byTier: [
    { tier: "warm", count: 7101 },
    { tier: "cold", count: 392 },
  ],
  byDecayClass: [
    { decay_class: "stable", count: 5374 },
    { decay_class: "permanent", count: 1193 },
    { decay_class: "session", count: 701 },
    { decay_class: "active", count: 225 },
  ],
};

export const mockIssues = [
  {
    id: "iss-001",
    title: "Forge completion events silently dropped",
    status: "diagnosed",
    severity: "high",
    symptoms: [
      "Claude Code ignores shell commands after task completion",
      "notifyOnExit event not visible for tidal-forest session",
      "Cron safety net reports disabled but event was delivered",
    ],
    root_cause: "Three-layer failure: CC behavioral issue, possible event consumption during compaction, cron run status misreports heartbeat skip as disabled",
    fix: null,
    rollback: null,
    tags: ["forge", "system-events", "reliability"],
    detected_at: now - 2 * day,
    resolved_at: null,
    verified_at: null,
  },
  {
    id: "iss-002",
    title: "Gemini subagent stalls without timeout",
    status: "resolved",
    severity: "medium",
    symptoms: ["Scholar ran 38 minutes with no output after mkdir", "No timeout mechanism for model stalls"],
    root_cause: "Gemini API model stall",
    fix: "Use runTimeoutSeconds on sessions_spawn",
    rollback: null,
    tags: ["gemini", "subagent"],
    detected_at: now - 5 * day,
    resolved_at: now - 3 * day,
    verified_at: null,
  },
  {
    id: "iss-003",
    title: "Memory compaction drops low-importance facts prematurely",
    status: "open",
    severity: "medium",
    symptoms: ["Facts with importance > 0.5 occasionally missing after nightly cycle", "Recall count reset on compacted facts"],
    root_cause: null,
    fix: null,
    rollback: null,
    tags: ["memory", "compaction", "data-loss"],
    detected_at: now - 1 * day,
    resolved_at: null,
    verified_at: null,
  },
  {
    id: "iss-004",
    title: "Cost tracking misattributes reflection calls",
    status: "open",
    severity: "low",
    symptoms: ["Reflection feature costs shown under 'auto-classify'"],
    root_cause: null,
    fix: null,
    rollback: null,
    tags: ["cost", "tracking"],
    detected_at: now - 0.5 * day,
    resolved_at: null,
    verified_at: null,
  },
];

export const mockGraphData = (() => {
  const categories = Object.keys(CATEGORY_COLORS);
  const nodes = Array.from({ length: 100 }, (_, i) => ({
    id: `node-${i}`,
    text: mockFacts[i % mockFacts.length].text.slice(0, 60) + (i > 11 ? ` (${i})` : ""),
    category: categories[i % categories.length],
    entity: i % 5 === 0 ? "OpenClaw" : i % 7 === 0 ? "Gateway" : i % 11 === 0 ? "Markus" : null,
    importance: 0.3 + Math.random() * 0.7,
  }));
  const edges: { source: string; target: string; link_type: string; strength: number }[] = [];
  for (let i = 0; i < 250; i++) {
    const s = Math.floor(Math.random() * 100);
    let t = Math.floor(Math.random() * 100);
    if (t === s) t = (t + 1) % 100;
    edges.push({
      source: `node-${s}`,
      target: `node-${t}`,
      link_type: "RELATED_TO",
      strength: 0.2 + Math.random() * 0.8,
    });
  }
  return { nodes, edges };
})();

export const mockClusters: any[] = [];

export const mockCostData = (() => {
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.now() - (29 - i) * day * 1000);
    return {
      date: date.toISOString().split("T")[0],
      cost: +(0.8 + Math.random() * 2.5).toFixed(2),
      tokens_in: Math.floor(50000 + Math.random() * 150000),
      tokens_out: Math.floor(10000 + Math.random() * 50000),
    };
  });
  return {
    daily,
    byModel: [
      { model: "claude-3.5-sonnet", cost: 28.45, calls: 1240 },
      { model: "claude-3-haiku", cost: 8.12, calls: 3420 },
      { model: "gemini-2.0-flash", cost: 6.80, calls: 890 },
      { model: "gpt-4o-mini", cost: 4.45, calls: 2100 },
    ],
    byFeature: [
      { feature: "Auto Recall", cost: 15.20, calls: 2800 },
      { feature: "Auto Classify", cost: 10.50, calls: 1900 },
      { feature: "Distill", cost: 8.30, calls: 420 },
      { feature: "Reflection", cost: 7.10, calls: 380 },
      { feature: "Extraction", cost: 6.72, calls: 1150 },
    ],
    summary: {
      totalMonth: 47.82,
      totalToday: 1.94,
      avgDaily: 1.59,
      topModel: "claude-3.5-sonnet",
    },
  };
})();

export const mockConfig = {
  features: [
    { name: "Hybrid Memory", enabled: true, description: "Core hybrid memory system combining vector search and structured storage" },
    { name: "Auto Capture", enabled: true, description: "Automatically extract and store facts from conversations" },
    { name: "Auto Recall", enabled: true, description: "Automatically retrieve relevant memories during conversations" },
    { name: "Auto Classify", enabled: true, description: "Categorize facts into semantic categories automatically" },
    { name: "Distill", enabled: true, description: "Summarize and compress related facts to reduce redundancy" },
    { name: "Reflection", enabled: true, description: "Periodic self-analysis to identify patterns and insights" },
    { name: "Self-Correction", enabled: true, description: "Detect and fix contradictions or outdated information" },
    { name: "Passive Observer", enabled: false, description: "Monitor tool usage patterns without active intervention" },
    { name: "Nightly Cycle", enabled: true, description: "Run maintenance tasks during low-activity hours" },
    { name: "Extraction Passes", enabled: true, description: "Multi-pass extraction for thorough fact capture" },
    { name: "Self Extension", enabled: false, description: "Allow the memory system to create new categories and schemas" },
    { name: "Crystallization", enabled: true, description: "Convert frequently-accessed facts into permanent knowledge" },
    { name: "Language Keywords", enabled: true, description: "Extract and index keywords for improved search" },
    { name: "Credentials Store", enabled: true, description: "Securely store and recall API keys and tokens" },
    { name: "Error Reporting", enabled: true, description: "Track and report errors to the issue system" },
  ],
};

export const mockWorkflows = [
  { goal: "Fix failing test suite", tool_sequence: ["read_file", "exec", "edit_file", "exec"], outcome: "success", tool_count: 4, duration_ms: 45000, created_at: now - 2 * day },
  { goal: "Deploy configuration change", tool_sequence: ["read_file", "edit_file", "exec", "mcp_restart"], outcome: "success", tool_count: 4, duration_ms: 32000, created_at: now - 3 * day },
  { goal: "Investigate memory leak", tool_sequence: ["exec", "read_file", "exec", "read_file", "exec"], outcome: "success", tool_count: 5, duration_ms: 120000, created_at: now - 4 * day },
  { goal: "Create new MCP tool", tool_sequence: ["read_file", "write_file", "exec", "edit_file", "exec"], outcome: "success", tool_count: 5, duration_ms: 85000, created_at: now - 5 * day },
  { goal: "Update dependencies", tool_sequence: ["exec", "edit_file", "exec"], outcome: "failure", tool_count: 3, duration_ms: 60000, created_at: now - 6 * day },
  { goal: "Debug API timeout", tool_sequence: ["exec", "read_file", "exec", "edit_file", "mcp_restart", "exec"], outcome: "success", tool_count: 6, duration_ms: 180000, created_at: now - 7 * day },
  { goal: "Refactor auth module", tool_sequence: ["read_file", "read_file", "edit_file", "edit_file", "exec"], outcome: "success", tool_count: 5, duration_ms: 95000, created_at: now - 8 * day },
  { goal: "Set up monitoring alerts", tool_sequence: ["read_file", "write_file", "exec"], outcome: "unknown", tool_count: 3, duration_ms: 28000, created_at: now - 9 * day },
];
