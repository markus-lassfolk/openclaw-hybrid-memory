/**
 * Skill section taxonomy — single source of truth for required SKILL.md section
 * names, aliases, and per-category overrides (issues #1375, #1408).
 *
 * Both SkillValidator and GeneratedSkillValidationService import from here to
 * guarantee identical pass/fail outcomes when validating the same SKILL.md content.
 *
 * ## Design
 * - `DEFAULT_REQUIRED_SECTIONS` is the canonical list used by all skill categories
 *   unless a category-specific override is registered in `CATEGORY_SECTION_TAXONOMIES`.
 * - Alias matching is case-insensitive and punctuation-normalised (same rules as
 *   SkillValidator's `parseH2Headings`/`hasHeadingAlias` helpers).
 * - `MAX_SKILL_LINES` is the shared line-length cap applied by both validators.
 *
 * ## Extending
 * To add a new skill category with different required sections, add an entry to
 * `CATEGORY_SECTION_TAXONOMIES` and export it. Do NOT edit `DEFAULT_REQUIRED_SECTIONS`
 * unless you also update the crystallizer template and all related tests.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SectionDefinition {
  /** Stable machine identifier — used in error messages and tests. */
  id: string;
  /** Human-readable canonical label shown in validation error messages. */
  label: string;
  /**
   * Heading text that counts as satisfying this requirement. Validators normalize
   * these aliases before comparing them with the normalized heading text from
   * `parseH2Headings()`, so entries may use readable casing and punctuation.
   */
  aliases: string[];
}

/**
 * Project-level taxonomy override map. Keys are category identifiers; use
 * `default` to replace the default taxonomy for categories without a specific
 * override. Each value replaces the inherited taxonomy for that category.
 */
export type SectionTaxonomyOverrides = Record<string, SectionDefinition[]>;

// ---------------------------------------------------------------------------
// Shared line-limit constant (issue #1366)
// ---------------------------------------------------------------------------

/**
 * Maximum number of lines allowed in a SKILL.md file.
 * Used by BOTH SkillValidator and GeneratedSkillValidationService.
 */
export const MAX_SKILL_LINES = 300;

export {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_BYTES_SAFE,
  MAX_RECIPE_JSON_BYTES,
  MAX_WORKFLOW_STEPS_IN_SKILL,
  MAX_STEP_SUMMARY_CHARS,
} from "./skill-size-limits.js";

// ---------------------------------------------------------------------------
// Shared category frontmatter keys
// ---------------------------------------------------------------------------

/**
 * Alternate frontmatter keys that resolve to "category" semantics.
 * Used by BOTH SkillValidator and GeneratedSkillValidationService when
 * extracting category information from skill frontmatter.
 * Order matters: earlier keys take precedence in fallback chains.
 */
export const CATEGORY_FRONTMATTER_KEYS = ["category", "categories", "tags", "type", "kind"] as const;

// ---------------------------------------------------------------------------
// Default required-section taxonomy
// ---------------------------------------------------------------------------

/**
 * Unified required-section definitions for all standard skill categories.
 *
 * Supersedes:
 * - SkillValidator's inline `requiredSections` array (which lacked Scope and Provenance)
 * - GeneratedSkillValidationService's `REQUIRED_SECTIONS` exact-match list (which
 *   lacked Verification and Anti-patterns, and used brittle exact-string matching)
 *
 * The crystallizer template (skill-crystallizer.ts) emits all eight sections below;
 * any future changes to the template must keep the aliases here in sync.
 */
export const DEFAULT_REQUIRED_SECTIONS: SectionDefinition[] = [
  {
    id: "trigger",
    label: "Trigger",
    aliases: ["trigger", "when to activate", "when to use"],
  },
  {
    id: "scope",
    label: "Scope",
    aliases: ["scope"],
  },
  {
    id: "when-not-to-use",
    label: "When not to use",
    aliases: ["when not to use", "do not use when", "do not use", "anti-activation conditions"],
  },
  {
    id: "workflow",
    label: "Workflow",
    aliases: ["workflow", "steps"],
  },
  {
    id: "verification",
    label: "Verification",
    aliases: ["verification", "quality checklist", "validation"],
  },
  {
    id: "anti-patterns",
    label: "Anti-patterns / Known Failures",
    aliases: ["anti-patterns / known failures", "anti-patterns", "known failures"],
  },
  {
    id: "examples",
    label: "Examples",
    aliases: ["examples"],
  },
  {
    id: "provenance",
    label: "Provenance",
    aliases: ["provenance"],
  },
];

// ---------------------------------------------------------------------------
// Per-category taxonomy overrides (issue #1408)
// ---------------------------------------------------------------------------

/**
 * Per-category section taxonomy overrides.
 * Keys are skill category identifiers (e.g. "procedure-skill", "explain-skill").
 * When a category is listed here, its section list REPLACES the default for that
 * category — it is NOT merged.  To extend the default, spread DEFAULT_REQUIRED_SECTIONS
 * and add your extra entries.
 *
 * @example
 * ```ts
 * CATEGORY_SECTION_TAXONOMIES["explain-skill"] = [
 *   ...DEFAULT_REQUIRED_SECTIONS,
 *   { id: "risk", label: "Risk", aliases: ["risk", "risks"] },
 * ];
 * ```
 */
export const CATEGORY_SECTION_TAXONOMIES: Record<string, SectionDefinition[]> = {
  procedure: [
    {
      id: "when-not-to-use",
      label: "When not to use",
      aliases: ["when not to use", "do not use when", "do not use", "anti-activation conditions"],
    },
    {
      id: "workflow",
      label: "Workflow",
      aliases: ["workflow", "steps"],
    },
    {
      id: "verification",
      label: "Verification",
      aliases: ["verification", "quality checklist", "validation"],
    },
    {
      id: "examples",
      label: "Examples",
      aliases: ["examples"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Accessor helper
// ---------------------------------------------------------------------------

/**
 * Returns the required section definitions for the given category.
 * Falls back to DEFAULT_REQUIRED_SECTIONS when no category-specific override is
 * registered or when `category` is undefined / empty.
 */
export function getSectionTaxonomy(
  category?: string,
  projectOverrides?: SectionTaxonomyOverrides,
): SectionDefinition[] {
  const projectCategoryOverride = category ? projectOverrides?.[category] : undefined;
  if (projectCategoryOverride && projectCategoryOverride.length > 0) return projectCategoryOverride;

  const projectDefaultOverride = projectOverrides?.default;
  if (projectDefaultOverride && projectDefaultOverride.length > 0) return projectDefaultOverride;

  if (category && CATEGORY_SECTION_TAXONOMIES[category] != null) {
    const override = CATEGORY_SECTION_TAXONOMIES[category];
    if (override.length > 0) return override;
  }
  return DEFAULT_REQUIRED_SECTIONS;
}
