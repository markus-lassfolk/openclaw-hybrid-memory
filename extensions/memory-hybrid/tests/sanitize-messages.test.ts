import { describe, expect, it } from "vitest";
import {
	type MessageLike,
	sanitizeMessagesForClaude,
	sanitizeMessagesForOpenAIResponses,
} from "../utils/sanitize-messages.js";

describe("sanitizeMessagesForClaude", () => {
	it("returns same array when no assistant message has tool_use", () => {
		const messages: MessageLike[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: [{ type: "text", text: "Hi" }] },
		];
		const out = sanitizeMessagesForClaude(messages);
		expect(out).toBe(messages);
	});

	it("inserts tool_result for orphaned tool_use", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check" },
					{
						type: "tool_use",
						id: "t1",
						name: "memory_recall",
						input: { query: "test" },
					},
				],
			},
			{ role: "user", content: "Thanks" },
		];
		const out = sanitizeMessagesForClaude(messages);
		expect(out.length).toBe(3);
		expect(out[1].role).toBe("tool");
		const content = out[1].content as Array<{
			type: string;
			tool_use_id: string;
		}>;
		expect(content[0].type).toBe("tool_result");
		expect(content[0].tool_use_id).toBe("t1");
	});

	it("does not double-insert when tool_result already follows", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t1", name: "memory_recall", input: {} },
				],
			},
			{
				role: "tool",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "result" },
				],
			},
			{ role: "user", content: "ok" },
		];
		const out = sanitizeMessagesForClaude(messages);
		expect(out).toBe(messages);
	});

	it("handles multiple orphaned tool_use blocks in one message", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "a", name: "t1", input: {} },
					{ type: "tool_use", id: "b", name: "t2", input: {} },
				],
			},
			{ role: "user", content: "go" },
		];
		const out = sanitizeMessagesForClaude(messages);
		expect(out.length).toBe(3);
		expect(out[1].role).toBe("tool");
		const content = out[1].content as Array<{ tool_use_id: string }>;
		const toolResultIds = content.map((b) => b.tool_use_id).sort();
		expect(toolResultIds).toEqual(["a", "b"]);
	});

	it("leaves non-assistant messages unchanged", () => {
		const messages: MessageLike[] = [
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "orphan", name: "run", input: {} }],
			},
		];
		const out = sanitizeMessagesForClaude(messages);
		expect(out[0]).toBe(messages[0]);
		expect(out[1]).toBe(messages[1]);
		expect(out[2].role).toBe("tool");
	});
});

describe("sanitizeMessagesForOpenAIResponses", () => {
	it("returns the same array reference when no reasoning blocks are present", () => {
		const messages: MessageLike[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: [{ type: "text", text: "Hi" }] },
		];
		const out = sanitizeMessagesForOpenAIResponses(messages);
		expect(out).toBe(messages);
	});

	it("removes reasoning blocks from assistant array content", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", id: "rs_abc" },
					{ type: "text", text: "Answer" },
				],
			},
		];
		const out = sanitizeMessagesForOpenAIResponses(messages);
		expect(out).not.toBe(messages);
		const content = out[0].content as Array<{ type?: string }>;
		expect(content.map((b) => b.type)).toEqual(["text"]);
	});

	it("strips blocks with rs_ id prefix regardless of type", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ id: "rs_xyz", type: "unknown_reasoning" },
					{ type: "text", text: "ok" },
				],
			},
		];
		const out = sanitizeMessagesForOpenAIResponses(messages);
		const content = (out[0] as { content: unknown[] }).content;
		expect(content).toHaveLength(1);
	});

	it("strips reasoning blocks from any role with array content (defensive)", () => {
		const messages: MessageLike[] = [
			{
				role: "user",
				content: [
					{ type: "reasoning", id: "rs_x" },
					{ type: "text", text: "weird" },
				],
			},
		];
		const out = sanitizeMessagesForOpenAIResponses(messages);
		expect(out).not.toBe(messages);
		const content = out[0].content as Array<{ type?: string; text?: string }>;
		expect(content.map((b) => b.type)).toEqual(["text"]);
		expect(content[0].text).toBe("weird");
	});

	it("replaces assistant array that would be empty after reasoning strip with placeholder text", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [{ type: "reasoning", id: "rs_only" }],
			},
		];
		const out = sanitizeMessagesForOpenAIResponses(messages);
		const content = out[0].content as Array<{ type?: string; text?: string }>;
		expect(content.length).toBe(1);
		expect(content[0].type).toBe("text");
		expect(content[0].text).toContain("omitted");
	});

	it("handles empty array", () => {
		expect(sanitizeMessagesForOpenAIResponses([])).toEqual([]);
	});

	it("leaves string content untouched", () => {
		const messages: MessageLike[] = [{ role: "user", content: "plain string" }];
		const out = sanitizeMessagesForOpenAIResponses(messages);
		expect(out).toBe(messages);
	});
});
