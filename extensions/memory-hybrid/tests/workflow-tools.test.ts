import { describe, expect, it, vi } from "vitest";
import { registerWorkflowTools } from "../tools/workflow-tools.js";

function makeMockApi() {
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<unknown> }
	>();
	return {
		registerTool(
			opts: Record<string, unknown>,
			_options?: Record<string, unknown>,
		) {
			tools.set(opts.name as string, {
				execute: opts.execute as (...args: unknown[]) => Promise<unknown>,
			});
		},
		callTool(name: string, params: Record<string, unknown>) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool.execute("test-call-id", params);
		},
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
}

describe("memory_workflows tool", () => {
	it("returns a soft error response when workflow DB is not open", async () => {
		const api = makeMockApi();
		const workflowStore = {
			getPatterns: vi.fn(() => {
				throw new TypeError("The database connection is not open");
			}),
		};

		registerWorkflowTools({ workflowStore: workflowStore as any }, api as any);

		const result = (await api.callTool("memory_workflows", {})) as {
			content: { type: string; text: string }[];
			details: unknown[];
		};

		expect(result.details).toEqual([]);
		expect(result.content[0].text).toContain("temporarily unavailable");
		expect(result.content[0].text).toContain("database not ready");
	});
});
