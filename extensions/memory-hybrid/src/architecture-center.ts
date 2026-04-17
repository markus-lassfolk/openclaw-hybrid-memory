export interface ArchitectureArea {
	name: string;
	ownership: readonly string[];
	rationale: string;
}

export interface ArchitectureDecisionRule {
	prompt: string;
	classification: "core runtime" | "adjacent subsystem";
}

export const ARCHITECTURE_CENTER = {
	decision: [
		"capture durable memory from live interaction",
		"persist memory across multiple stores with explicit consistency semantics",
		"retrieve and inject relevant memory into active turns",
		"expose a minimal, stable memory tool/lifecycle API",
		"preserve provenance/trust signals required for safe memory behavior",
	],
	coreRuntime: [
		{
			name: "Plugin runtime boundary and context",
			ownership: [
				"extensions/memory-hybrid/index.ts",
				"extensions/memory-hybrid/api/plugin-runtime.ts",
				"extensions/memory-hybrid/api/memory-plugin-api.ts",
				"extensions/memory-hybrid/setup/plugin-service.ts",
			],
			rationale: "Defines lifecycle, wiring, and runtime invariants",
		},
		{
			name: "Storage core (facts + vectors + WAL)",
			ownership: [
				"extensions/memory-hybrid/backends/facts-db.ts",
				"extensions/memory-hybrid/backends/vector-db.ts",
				"extensions/memory-hybrid/backends/wal.ts",
				"extensions/memory-hybrid/services/wal-helpers.ts",
				"extensions/memory-hybrid/utils/wal-replay.ts",
			],
			rationale: "Durable write/read path and crash consistency",
		},
		{
			name: "Retrieval core and orchestration",
			ownership: [
				"extensions/memory-hybrid/services/retrieval-orchestrator.ts",
				"extensions/memory-hybrid/services/recall-pipeline.ts",
				"extensions/memory-hybrid/services/vector-search.ts",
				"extensions/memory-hybrid/services/fts-search.ts",
				"extensions/memory-hybrid/services/rrf-fusion.ts",
				"extensions/memory-hybrid/services/reranker.ts",
			],
			rationale: "Determines memory relevance and recall quality",
		},
		{
			name: "Lifecycle integration",
			ownership: [
				"extensions/memory-hybrid/setup/register-hooks.ts",
				"extensions/memory-hybrid/lifecycle/hooks.ts",
				"extensions/memory-hybrid/lifecycle/stage-capture.ts",
				"extensions/memory-hybrid/lifecycle/stage-recall.ts",
				"extensions/memory-hybrid/lifecycle/stage-injection.ts",
			],
			rationale: "Connects memory runtime to agent turn flow",
		},
		{
			name: "Primary memory tool API surface",
			ownership: [
				"extensions/memory-hybrid/setup/register-tools.ts",
				"extensions/memory-hybrid/tools/memory-tools.ts",
			],
			rationale: "Stable external contract for memory operations",
		},
		{
			name: "Core trust/provenance seams",
			ownership: [
				"extensions/memory-hybrid/services/provenance.ts",
				"extensions/memory-hybrid/tools/provenance-tools.ts",
				"extensions/memory-hybrid/backends/event-log.ts",
			],
			rationale: "Supports explainability and auditability for memory behavior",
		},
		{
			name: "Core config/types",
			ownership: [
				"extensions/memory-hybrid/config.ts",
				"extensions/memory-hybrid/config/",
				"extensions/memory-hybrid/types/memory.ts",
			],
			rationale: "Runtime behavior policy and compatibility surface",
		},
	] satisfies readonly ArchitectureArea[],
	adjacentSubsystems: [
		{
			name: "Dashboard and HTTP routes",
			ownership: [
				"extensions/memory-hybrid/routes/dashboard-server.ts",
				"extensions/memory-hybrid/tools/dashboard-routes.ts",
			],
			rationale: "Adjacent observability/UI surface",
		},
		{
			name: "Workflow mining and pattern tracking",
			ownership: [
				"extensions/memory-hybrid/backends/workflow-store.ts",
				"extensions/memory-hybrid/services/workflow-tracker.ts",
				"extensions/memory-hybrid/tools/workflow-tools.ts",
			],
			rationale: "Adjacent learning/analytics layer",
		},
		{
			name: "Issue tracking",
			ownership: [
				"extensions/memory-hybrid/backends/issue-store.ts",
				"extensions/memory-hybrid/tools/issue-tools.ts",
			],
			rationale: "Adjacent operational state",
		},
		{
			name: "Crystallization and self-extension",
			ownership: [
				"extensions/memory-hybrid/backends/crystallization-store.ts",
				"extensions/memory-hybrid/backends/tool-proposal-store.ts",
				"extensions/memory-hybrid/services/crystallization-proposer.ts",
				"extensions/memory-hybrid/services/skill-crystallizer.ts",
				"extensions/memory-hybrid/services/tool-proposer.ts",
				"extensions/memory-hybrid/tools/crystallization-tools.ts",
				"extensions/memory-hybrid/tools/self-extension-tools.ts",
			],
			rationale: "Adjacent autonomy/optimization features",
		},
		{
			name: "ApiTap capture and tooling",
			ownership: [
				"extensions/memory-hybrid/backends/apitap-store.ts",
				"extensions/memory-hybrid/services/apitap-service.ts",
				"extensions/memory-hybrid/tools/apitap-tools.ts",
			],
			rationale: "Adjacent specialized ingestion",
		},
		{
			name: "Advanced maintenance/analysis utilities",
			ownership: [
				"extensions/memory-hybrid/services/reflection.ts",
				"extensions/memory-hybrid/services/monthly-review.ts",
				"extensions/memory-hybrid/services/continuous-verifier.ts",
				"extensions/memory-hybrid/tools/verification-tools.ts",
				"extensions/memory-hybrid/cli/cmd-verify.ts",
			],
			rationale: "Adjacent maintenance plane",
		},
		{
			name: "Optional document ingestion",
			ownership: [
				"extensions/memory-hybrid/tools/document-tools.ts",
				"extensions/memory-hybrid/services/document-chunker.ts",
				"extensions/memory-hybrid/services/python-bridge.ts",
			],
			rationale: "Adjacent opt-in ingestion pipeline",
		},
	] satisfies readonly ArchitectureArea[],
	classificationHeuristics: [
		{
			prompt:
				"If removed, would live turn-time capture, persistence, retrieval, injection, or provenance break?",
			classification: "core runtime",
		},
		{
			prompt:
				"Does it define a compatibility surface other features rely on, such as memory lifecycle hooks, storage semantics, or primary memory tools?",
			classification: "core runtime",
		},
		{
			prompt:
				"Can it be disabled or replaced without breaking the baseline memory runtime contract?",
			classification: "adjacent subsystem",
		},
		{
			prompt:
				"Is it mainly observability, specialized ingestion, maintenance, workflow mining, or self-optimization on top of core memory flows?",
			classification: "adjacent subsystem",
		},
	] satisfies readonly ArchitectureDecisionRule[],
	constraints: [
		"Multi-agent plugin first: This runtime is primarily an OpenClaw multi-agent memory plugin, not a generic hostile multi-tenant SaaS backend.",
		"Multiple stores are intentional: SQLite/FTS and LanceDB serve different retrieval modes; refactors must preserve this split and clarify consistency semantics rather than forcing naive consolidation.",
		"Consistency is explicit: Any write/read path spanning stores must define ordering, idempotency, replay, and failure behavior (WAL + replay + reconciliation).",
		"Interactive vs deep retrieval differ: Interactive turn-time recall prioritizes latency/predictability; deeper/offline retrieval can spend more latency/compute for completeness.",
		"Adjacent features must not back-drive core complexity: Optional subsystems may consume core interfaces, but core runtime contracts should not become shaped by any one adjacent feature.",
		"Core contracts are stable: Memory lifecycle hooks and primary memory tools are compatibility surfaces and should change conservatively.",
	],
	refactorGuardrails: [
		"Changes that touch core runtime files should avoid importing adjacent stores/services directly; prefer narrow interfaces passed through MemoryPluginAPI.",
		"If an adjacent subsystem requires core data, add adapter/seam code in setup wiring instead of expanding core module responsibilities.",
		"If a proposal removes a store, it must replace current retrieval/latency/quality semantics and document migration + rollback.",
	],
} as const;

export function allArchitectureOwnershipPaths(): string[] {
	return [
		...ARCHITECTURE_CENTER.coreRuntime,
		...ARCHITECTURE_CENTER.adjacentSubsystems,
	].flatMap((area) => area.ownership);
}
