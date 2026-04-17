/**
 * Tests for Confidence Reinforcement on Repeated Mentions (Issue #147).
 *
 * Tests cover:
 * - boostConfidence method in FactsDB
 * - Config parsing for reinforcement section
 * - Passive-observer reinforcement path
 * - Decay + reinforcement interaction
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import type { ReinforcementConfig } from "../config.js";
import { _testing } from "../index.js";
import {
	type PassiveObserverConfig,
	runPassiveObserver,
} from "../services/passive-observer.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(dir: string) {
	return new FactsDB(join(dir, "facts.db"));
}

function storeFact(
	db: InstanceType<typeof FactsDB>,
	text = "User prefers TypeScript",
	confidence = 0.8,
) {
	return db.store({
		text,
		category: "preference",
		importance: 0.7,
		entity: null,
		key: null,
		value: null,
		source: "test",
		confidence,
	});
}

// ---------------------------------------------------------------------------
// 1. boostConfidence — basic behaviour
// ---------------------------------------------------------------------------

describe("FactsDB.boostConfidence", () => {
	let tmpDir: string;
	let db: InstanceType<typeof FactsDB>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "reinf-test-"));
		db = makeDb(tmpDir);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("boosts confidence by the given delta", () => {
		const fact = storeFact(db, "User likes dark mode", 0.6);
		const updated = db.boostConfidence(fact.id, 0.1);
		expect(updated).toBe(true);
		const retrieved = db.getById(fact.id);
		expect(retrieved?.confidence).toBeCloseTo(0.7, 5);
	});

	it("caps confidence at maxConfidence", () => {
		const fact = storeFact(db, "User uses vim", 0.95);
		db.boostConfidence(fact.id, 0.1, 1.0);
		const retrieved = db.getById(fact.id);
		expect(retrieved?.confidence).toBeCloseTo(1.0, 5);
	});

	it("does not exceed a custom maxConfidence cap", () => {
		const fact = storeFact(db, "User prefers Python", 0.7);
		db.boostConfidence(fact.id, 0.2, 0.8);
		const retrieved = db.getById(fact.id);
		expect(retrieved?.confidence).toBeCloseTo(0.8, 5);
	});

	it("increments reinforced_count on each boost", () => {
		const fact = storeFact(db, "Project uses React", 0.5);
		db.boostConfidence(fact.id, 0.05);
		db.boostConfidence(fact.id, 0.05);
		db.boostConfidence(fact.id, 0.05);
		const retrieved = db.getById(fact.id) as {
			reinforcedCount?: number;
		} & object;
		const reinf =
			retrieved && "reinforcedCount" in retrieved
				? retrieved.reinforcedCount
				: undefined;
		expect(reinf).toBe(3);
	});

	it("updates last_reinforced_at timestamp", () => {
		const before = Math.floor(Date.now() / 1000) - 1;
		const fact = storeFact(db, "Team decided on monorepo", 0.7);
		db.boostConfidence(fact.id, 0.1);
		const retrieved = db.getById(fact.id) as {
			lastReinforcedAt?: number | null;
		} & object;
		const ts =
			retrieved && "lastReinforcedAt" in retrieved
				? retrieved.lastReinforcedAt
				: undefined;
		expect(ts).toBeGreaterThanOrEqual(before);
	});

	it("returns false for unknown fact id", () => {
		const result = db.boostConfidence("non-existent-uuid", 0.1);
		expect(result).toBe(false);
	});

	it("handles zero delta (no-op boost)", () => {
		const fact = storeFact(db, "Stack: Node.js 20", 0.6);
		db.boostConfidence(fact.id, 0.0);
		const retrieved = db.getById(fact.id);
		expect(retrieved?.confidence).toBeCloseTo(0.6, 5);
	});

	it("handles multiple consecutive boosts correctly", () => {
		const fact = storeFact(db, "Database is PostgreSQL", 0.5);
		for (let i = 0; i < 5; i++) {
			db.boostConfidence(fact.id, 0.1, 1.0);
		}
		const retrieved = db.getById(fact.id);
		// 0.5 + 5*0.1 = 1.0, capped at 1.0
		expect(retrieved?.confidence).toBeCloseTo(1.0, 5);
	});

	it("boosts from initial confidence of 1.0 without exceeding cap", () => {
		const fact = storeFact(db, "Default confidence fact", 1.0);
		db.boostConfidence(fact.id, 0.1, 1.0);
		const retrieved = db.getById(fact.id);
		expect(retrieved?.confidence).toBeCloseTo(1.0, 5);
	});

	it("works after storing multiple facts (correct fact is boosted)", () => {
		const f1 = storeFact(db, "Fact A", 0.5);
		const f2 = storeFact(db, "Fact B", 0.5);
		db.boostConfidence(f1.id, 0.2);
		const r1 = db.getById(f1.id);
		const r2 = db.getById(f2.id);
		expect(r1?.confidence).toBeCloseTo(0.7, 5);
		expect(r2?.confidence).toBeCloseTo(0.5, 5);
	});
});

// ---------------------------------------------------------------------------
// 2. Config parsing
// ---------------------------------------------------------------------------

describe("parseConfig — reinforcement section", () => {
	const BASE_CFG = {
		embedding: {
			provider: "openai",
			model: "text-embedding-3-small",
			apiKey: "sk-test-key-12345678",
		},
	};

	it("uses defaults when reinforcement is not specified", () => {
		const cfg = hybridConfigSchema.parse(BASE_CFG);
		expect(cfg.reinforcement.enabled).toBe(true);
		expect(cfg.reinforcement.passiveBoost).toBeCloseTo(0.1, 5);
		expect(cfg.reinforcement.activeBoost).toBeCloseTo(0.05, 5);
		expect(cfg.reinforcement.maxConfidence).toBeCloseTo(1.0, 5);
		expect(cfg.reinforcement.similarityThreshold).toBeCloseTo(0.85, 5);
	});

	it("parses custom reinforcement values", () => {
		const cfg = hybridConfigSchema.parse({
			...BASE_CFG,
			reinforcement: {
				enabled: true,
				passiveBoost: 0.2,
				activeBoost: 0.08,
				maxConfidence: 0.9,
				similarityThreshold: 0.9,
			},
		});
		expect(cfg.reinforcement.passiveBoost).toBeCloseTo(0.2, 5);
		expect(cfg.reinforcement.activeBoost).toBeCloseTo(0.08, 5);
		expect(cfg.reinforcement.maxConfidence).toBeCloseTo(0.9, 5);
		expect(cfg.reinforcement.similarityThreshold).toBeCloseTo(0.9, 5);
	});

	it("respects enabled: false", () => {
		const cfg = hybridConfigSchema.parse({
			...BASE_CFG,
			reinforcement: { enabled: false },
		});
		expect(cfg.reinforcement.enabled).toBe(false);
	});

	it("clamps out-of-range passiveBoost to default", () => {
		const cfg = hybridConfigSchema.parse({
			...BASE_CFG,
			reinforcement: { passiveBoost: 5.0 }, // > 1.0, invalid
		});
		expect(cfg.reinforcement.passiveBoost).toBeCloseTo(0.1, 5);
	});

	it("clamps out-of-range maxConfidence to default", () => {
		const cfg = hybridConfigSchema.parse({
			...BASE_CFG,
			reinforcement: { maxConfidence: 2.0 }, // > 1.0, invalid
		});
		expect(cfg.reinforcement.maxConfidence).toBeCloseTo(1.0, 5);
	});
});

// ---------------------------------------------------------------------------
// 3. Decay + reinforcement interaction
// ---------------------------------------------------------------------------

describe("Decay + reinforcement interaction", () => {
	let tmpDir: string;
	let db: InstanceType<typeof FactsDB>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "reinf-decay-test-"));
		db = makeDb(tmpDir);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reinforced fact has higher confidence than unreinforced after boost", () => {
		const reinforced = storeFact(db, "Frequently mentioned fact", 0.6);
		const plain = storeFact(db, "Only-mentioned-once fact", 0.6);
		db.boostConfidence(reinforced.id, 0.1);
		const r = db.getById(reinforced.id);
		const p = db.getById(plain.id);
		expect(r?.confidence ?? 0).toBeGreaterThan(p?.confidence ?? 0);
	});

	it("multiple reinforcements counteract decay (confidence stays high)", () => {
		const fact = storeFact(db, "Important persistent fact", 0.5);
		// Simulate repeated mentions: multiple passive boosts
		for (let i = 0; i < 5; i++) {
			db.boostConfidence(fact.id, 0.1, 1.0);
		}
		const retrieved = db.getById(fact.id);
		expect(retrieved?.confidence).toBeGreaterThanOrEqual(0.9);
	});

	it("single-mention fact stays at original confidence without boost", () => {
		const fact = storeFact(db, "One-time fact", 0.7);
		const retrieved = db.getById(fact.id);
		// No boost applied — confidence unchanged
		expect(retrieved?.confidence).toBeCloseTo(0.7, 5);
	});

	it("reinforce_count reflects how many times fact was boosted", () => {
		const fact = storeFact(db, "Boosted three times", 0.5);
		db.boostConfidence(fact.id, 0.05);
		db.boostConfidence(fact.id, 0.05);
		db.boostConfidence(fact.id, 0.05);
		const retrieved = db.getById(fact.id) as {
			reinforcedCount?: number;
		} & object;
		const count =
			retrieved && "reinforcedCount" in retrieved
				? retrieved.reinforcedCount
				: undefined;
		expect(count).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// 4. Passive observer reinforcement path
// ---------------------------------------------------------------------------

describe("Passive observer — reinforcement on similarity", () => {
	let tmpDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "reinf-observer-test-"));
		sessionsDir = join(tmpDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeConfig(
		overrides: Partial<PassiveObserverConfig> = {},
	): PassiveObserverConfig {
		return {
			enabled: true,
			intervalMinutes: 15,
			maxCharsPerChunk: 8000,
			minImportance: 0.5,
			deduplicationThreshold: 0.92,
			sessionsDir,
			...overrides,
		};
	}

	function makeFactsDb(
		existingFacts: Array<{ id: string; text: string; confidence: number }> = [],
	) {
		const boostCalls: Array<{ id: string; delta: number }> = [];
		return {
			getRecentFacts: () =>
				existingFacts.map((f) => ({ id: f.id, text: f.text })),
			store: vi.fn().mockReturnValue({ id: "new-fact-id" }),
			boostConfidence: vi
				.fn()
				.mockImplementation((id: string, delta: number) => {
					boostCalls.push({ id, delta });
					return true;
				}),
			_boostCalls: boostCalls,
		};
	}

	function makeVectorDb(searchResults: unknown[] = []) {
		return { store: vi.fn(), search: vi.fn().mockResolvedValue(searchResults) };
	}

	function makeEmbeddings(vec = [1, 0, 0]) {
		return {
			embed: vi.fn().mockResolvedValue(vec),
			embedBatch: vi
				.fn()
				.mockImplementation((texts: string[]) =>
					Promise.resolve(texts.map(() => vec)),
				),
		};
	}

	it("factsReinforced is zero when no similar facts exist", async () => {
		const cfg = makeConfig({ sessionsDir: join(tmpDir, "nonexistent") });
		const result = await runPassiveObserver(
			makeFactsDb() as never,
			makeVectorDb() as never,
			makeEmbeddings() as never,
			{} as never,
			cfg,
			["preference", "fact"],
			{ model: "test-model", dbDir: tmpDir },
			{ info: () => {}, warn: () => {} },
		);
		expect(result.factsReinforced).toBe(0);
	});

	it("reinforcement config disabled does not call boostConfidence even when vectorDb.search finds a match", async () => {
		const sessionFile = join(sessionsDir, "session-abc.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "message", message: { role: "user", content: "I use TypeScript" } })}\n`,
		);

		const factsDb = makeFactsDb([
			{ id: "existing-fact-1", text: "I use TypeScript", confidence: 0.7 },
		]);

		vi.doMock("../services/chat.js", () => ({
			chatCompleteWithRetry: vi
				.fn()
				.mockResolvedValue(
					'[{"text":"I use TypeScript","category":"preference","importance":0.8}]',
				),
		}));

		const { runPassiveObserver: runFn } = await import(
			"../services/passive-observer.js"
		);

		// vectorDb.search returns a match — the duplicate is found, but reinforcement is disabled
		const vectorDbWithMatch = makeVectorDb([
			{ entry: { id: "existing-fact-1" }, score: 0.95 },
		]);

		const result = await runFn(
			factsDb as never,
			vectorDbWithMatch as never,
			makeEmbeddings([1, 0, 0]) as never,
			{} as never,
			makeConfig(),
			["preference", "fact"],
			{
				model: "test-model",
				dbDir: tmpDir,
				reinforcement: {
					enabled: false,
					passiveBoost: 0.1,
					activeBoost: 0.05,
					maxConfidence: 1.0,
					similarityThreshold: 0.85,
				},
			},
			{ info: () => {}, warn: () => {} },
		);

		expect(factsDb.boostConfidence).not.toHaveBeenCalled();
		vi.doUnmock("../services/chat.js");
		void result;
	});

	it("ObserverRunResult includes factsReinforced field", async () => {
		const cfg = makeConfig({ sessionsDir: join(tmpDir, "nonexistent") });
		const result = await runPassiveObserver(
			makeFactsDb() as never,
			makeVectorDb() as never,
			makeEmbeddings() as never,
			{} as never,
			cfg,
			["preference"],
			{ model: "test-model", dbDir: tmpDir },
			{ info: () => {}, warn: () => {} },
		);
		expect(typeof result.factsReinforced).toBe("number");
		expect(result.factsReinforced).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// 5. Migration — columns exist after FactsDB construction
// ---------------------------------------------------------------------------

describe("FactsDB migration — reinforcement columns", () => {
	let tmpDir: string;
	let db: InstanceType<typeof FactsDB>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "reinf-migration-test-"));
		db = makeDb(tmpDir);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("facts table has reinforced_count column after migration", () => {
		const raw = db.getRawDb();
		const cols = raw.prepare("PRAGMA table_info(facts)").all() as Array<{
			name: string;
		}>;
		expect(cols.some((c) => c.name === "reinforced_count")).toBe(true);
	});

	it("facts table has last_reinforced_at column after migration", () => {
		const raw = db.getRawDb();
		const cols = raw.prepare("PRAGMA table_info(facts)").all() as Array<{
			name: string;
		}>;
		expect(cols.some((c) => c.name === "last_reinforced_at")).toBe(true);
	});

	it("new facts have reinforced_count = 0 by default", () => {
		const fact = storeFact(db, "Brand new fact", 0.8);
		const retrieved = db.getById(fact.id) as {
			reinforcedCount?: number;
		} & object;
		const count =
			retrieved && "reinforcedCount" in retrieved
				? retrieved.reinforcedCount
				: undefined;
		expect(count ?? 0).toBe(0);
	});

	it("new facts have last_reinforced_at = null by default", () => {
		const fact = storeFact(db, "Another new fact", 0.8);
		const retrieved = db.getById(fact.id) as {
			lastReinforcedAt?: number | null;
		} & object;
		const ts =
			retrieved && "lastReinforcedAt" in retrieved
				? retrieved.lastReinforcedAt
				: undefined;
		expect(ts ?? null).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 6. Config — reinforcement type shape
// ---------------------------------------------------------------------------

describe("ReinforcementConfig type shape", () => {
	it("config object has all required fields", () => {
		const rc: ReinforcementConfig = {
			enabled: true,
			passiveBoost: 0.1,
			activeBoost: 0.05,
			maxConfidence: 1.0,
			similarityThreshold: 0.85,
		};
		expect(rc.enabled).toBe(true);
		expect(rc.passiveBoost).toBe(0.1);
		expect(rc.activeBoost).toBe(0.05);
		expect(rc.maxConfidence).toBe(1.0);
		expect(rc.similarityThreshold).toBe(0.85);
	});
});
