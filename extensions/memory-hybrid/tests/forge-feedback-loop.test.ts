// @ts-nocheck
import { describe, expect, it } from "vitest";
import { buildForgeRemediationRequest } from "../../../.github/scripts/forge-feedback-loop.mjs";

describe("buildForgeRemediationRequest", () => {
	it("dispatches when CI fails and review feedback is still open", () => {
		const result = buildForgeRemediationRequest({
			repo: {
				owner: "markus-lassfolk",
				repo: "openclaw-hybrid-memory",
				fullName: "markus-lassfolk/openclaw-hybrid-memory",
			},
			pullRequest: {
				number: 664,
				title: "Feature: Automated CI and Review Feedback Resolution Loop",
				url: "https://example.test/pr/664",
				baseRef: "main",
				headRef: "fix/664",
				headSha: "abc123",
				author: "forge-bot",
			},
			headCommit: { committedAt: "2026-03-23T10:00:00Z" },
			checkRuns: [
				{
					name: "Test (Node 24)",
					status: "completed",
					conclusion: "failure",
					details_url: "https://example.test/checks/1",
					output: { summary: "Expected true to be false" },
				},
			],
			issueComments: [
				{
					id: 1,
					body: "Please also cover the review loop in tests.",
					created_at: "2026-03-23T10:05:00Z",
					updated_at: "2026-03-23T10:05:00Z",
					html_url: "https://example.test/comment/1",
					user: { login: "reviewer", type: "User" },
				},
			],
			reviews: [
				{
					id: 2,
					state: "CHANGES_REQUESTED",
					body: "Handle unresolved threads, not only top-level comments.",
					submitted_at: "2026-03-23T10:06:00Z",
					html_url: "https://example.test/reviews/2",
					user: { login: "maintainer", type: "User" },
				},
			],
			reviewThreads: [
				{
					id: "thread-1",
					isResolved: false,
					isOutdated: false,
					path: ".github/workflows/forge-feedback-loop.yml",
					line: 42,
					createdAt: "2026-03-23T10:07:00Z",
					updatedAt: "2026-03-23T10:08:00Z",
					comments: {
						nodes: [
							{
								body: "This thread still needs an actual dispatch event.",
								createdAt: "2026-03-23T10:08:00Z",
								updatedAt: "2026-03-23T10:08:00Z",
								url: "https://example.test/thread/1",
								author: { login: "maintainer" },
							},
						],
					},
				},
			],
		});

		expect(result.summary.shouldDispatch).toBe(true);
		expect(result.summary.reasons).toEqual(["failed-ci", "review-feedback"]);
		expect(result.failedChecks).toHaveLength(1);
		expect(result.issueComments).toHaveLength(1);
		expect(result.reviews).toHaveLength(1);
		expect(result.unresolvedThreads).toHaveLength(1);
		expect(result.prompt).toContain("Use Codex with model gpt-5.4-pro");
		expect(result.prompt).toContain("Fix every failing CI check");
	});

	it("treats human comments older than the latest push as already addressed", () => {
		const result = buildForgeRemediationRequest({
			repo: {
				owner: "markus-lassfolk",
				repo: "openclaw-hybrid-memory",
				fullName: "markus-lassfolk/openclaw-hybrid-memory",
			},
			pullRequest: {
				number: 12,
				title: "Cleanup",
				baseRef: "main",
				headRef: "fix/12",
				headSha: "def456",
			},
			headCommit: { committedAt: "2026-03-23T11:00:00Z" },
			checkRuns: [],
			issueComments: [
				{
					id: 1,
					body: "Old comment that predates the latest push.",
					created_at: "2026-03-23T10:00:00Z",
					updated_at: "2026-03-23T10:00:00Z",
					user: { login: "reviewer", type: "User" },
				},
			],
			reviews: [
				{
					id: 2,
					state: "COMMENTED",
					body: "Also old feedback.",
					submitted_at: "2026-03-23T10:30:00Z",
					user: { login: "reviewer", type: "User" },
				},
			],
			reviewThreads: [],
		});

		expect(result.summary.shouldDispatch).toBe(false);
		expect(result.summary.completionReady).toBe(true);
		expect(result.issueComments).toHaveLength(0);
		expect(result.reviews).toHaveLength(0);
	});

	it("ignores bot-authored feedback and approvals", () => {
		const result = buildForgeRemediationRequest({
			repo: {
				owner: "markus-lassfolk",
				repo: "openclaw-hybrid-memory",
				fullName: "markus-lassfolk/openclaw-hybrid-memory",
			},
			pullRequest: {
				number: 99,
				title: "Bot PR",
				baseRef: "main",
				headRef: "copilot-fix/99",
				headSha: "987xyz",
			},
			headCommit: { committedAt: "2026-03-23T10:00:00Z" },
			checkRuns: [],
			issueComments: [
				{
					id: 1,
					body: "Automated status update",
					created_at: "2026-03-23T10:05:00Z",
					updated_at: "2026-03-23T10:05:00Z",
					user: { login: "github-actions[bot]", type: "Bot" },
				},
			],
			reviews: [
				{
					id: 2,
					state: "APPROVED",
					body: "Looks good to me",
					submitted_at: "2026-03-23T10:06:00Z",
					user: { login: "maintainer", type: "User" },
				},
			],
			reviewThreads: [
				{
					id: "thread-2",
					isResolved: false,
					path: "src/example.ts",
					line: 7,
					comments: {
						nodes: [
							{
								body: "bot reminder",
								createdAt: "2026-03-23T10:08:00Z",
								updatedAt: "2026-03-23T10:08:00Z",
								author: { login: "github-actions[bot]" },
							},
						],
					},
				},
			],
		});

		expect(result.summary.shouldDispatch).toBe(false);
		expect(result.summary.completionReady).toBe(true);
		expect(result.issueComments).toHaveLength(0);
		expect(result.reviews).toHaveLength(0);
		expect(result.unresolvedThreads).toHaveLength(0);
	});

	it("ignores dismissed reviews", () => {
		const result = buildForgeRemediationRequest({
			repo: {
				owner: "markus-lassfolk",
				repo: "openclaw-hybrid-memory",
				fullName: "markus-lassfolk/openclaw-hybrid-memory",
			},
			pullRequest: {
				number: 100,
				title: "Test PR",
				baseRef: "main",
				headRef: "test/100",
				headSha: "abc789",
			},
			headCommit: { committedAt: "2026-03-23T10:00:00Z" },
			checkRuns: [],
			issueComments: [],
			reviews: [
				{
					id: 1,
					state: "DISMISSED",
					body: "This review was dismissed by a maintainer",
					submitted_at: "2026-03-23T10:05:00Z",
					user: { login: "reviewer", type: "User" },
				},
			],
			reviewThreads: [],
		});

		expect(result.summary.shouldDispatch).toBe(false);
		expect(result.summary.completionReady).toBe(true);
		expect(result.reviews).toHaveLength(0);
	});
});
