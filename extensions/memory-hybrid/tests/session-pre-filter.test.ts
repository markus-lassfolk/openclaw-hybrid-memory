/**
 * Tests for session-pre-filter service (Issue #290).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PreFilterConfig,
	extractSessionSample,
	preFilterSessions,
} from "../services/session-pre-filter.js";

function msg(role: string, text: string): string {
	return JSON.stringify({
		type: "message",
		message: { role, content: [{ type: "text", text }] },
	});
}

const defaultConfig: PreFilterConfig = {
	enabled: true,
	model: "qwen3:8b",
	endpoint: "http://localhost:11434",
	maxCharsPerSession: 2000,
};

describe("extractSessionSample", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pre-filter-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true });
		} catch {
			/* ignore */
		}
	});

	it("extracts user messages from session JSONL", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			[
				msg("user", "Remember that I prefer dark mode"),
				msg("assistant", "Got it."),
				msg("user", "And always use TypeScript"),
			].join("\n"),
			"utf-8",
		);

		const sample = await extractSessionSample(path, 2000);
		expect(sample).toContain("Remember that I prefer dark mode");
		expect(sample).toContain("And always use TypeScript");
		// assistant messages should NOT be included
		expect(sample).not.toContain("Got it.");
	});

	it("returns empty string for non-existent file", async () => {
		const sample = await extractSessionSample(
			join(tmpDir, "nonexistent.jsonl"),
			2000,
		);
		expect(sample).toBe("");
	});

	it("skips heartbeat user messages", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			[
				msg("user", "HEARTBEAT — please confirm active"),
				msg("assistant", "HEARTBEAT_OK"),
			].join("\n"),
			"utf-8",
		);

		const sample = await extractSessionSample(path, 2000);
		expect(sample.trim()).toBe("");
	});

	it("respects maxChars limit", async () => {
		const path = join(tmpDir, "session.jsonl");
		const longText = "A".repeat(500);
		writeFileSync(
			path,
			[
				msg("user", longText),
				msg("user", longText),
				msg("user", longText),
			].join("\n"),
			"utf-8",
		);

		const sample = await extractSessionSample(path, 600);
		expect(sample.length).toBeLessThanOrEqual(600);
	});

	it("returns empty for session with only short messages", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			[
				msg("user", "ok"), // < 10 chars
				msg("user", "yes"),
			].join("\n"),
			"utf-8",
		);

		const sample = await extractSessionSample(path, 2000);
		expect(sample.trim()).toBe("");
	});
});

describe("preFilterSessions", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pre-filter-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true });
		} catch {
			/* ignore */
		}
		vi.restoreAllMocks();
	});

	it("returns all sessions when disabled", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(path, msg("user", "Remember I prefer dark mode"), "utf-8");

		const result = await preFilterSessions([path], {
			...defaultConfig,
			enabled: false,
		});

		expect(result.kept).toEqual([path]);
		expect(result.skipped).toEqual([]);
		expect(result.ollamaUnavailable).toBe(false);
	});

	it("returns all sessions when list is empty", async () => {
		const result = await preFilterSessions([], defaultConfig);

		expect(result.kept).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.ollamaUnavailable).toBe(false);
	});

	it("keeps session when local model returns YES", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "Remember that I prefer dark mode always"),
			"utf-8",
		);

		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue({
						choices: [{ message: { content: "YES" } }],
					}),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		expect(result.kept).toContain(path);
		expect(result.skipped).not.toContain(path);
		expect(result.ollamaUnavailable).toBe(false);
	});

	it("skips session when local model returns NO", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "Can you help me fix this bug please?"),
			"utf-8",
		);

		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue({
						choices: [{ message: { content: "NO" } }],
					}),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		expect(result.skipped).toContain(path);
		expect(result.kept).not.toContain(path);
		expect(result.ollamaUnavailable).toBe(false);
	});

	it("keeps session when model returns ambiguous response (conservative)", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "What is the capital of France please?"),
			"utf-8",
		);

		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue({
						choices: [{ message: { content: "MAYBE" } }],
					}),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		expect(result.kept).toContain(path);
		expect(result.skipped).not.toContain(path);
	});

	it("returns ollamaUnavailable=true and keeps all sessions on ECONNREFUSED", async () => {
		const paths = [
			join(tmpDir, "session1.jsonl"),
			join(tmpDir, "session2.jsonl"),
		];
		for (const p of paths) {
			writeFileSync(
				p,
				msg("user", "Remember that I like TypeScript always"),
				"utf-8",
			);
		}

		const connErr = Object.assign(
			new Error("connect ECONNREFUSED 127.0.0.1:11434"),
			{
				code: "ECONNREFUSED",
			},
		);
		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockRejectedValue(connErr),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions(paths, defaultConfig, {
			ollamaClient: mockClient,
		});

		expect(result.ollamaUnavailable).toBe(true);
		expect(result.kept).toEqual(paths);
		expect(result.skipped).toEqual([]);
	});

	it("keeps session conservatively on unexpected LLM error", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "Remember I prefer dark mode always"),
			"utf-8",
		);

		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockRejectedValue(new Error("Internal server error")),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		expect(result.kept).toContain(path);
		expect(result.ollamaUnavailable).toBe(false);
	});

	it("skips sessions with no extractable user messages", async () => {
		const path = join(tmpDir, "empty.jsonl");
		writeFileSync(
			path,
			[
				msg("assistant", "Running cron job..."),
				msg("user", "HEARTBEAT — confirm active"),
			].join("\n"),
			"utf-8",
		);

		const mockClient = {
			chat: {
				completions: {
					create: vi.fn(),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		// Heartbeat session has no extractable user messages → skipped without calling Ollama
		expect(result.skipped).toContain(path);
		expect(result.kept).not.toContain(path);
		// Ollama should NOT have been called for an empty session
		expect(
			(mockClient.chat.completions.create as ReturnType<typeof vi.fn>).mock
				.calls,
		).toHaveLength(0);
	});

	it("handles multiple sessions with mixed YES/NO responses", async () => {
		const paths = [
			join(tmpDir, "session1.jsonl"),
			join(tmpDir, "session2.jsonl"),
			join(tmpDir, "session3.jsonl"),
		];
		for (const p of paths) {
			writeFileSync(
				p,
				msg("user", "Remember I always want proper error handling"),
				"utf-8",
			);
		}

		const responses = ["YES", "NO", "YES"];
		let callIdx = 0;
		const mockClient = {
			chat: {
				completions: {
					create: vi
						.fn()
						.mockImplementation(() =>
							Promise.resolve({
								choices: [{ message: { content: responses[callIdx++] } }],
							}),
						),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions(paths, defaultConfig, {
			ollamaClient: mockClient,
		});

		expect(result.kept).toEqual([paths[0], paths[2]]);
		expect(result.skipped).toEqual([paths[1]]);
		expect(result.ollamaUnavailable).toBe(false);
	});

	it("does not misclassify 'UNKNOWN' substring as NO response (word-boundary)", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "From now on always use TypeScript for everything"),
			"utf-8",
		);

		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue({
						choices: [{ message: { content: "UNKNOWN" } }],
					}),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		// "UNKNOWN" does not contain a standalone word "NO", so it should be treated as
		// ambiguous (conservative: keep the session)
		expect(result.kept).toContain(path);
		expect(result.skipped).not.toContain(path);
	});

	it("handles Qwen3 thinking-model YES response embedded in think tags", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "From now on always use TypeScript"),
			"utf-8",
		);

		const thinkingResponse =
			"<think>\nLet me analyze...\nThis seems like a preference.\n</think>\nYES";
		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue({
						choices: [{ message: { content: thinkingResponse } }],
					}),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		expect(result.kept).toContain(path);
		expect(result.skipped).not.toContain(path);
	});

	it("#488: retries with truncated sample on context-length error and classifies correctly", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "Remember I prefer dark mode always"),
			"utf-8",
		);

		const contextLengthErr = Object.assign(
			new Error("Input length 768 exceeds maximum allowed token size 512"),
			{
				status: 400,
			},
		);
		let callCount = 0;
		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockImplementation(() => {
						callCount++;
						if (callCount === 1) return Promise.reject(contextLengthErr);
						// Second call with truncated input succeeds
						return Promise.resolve({
							choices: [{ message: { content: "YES" } }],
						});
					}),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		// Should have retried with truncated input and kept the session
		expect(result.kept).toContain(path);
		expect(result.skipped).not.toContain(path);
		expect(result.ollamaUnavailable).toBe(false);
		expect(callCount).toBe(2);
	});

	it("#488: keeps session conservatively when truncated retry also fails with context-length error", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "Remember I prefer dark mode always"),
			"utf-8",
		);

		const contextLengthErr = Object.assign(
			new Error("Input length 768 exceeds maximum allowed token size 512"),
			{
				status: 400,
			},
		);
		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockRejectedValue(contextLengthErr),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions([path], defaultConfig, {
			ollamaClient: mockClient,
		});

		// Both attempts failed — keep conservatively
		expect(result.kept).toContain(path);
		expect(result.skipped).not.toContain(path);
		expect(result.ollamaUnavailable).toBe(false);
	});

	it("#488: does not set ollamaUnavailable on context-length error (Ollama is reachable)", async () => {
		const paths = [
			join(tmpDir, "session1.jsonl"),
			join(tmpDir, "session2.jsonl"),
		];
		for (const p of paths) {
			writeFileSync(
				p,
				msg("user", "Remember that I like TypeScript always"),
				"utf-8",
			);
		}

		const contextLengthErr = Object.assign(
			new Error("Input length 768 exceeds maximum allowed token size 512"),
			{
				status: 400,
			},
		);
		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockRejectedValue(contextLengthErr),
				},
			},
		} as unknown as import("openai").default;

		const result = await preFilterSessions(paths, defaultConfig, {
			ollamaClient: mockClient,
		});

		// Ollama IS reachable — just input is too long. ollamaUnavailable must remain false.
		expect(result.ollamaUnavailable).toBe(false);
		// Both sessions kept conservatively
		expect(result.kept).toEqual(paths);
	});

	it("strips ollama/ prefix from model name when classifying", async () => {
		const path = join(tmpDir, "session.jsonl");
		writeFileSync(
			path,
			msg("user", "Remember I prefer dark mode always"),
			"utf-8",
		);

		let capturedModel: string | undefined;
		const mockClient = {
			chat: {
				completions: {
					create: vi.fn().mockImplementation((body: { model?: string }) => {
						capturedModel = body.model;
						return Promise.resolve({
							choices: [{ message: { content: "YES" } }],
						});
					}),
				},
			},
		} as unknown as import("openai").default;

		await preFilterSessions(
			[path],
			{ ...defaultConfig, model: "ollama/qwen3:8b" },
			{ ollamaClient: mockClient },
		);

		expect(capturedModel).toBe("qwen3:8b");
	});
});
