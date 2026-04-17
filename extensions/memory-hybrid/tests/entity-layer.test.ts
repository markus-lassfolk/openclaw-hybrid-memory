/**
 * Organizations, contacts, and fact_entity_mentions (#985–#987).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import {
	escapeLikeLiteralForBackslashEscape,
	normalizeEntityKey,
} from "../backends/facts-db/entity-layer.js";
import { detectFactTextLanguage } from "../services/entity-enrichment.js";

describe("normalizeEntityKey", () => {
	it("lowercases and collapses whitespace", () => {
		expect(normalizeEntityKey("  Acme   Corp  ")).toBe("acme corp");
	});
});

describe("escapeLikeLiteralForBackslashEscape", () => {
	it("escapes LIKE wildcards and backslashes for ESCAPE '\\'", () => {
		expect(escapeLikeLiteralForBackslashEscape("a%b_c\\d")).toBe(
			"a\\%b\\_c\\\\d",
		);
	});
});

describe("detectFactTextLanguage (franc)", () => {
	it("detects a Swedish-heavy sample (ISO 639-3)", () => {
		const t =
			"Mötet med Företag AB och Anna Svensson handlade om budgeten för nästa kvartal och leveransdatum.";
		const lang = detectFactTextLanguage(t);
		expect(lang).toBe("swe");
	});
});

describe("FactsDB entity layer persistence", () => {
	let dir: string;
	let db: FactsDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hybrid-entity-"));
		mkdirSync(dir, { recursive: true });
		db = new FactsDB(join(dir, "facts.db"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("applyEntityEnrichment links ORG facts and sets contact primary org when co-mentioned", () => {
		const fact = db.store({
			text: "Anna Svensson from Acme Corporation confirmed the API deadline for the integration project.",
			entity: null,
			key: null,
			value: null,
			category: "other",
			importance: 0.5,
			source: "test",
		});

		db.applyEntityEnrichment(
			fact.id,
			[
				{
					label: "ORG",
					surfaceText: "Acme Corporation",
					normalizedSurface: "acme corporation",
					startOffset: 22,
					endOffset: 38,
					confidence: 0.9,
				},
				{
					label: "PERSON",
					surfaceText: "Anna Svensson",
					normalizedSurface: "anna svensson",
					startOffset: 0,
					endOffset: 13,
					confidence: 0.85,
				},
			],
			"eng",
		);

		const org = db.lookupOrganization("acme corporation");
		expect(org).not.toBeNull();
		if (!org) throw new Error("expected org");
		expect(db.listFactIdsLinkedToOrg(org.id, 10)).toContain(fact.id);

		const people = db.listContactsForOrganization(org.id, 10);
		expect(
			people.some((p) => p.displayName.toLowerCase().includes("anna")),
		).toBe(true);
	});

	it("marks facts as enriched even when the LLM returns zero mentions (queue drains)", () => {
		const fact = db.store({
			text: "Short text that is still long enough for min length checks in other code paths.",
			entity: null,
			key: null,
			value: null,
			category: "other",
			importance: 0.5,
			source: "test",
		});
		expect(db.listFactIdsNeedingEntityEnrichment(50, 10)).toContain(fact.id);
		db.applyEntityEnrichment(fact.id, [], "und");
		expect(db.listFactIdsNeedingEntityEnrichment(50, 10)).not.toContain(
			fact.id,
		);
	});

	it("listContactsByNamePrefix treats % in prefix as literal when ESCAPE is used", () => {
		const fact = db.store({
			text: "Contact note about 100% Pure brand and nothing else matters here for length.",
			entity: null,
			key: null,
			value: null,
			category: "other",
			importance: 0.5,
			source: "test",
		});
		db.applyEntityEnrichment(
			fact.id,
			[
				{
					label: "PERSON",
					surfaceText: "100% Pure",
					normalizedSurface: "100% pure",
					startOffset: 0,
					endOffset: 9,
					confidence: 0.9,
				},
			],
			"eng",
		);
		const byPrefix = db.listContactsByNamePrefix("100%", 10);
		expect(byPrefix.some((c) => c.displayName.includes("100%"))).toBe(true);
	});
});
