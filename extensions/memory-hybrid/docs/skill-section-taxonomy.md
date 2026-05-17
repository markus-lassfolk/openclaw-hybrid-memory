# Skill section taxonomy overrides

Generated SKILL.md validation uses the shared section taxonomy in `config/skill-sections.ts` by default. Projects can replace that taxonomy without code changes through `crystallization.sectionTaxonomy`.

The map is keyed by skill category. Use `default` to replace the fallback taxonomy for categories without a specific override. Each configured array replaces the inherited list, so include every section the category should require.

```json
{
  "crystallization": {
    "sectionTaxonomy": {
      "default": [
        { "id": "trigger", "label": "Trigger", "aliases": ["trigger", "when to activate"] },
        { "id": "workflow", "label": "Workflow", "aliases": ["workflow", "steps"] },
        { "id": "risk", "label": "Risk", "aliases": ["risk", "risks"] },
        { "id": "examples", "label": "Examples", "aliases": ["examples"] }
      ],
      "explain-skill": [
        { "id": "trigger", "label": "Trigger", "aliases": ["trigger", "when to use"] },
        { "id": "explanation", "label": "Explanation", "aliases": ["explanation", "how it works"] },
        { "id": "examples", "label": "Examples", "aliases": ["examples"] }
      ]
    }
  }
}
```

Both `SkillValidator` and `GeneratedSkillValidationService` receive the parsed project overrides, so `skills validate`, `skills install --dry-run`, and `skills install` agree on section requirements.
