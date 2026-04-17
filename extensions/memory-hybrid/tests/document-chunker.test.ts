import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../services/document-chunker.js";

describe("chunkMarkdown", () => {
	it("returns empty array for empty input", () => {
		expect(chunkMarkdown("")).toEqual([]);
		expect(chunkMarkdown("   ")).toEqual([]);
	});

	it("splits by ## headings", () => {
		const md = `## Introduction

This is the intro text.

## Methods

Here are the methods.`;
		const chunks = chunkMarkdown(md);
		expect(chunks.length).toBe(2);
		expect(chunks[0].sectionHeading).toBe("Introduction");
		expect(chunks[0].text).toContain("intro text");
		expect(chunks[1].sectionHeading).toBe("Methods");
		expect(chunks[1].text).toContain("methods");
	});

	it("splits by ### headings", () => {
		const md = `### Section A

Content A.

### Section B

Content B.`;
		const chunks = chunkMarkdown(md);
		expect(chunks.length).toBe(2);
		expect(chunks[0].sectionHeading).toBe("Section A");
		expect(chunks[1].sectionHeading).toBe("Section B");
	});

	it("assigns correct chunkIndex and totalChunks", () => {
		const md = "## A\n\nText A.\n\n## B\n\nText B.\n\n## C\n\nText C.";
		const chunks = chunkMarkdown(md);
		expect(chunks.length).toBe(3);
		expect(chunks[0].chunkIndex).toBe(0);
		expect(chunks[0].totalChunks).toBe(3);
		expect(chunks[2].chunkIndex).toBe(2);
		expect(chunks[2].totalChunks).toBe(3);
	});

	it("falls back to paragraph splitting when no headings", () => {
		const para1 = "First paragraph with some content.";
		const para2 = "Second paragraph with different content.";
		const md = `${para1}\n\n${para2}`;
		const chunks = chunkMarkdown(md);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.some((c) => c.text.includes("First"))).toBe(true);
		expect(chunks.every((c) => c.sectionHeading === null)).toBe(true);
	});

	it("splits long sections by paragraphs", () => {
		// Create a section that is way longer than chunkSize
		const longSection = Array.from(
			{ length: 20 },
			(_, i) => `Paragraph ${i + 1}: ${"x".repeat(100)}`,
		).join("\n\n");
		const md = `## Long Section\n\n${longSection}`;
		const chunks = chunkMarkdown(md, { chunkSize: 500 });
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((c) => c.sectionHeading === "Long Section")).toBe(true);
	});

	it("includes section heading in chunk text", () => {
		const md = "## My Section\n\nSome content here.";
		const chunks = chunkMarkdown(md);
		expect(chunks.length).toBe(1);
		expect(chunks[0].text).toContain("My Section");
		expect(chunks[0].text).toContain("Some content here.");
	});

	it("handles heading-only sections", () => {
		const md = "## Title Only\n\n## Another Section\n\nWith content.";
		const chunks = chunkMarkdown(md);
		expect(chunks.length).toBe(2);
		expect(chunks[0].sectionHeading).toBe("Title Only");
		expect(chunks[1].sectionHeading).toBe("Another Section");
	});

	it("respects chunkSize option", () => {
		const md = `## Section\n\n${"word ".repeat(50)}`;
		const chunks500 = chunkMarkdown(md, { chunkSize: 500 });
		const chunks100 = chunkMarkdown(md, { chunkSize: 100 });
		// Smaller chunkSize should produce more chunks
		expect(chunks100.length).toBeGreaterThanOrEqual(chunks500.length);
	});

	it("ignores # (h1) headings — treats as body text", () => {
		const md = "# Document Title\n\nSome text.\n\n## Section\n\nSection text.";
		const chunks = chunkMarkdown(md);
		// The # heading is treated as body text, so we expect 1-2 chunks
		expect(chunks.length).toBeGreaterThan(0);
		// One of the sections should have the 'Section' heading
		expect(chunks.some((c) => c.sectionHeading === "Section")).toBe(true);
	});

	it("handles content before first heading", () => {
		const md =
			"Some intro content without a heading.\n\n## First Section\n\nSection text.";
		const chunks = chunkMarkdown(md);
		// There should be at least the 'First Section' chunk
		expect(chunks.some((c) => c.sectionHeading === "First Section")).toBe(true);
	});
});
