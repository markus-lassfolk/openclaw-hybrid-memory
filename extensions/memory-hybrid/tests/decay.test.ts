/**
 * Tests for classifyDecay — multilingual key/entity support (#597).
 *
 * Covers:
 * - English key/entity classification (regression)
 * - Non-English key matching via translated decayPermanentKeys/decayActiveKeys/decaySessionKeys/decayCheckpointKeys
 * - Non-English entity matching via translated decayPermanentEntities
 * - Text-based regex classification (existing behaviour)
 * - English-only fallback when no language file present
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDecay } from "../utils/decay.js";
import { setKeywordsPath, clearKeywordCache } from "../utils/language-keywords.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function langFile(translations: Record<string, Record<string, string[]>>) {
  return JSON.stringify({
    version: 1,
    detectedAt: new Date().toISOString(),
    topLanguages: Object.keys(translations),
    translations,
  });
}

// ---------------------------------------------------------------------------
// English-only (no language file)
// ---------------------------------------------------------------------------

describe("classifyDecay — English keys (regression)", () => {
  beforeEach(async () => {
    setKeywordsPath("");
    await clearKeywordCache();
  });

  it('key "email" → permanent', () => {
    expect(classifyDecay(null, "email", null, "user@example.com")).toBe("permanent");
  });

  it('key "api_key" → permanent', () => {
    expect(classifyDecay(null, "api_key", null, "secret")).toBe("permanent");
  });

  it('key "architecture" → permanent', () => {
    expect(classifyDecay(null, "architecture", null, "monolith")).toBe("permanent");
  });

  it('key "birthday" → permanent', () => {
    expect(classifyDecay(null, "birthday", null, "1990-01-01")).toBe("permanent");
  });

  it('key "phone" → permanent', () => {
    expect(classifyDecay(null, "phone", null, "+46123456789")).toBe("permanent");
  });

  it('entity "decision" → permanent', () => {
    expect(classifyDecay("decision", null, null, "we chose React")).toBe("permanent");
  });

  it('entity "convention" → permanent', () => {
    expect(classifyDecay("convention", null, null, "use camelCase")).toBe("permanent");
  });

  it('key "current_file" → session', () => {
    expect(classifyDecay(null, "current_file", null, "index.ts")).toBe("session");
  });

  it('key "debug" → session', () => {
    expect(classifyDecay(null, "debug", null, "true")).toBe("session");
  });

  it('key "task" → active', () => {
    expect(classifyDecay(null, "task", null, "fix bug")).toBe("active");
  });

  it('key "todo" → active', () => {
    expect(classifyDecay(null, "todo", null, "write tests")).toBe("active");
  });

  it('key "sprint" → active', () => {
    expect(classifyDecay(null, "sprint", null, "sprint-42")).toBe("active");
  });

  it('key "branch" → active', () => {
    expect(classifyDecay(null, "branch", null, "feat/foo")).toBe("active");
  });

  it('key "checkpoint" → checkpoint', () => {
    expect(classifyDecay(null, "checkpoint", null, "build passed")).toBe("checkpoint");
  });

  it('key "preflight_check" → checkpoint', () => {
    expect(classifyDecay(null, "preflight_check", null, "ok")).toBe("checkpoint");
  });

  it("null key, generic text → stable", () => {
    expect(classifyDecay(null, null, null, "some random info")).toBe("stable");
  });
});

// ---------------------------------------------------------------------------
// Text-based regex classification (existing behaviour, should be unchanged)
// ---------------------------------------------------------------------------

describe("classifyDecay — text-based regex (regression)", () => {
  beforeEach(async () => {
    setKeywordsPath("");
    await clearKeywordCache();
  });

  it('"we decided to use X" → permanent via text regex', () => {
    expect(classifyDecay(null, null, null, "we decided to use X")).toBe("permanent");
  });

  it('"currently debugging right now" → session via text regex', () => {
    expect(classifyDecay(null, null, null, "currently debugging right now")).toBe("session");
  });

  it('"need to finish the blocker" → active via text regex', () => {
    expect(classifyDecay(null, null, null, "need to finish the blocker")).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Non-English keys/entities — via translated language file (German)
// ---------------------------------------------------------------------------

describe("classifyDecay — non-English keys (German translation in file)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "decay-test-de-"));
    setKeywordsPath(tmpDir);
    writeFileSync(
      join(tmpDir, ".language-keywords.json"),
      langFile({
        de: {
          decayPermanentKeys: ["entscheidung", "architektur", "geburtsdatum", "standort"],
          decaySessionKeys: ["aktuelle_datei", "debuggen"],
          decayActiveKeys: ["aufgabe", "zweig", "sprint"],
          decayPermanentEntities: ["entscheidung", "konvention"],
          decayCheckpointKeys: ["kontrollpunkt"],
          triggers: [],
          categoryDecision: [],
          categoryPreference: [],
          categoryEntity: [],
          categoryFact: [],
          decayPermanent: [],
          decaySession: [],
          decayActive: [],
          correctionSignals: [],
          directiveSignals: [],
          directiveExplicitMemory: [],
          directiveFutureBehavior: [],
          directiveAbsoluteRule: [],
          directivePreference: [],
          directiveWarning: [],
          directiveProcedural: [],
          directiveImplicitCorrection: [],
          directiveConditionalRule: [],
          reinforcementSignals: [],
          reinforcementStrongPraise: [],
          reinforcementMethodConfirmation: [],
          reinforcementRelief: [],
          reinforcementComparativePraise: [],
          reinforcementSharingSignals: [],
        },
      }),
    );
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

  it('key "aufgabe" (German: task) → active', () => {
    expect(classifyDecay(null, "aufgabe", null, "Aufgabe erledigen")).toBe("active");
  });

  it('key "zweig" (German: branch) → active', () => {
    expect(classifyDecay(null, "zweig", null, "feat/foo")).toBe("active");
  });

  it('key "architektur" (German: architecture) → permanent', () => {
    expect(classifyDecay(null, "architektur", null, "Microservices")).toBe("permanent");
  });

  it('key "geburtsdatum" (German: birthday) → permanent', () => {
    expect(classifyDecay(null, "geburtsdatum", null, "1990-01-01")).toBe("permanent");
  });

  it('key "aktuelle_datei" (German: current_file) → session', () => {
    expect(classifyDecay(null, "aktuelle_datei", null, "index.ts")).toBe("session");
  });

  it('key "kontrollpunkt" (German: checkpoint) → checkpoint', () => {
    expect(classifyDecay(null, "kontrollpunkt", null, "passed")).toBe("checkpoint");
  });

  it('entity "entscheidung" (German: decision) → permanent', () => {
    expect(classifyDecay("entscheidung", null, null, "wir haben React gewählt")).toBe("permanent");
  });

  it('entity "konvention" (German: convention) → permanent', () => {
    expect(classifyDecay("konvention", null, null, "camelCase verwenden")).toBe("permanent");
  });
});

// ---------------------------------------------------------------------------
// Non-English keys/entities — via translated language file (French)
// ---------------------------------------------------------------------------

describe("classifyDecay — non-English keys (French translation in file)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "decay-test-fr-"));
    setKeywordsPath(tmpDir);
    writeFileSync(
      join(tmpDir, ".language-keywords.json"),
      langFile({
        fr: {
          decayPermanentKeys: ["décision", "architecture", "anniversaire", "emplacement"],
          decaySessionKeys: ["fichier_courant", "debogage"],
          decayActiveKeys: ["tâche", "branche", "sprint"],
          decayPermanentEntities: ["décision", "convention"],
          decayCheckpointKeys: ["point_de_contrôle"],
          triggers: [],
          categoryDecision: [],
          categoryPreference: [],
          categoryEntity: [],
          categoryFact: [],
          decayPermanent: [],
          decaySession: [],
          decayActive: [],
          correctionSignals: [],
          directiveSignals: [],
          directiveExplicitMemory: [],
          directiveFutureBehavior: [],
          directiveAbsoluteRule: [],
          directivePreference: [],
          directiveWarning: [],
          directiveProcedural: [],
          directiveImplicitCorrection: [],
          directiveConditionalRule: [],
          reinforcementSignals: [],
          reinforcementStrongPraise: [],
          reinforcementMethodConfirmation: [],
          reinforcementRelief: [],
          reinforcementComparativePraise: [],
          reinforcementSharingSignals: [],
        },
      }),
    );
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

  it('key "tâche" (French: task) → active', () => {
    expect(classifyDecay(null, "tâche", null, "finir la tâche")).toBe("active");
  });

  it('key "branche" (French: branch) → active', () => {
    expect(classifyDecay(null, "branche", null, "feat/foo")).toBe("active");
  });

  it('key "anniversaire" (French: birthday) → permanent', () => {
    expect(classifyDecay(null, "anniversaire", null, "1990-01-01")).toBe("permanent");
  });

  it('entity "décision" (French: decision) → permanent', () => {
    expect(classifyDecay("décision", null, null, "nous avons choisi React")).toBe("permanent");
  });
});
