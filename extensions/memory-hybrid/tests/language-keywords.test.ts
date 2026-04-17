import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ENGLISH_KEYWORDS,
	type KeywordGroup,
	clearKeywordCache,
	getCategoryDecisionRegex,
	getCategoryEntityRegex,
	getCategoryFactRegex,
	getCategoryPreferenceRegex,
	getCorrectionSignalRegex,
	getDecayActiveRegex,
	getDecayPermanentRegex,
	getDecaySessionRegex,
	getDirectiveCategoryRegexes,
	getKeywordsPath,
	getLanguageKeywordsFilePath,
	getMemoryTriggerRegexes,
	getReinforcementCategoryRegexes,
	getReinforcementSignalRegex,
	getUserFeedbackPhrasesPath,
	loadMergedKeywords,
	loadUserFeedbackPhrases,
	saveUserFeedbackPhrases,
	setKeywordsPath,
} from "../utils/language-keywords.js";

describe("language-keywords", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "lang-kw-test-"));
		await clearKeywordCache();
	});

	afterEach(async () => {
		await clearKeywordCache();
		setKeywordsPath("");
		try {
			if (tmpDir) rmSync(tmpDir, { recursive: true });
		} catch {
			// ignore
		}
	});

	describe("setKeywordsPath / getKeywordsPath / getLanguageKeywordsFilePath", () => {
		it("getKeywordsPath returns null when cleared with empty string", () => {
			setKeywordsPath("");
			expect(getKeywordsPath()).toBeNull();
		});

		it("getLanguageKeywordsFilePath returns path after setKeywordsPath", () => {
			setKeywordsPath(tmpDir);
			expect(getLanguageKeywordsFilePath()).toBe(
				join(tmpDir, ".language-keywords.json"),
			);
		});

		it("getLanguageKeywordsFilePath returns null when path not set", () => {
			setKeywordsPath("");
			expect(getLanguageKeywordsFilePath()).toBeNull();
		});
	});

	describe("loadMergedKeywords", () => {
		it("returns English only when path not set", () => {
			setKeywordsPath("");
			const merged = loadMergedKeywords();
			expect(merged.triggers).toEqual([...ENGLISH_KEYWORDS.triggers]);
			expect(merged.categoryDecision).toEqual([
				...ENGLISH_KEYWORDS.categoryDecision,
			]);
		});

		it("returns English only when path set but file missing", () => {
			setKeywordsPath(tmpDir);
			const merged = loadMergedKeywords();
			expect(merged.triggers).toContain("remember");
			expect(merged.triggers).toContain("prefer");
			expect(merged.triggers.length).toBe(ENGLISH_KEYWORDS.triggers.length);
		});

		it("merges English and file translations when file exists", async () => {
			setKeywordsPath(tmpDir);
			const filePath = join(tmpDir, ".language-keywords.json");
			writeFileSync(
				filePath,
				JSON.stringify({
					version: 1,
					detectedAt: new Date().toISOString(),
					topLanguages: ["en", "sv"],
					translations: {
						sv: {
							triggers: ["kom ihåg", "föredrar"],
							categoryDecision: ["bestämde", "valde"],
							categoryPreference: ["föredrar", "gillar"],
							categoryEntity: ["heter"],
							categoryFact: ["född", "bor"],
							decayPermanent: ["bestämde"],
							decaySession: ["just nu"],
							decayActive: ["behöver"],
							correctionSignals: ["du missförstod"],
						},
					},
				}),
				"utf8",
			);
			await clearKeywordCache();
			const merged = loadMergedKeywords();
			expect(merged.triggers).toContain("remember");
			expect(merged.triggers).toContain("kom ihåg");
			expect(merged.triggers).toContain("föredrar");
			expect(merged.categoryPreference).toContain("gillar");
			expect(merged.correctionSignals).toContain("du missförstod");
		});

		it("uses cache when file path unchanged", async () => {
			setKeywordsPath(tmpDir);
			writeFileSync(
				join(tmpDir, ".language-keywords.json"),
				JSON.stringify({
					version: 1,
					detectedAt: new Date().toISOString(),
					topLanguages: ["sv"],
					translations: { sv: { triggers: ["cached"] } },
				}),
				"utf8",
			);
			await clearKeywordCache();
			const first = loadMergedKeywords();
			const second = loadMergedKeywords();
			expect(second.triggers).toContain("cached");
			expect(first).toBe(second);
		});

		it("clearKeywordCache forces reload on next loadMergedKeywords", async () => {
			setKeywordsPath(tmpDir);
			writeFileSync(
				join(tmpDir, ".language-keywords.json"),
				JSON.stringify({
					version: 1,
					detectedAt: new Date().toISOString(),
					topLanguages: ["sv"],
					translations: { sv: { triggers: ["first"] } },
				}),
				"utf8",
			);
			await clearKeywordCache();
			loadMergedKeywords();
			writeFileSync(
				join(tmpDir, ".language-keywords.json"),
				JSON.stringify({
					version: 1,
					detectedAt: new Date().toISOString(),
					topLanguages: ["sv"],
					translations: { sv: { triggers: ["second"] } },
				}),
				"utf8",
			);
			const before = loadMergedKeywords();
			expect(before.triggers).toContain("first");
			await clearKeywordCache();
			const after = loadMergedKeywords();
			expect(after.triggers).toContain("second");
		});
	});

	describe("getMemoryTriggerRegexes", () => {
		it("returns array of RegExp", () => {
			setKeywordsPath("");
			const regexes = getMemoryTriggerRegexes();
			expect(Array.isArray(regexes)).toBe(true);
			expect(regexes.length).toBeGreaterThan(0);
			regexes.forEach((r) => expect(r).toBeInstanceOf(RegExp));
		});

		it("matches English trigger phrase", () => {
			setKeywordsPath("");
			const regexes = getMemoryTriggerRegexes();
			const hasRemember = regexes.some((r) =>
				r.test("I want you to remember this"),
			);
			expect(hasRemember).toBe(true);
		});
	});

	describe("getCategoryDecisionRegex", () => {
		it("matches English decision phrase", () => {
			setKeywordsPath("");
			const re = getCategoryDecisionRegex();
			expect(re.test("we decided to use typescript")).toBe(true);
		});

		it("matches Swedish when in merged keywords", async () => {
			setKeywordsPath(tmpDir);
			writeFileSync(
				join(tmpDir, ".language-keywords.json"),
				JSON.stringify({
					version: 1,
					detectedAt: new Date().toISOString(),
					topLanguages: ["sv"],
					translations: { sv: { categoryDecision: ["bestämde", "valde"] } },
				}),
				"utf8",
			);
			await clearKeywordCache();
			const re = getCategoryDecisionRegex();
			expect(re.test("vi bestämde att använda det")).toBe(true);
		});
	});

	describe("getCategoryPreferenceRegex", () => {
		it("matches English preference", () => {
			setKeywordsPath("");
			expect(getCategoryPreferenceRegex().test("I prefer dark mode")).toBe(
				true,
			);
		});
	});

	describe("getCategoryEntityRegex", () => {
		it("matches email and phone", () => {
			setKeywordsPath("");
			const re = getCategoryEntityRegex();
			expect(re.test("user@example.com")).toBe(true);
			expect(re.test("+46123456789")).toBe(true);
		});
	});

	describe("getCategoryFactRegex", () => {
		it("matches English fact phrase", () => {
			setKeywordsPath("");
			expect(getCategoryFactRegex().test("born in 1990")).toBe(true);
		});
	});

	describe("getDecayPermanentRegex", () => {
		it("matches decided / architecture", () => {
			setKeywordsPath("");
			const re = getDecayPermanentRegex();
			expect(re.test("we decided to use X")).toBe(true);
		});
	});

	describe("getDecaySessionRegex", () => {
		it("matches right now", () => {
			setKeywordsPath("");
			expect(getDecaySessionRegex().test("currently debugging right now")).toBe(
				true,
			);
		});
	});

	describe("getDecayActiveRegex", () => {
		it("matches todo / blocker", () => {
			setKeywordsPath("");
			const re = getDecayActiveRegex();
			expect(re.test("working on a todo")).toBe(true);
		});
	});

	describe("getCorrectionSignalRegex", () => {
		it("matches English correction phrase", () => {
			setKeywordsPath("");
			const re = getCorrectionSignalRegex();
			expect(re.test("you misunderstood what I said")).toBe(true);
		});

		it("matches negative emoji and user-saved correction phrases when path set", () => {
			setKeywordsPath(tmpDir);
			clearKeywordCache();
			saveUserFeedbackPhrases({
				reinforcement: [],
				correction: ["my custom nope", "exactly wrong"],
			});
			const re = getCorrectionSignalRegex();
			expect(re.test("👎")).toBe(true);
			expect(re.test("😠")).toBe(true);
			expect(re.test("my custom nope")).toBe(true);
			expect(re.test("that was exactly wrong")).toBe(true);
		});
	});

	describe("getReinforcementSignalRegex", () => {
		it("matches positive emoji and user-saved reinforcement phrases when path set", () => {
			setKeywordsPath(tmpDir);
			clearKeywordCache();
			saveUserFeedbackPhrases({
				reinforcement: ["spot on", "perfect match"],
				correction: [],
			});
			const re = getReinforcementSignalRegex();
			expect(re.test("👍")).toBe(true);
			expect(re.test("❤️")).toBe(true);
			expect(re.test("spot on")).toBe(true);
			expect(re.test("that was a perfect match")).toBe(true);
		});
	});

	describe("user feedback phrases (save/load round-trip)", () => {
		it("getUserFeedbackPhrasesPath returns null when path not set", () => {
			setKeywordsPath("");
			expect(getUserFeedbackPhrasesPath()).toBeNull();
		});

		it("getUserFeedbackPhrasesPath returns path under keywords dir when set", () => {
			setKeywordsPath(tmpDir);
			expect(getUserFeedbackPhrasesPath()).toBe(
				join(tmpDir, ".user-feedback-phrases.json"),
			);
		});

		it("loadUserFeedbackPhrases returns empty when file missing", () => {
			setKeywordsPath(tmpDir);
			clearKeywordCache();
			const loaded = loadUserFeedbackPhrases();
			expect(loaded.reinforcement).toEqual([]);
			expect(loaded.correction).toEqual([]);
		});

		it("saveUserFeedbackPhrases then loadUserFeedbackPhrases round-trips data", () => {
			setKeywordsPath(tmpDir);
			clearKeywordCache();
			const data = {
				reinforcement: ["great", "thanks"],
				correction: ["nope", "wrong"],
			};
			saveUserFeedbackPhrases(data);
			const loaded = loadUserFeedbackPhrases();
			expect(loaded.reinforcement).toEqual(["great", "thanks"]);
			expect(loaded.correction).toEqual(["nope", "wrong"]);
			expect(loaded.updatedAt).toBeDefined();
			expect(loaded.initialRunDone).toBe(true);
		});
	});

	describe("ENGLISH_KEYWORDS", () => {
		it("has all expected keyword groups", () => {
			const groups: KeywordGroup[] = [
				"triggers",
				"categoryDecision",
				"categoryPreference",
				"categoryEntity",
				"categoryFact",
				"decayPermanent",
				"decaySession",
				"decayActive",
				"correctionSignals",
			];
			groups.forEach((g) => {
				expect(ENGLISH_KEYWORDS[g]).toBeDefined();
				expect(Array.isArray(ENGLISH_KEYWORDS[g])).toBe(true);
			});
		});
	});

	describe("directiveSignalsByCategory and reinforcementCategories", () => {
		it("merges directiveSignalsByCategory from file into merged keywords", async () => {
			setKeywordsPath(tmpDir);
			writeFileSync(
				join(tmpDir, ".language-keywords.json"),
				JSON.stringify({
					version: 2,
					detectedAt: new Date().toISOString(),
					topLanguages: ["en"],
					translations: {},
					directiveSignalsByCategory: {
						explicit_memory: ["remember that", "muista että"],
						future_behavior: ["from now on", "tästä lähtien"],
					},
				}),
				"utf8",
			);
			await clearKeywordCache();
			const merged = loadMergedKeywords();
			expect(merged.directiveExplicitMemory).toContain("remember that");
			expect(merged.directiveExplicitMemory).toContain("muista että");
			expect(merged.directiveFutureBehavior).toContain("tästä lähtien");
			const regexes = getDirectiveCategoryRegexes();
			expect(regexes.explicit_memory.test("muista että käytä v2")).toBe(true);
		});

		it("merges reinforcementCategories from file and uses genericPoliteness", async () => {
			setKeywordsPath(tmpDir);
			writeFileSync(
				join(tmpDir, ".language-keywords.json"),
				JSON.stringify({
					version: 2,
					detectedAt: new Date().toISOString(),
					topLanguages: ["en"],
					translations: {},
					reinforcementCategories: {
						strongPraise: ["perfect", "täydellinen"],
						genericPoliteness: ["thanks", "kiitos", "ok"],
					},
				}),
				"utf8",
			);
			await clearKeywordCache();
			const merged = loadMergedKeywords();
			expect(merged.reinforcementStrongPraise).toContain("perfect");
			expect(merged.reinforcementStrongPraise).toContain("täydellinen");
			const regexes = getReinforcementCategoryRegexes();
			expect(regexes.strongPraise.test("täydellinen!")).toBe(true);
			expect(regexes.genericPoliteness.test("kiitos")).toBe(true);
			expect(regexes.genericPoliteness.test("ok")).toBe(true);
		});
	});
});
