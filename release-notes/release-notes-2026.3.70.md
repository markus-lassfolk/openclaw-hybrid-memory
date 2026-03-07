## 2026.3.70 (2026-03-07)

Major release: Hybrid Memory redesign (Milestones A, B, C), CI/CD with automatic NPM publishing via Trusted Publishing, search/config improvements, and quality fixes.

---

### What’s in this release

- **Memory-first redesign (Milestone A)** — Dynamic tiering, multi-agent scoping, and workflow hooks.
- **Smarter recall (Milestone B)** — Retrieval directives, entity/keyword/task-type triggers, and agent-scoped memory.
- **Workflow crystallization & self-extension (Milestone C)** — Tool-sequence patterns, skill proposals, and tool proposals from usage gaps.
- **Scope promote** — New CLI to promote important session facts to long-term (global) memory.
- **CI/CD** — Full GitHub Actions pipeline and automatic NPM publish for both packages (Trusted Publishing, no tokens).
- **Config cleanup** — queryExpansion replaces deprecated HyDE options; error reporting defaults to opt-out.

---

### Added (details)

#### Milestone A — Complete Hybrid Memory Redesign (#198)

- **Dynamic memory tiering (hot/warm/cold):** Facts are tiered by recency and access. Config: `memoryTiering.enabled`, `hotMaxTokens` (default 2000), `compactionOnSessionEnd` (default true), `inactivePreferenceDays` (default 7), `hotMaxFacts` (default 50). Presets *normal*, *expert*, and *full* enable tiering with sensible defaults.
- **Multi-agent scoping:** Facts can be stored as global, user-, agent-, or session-scoped. Config: `multiAgent.orchestratorId` (default `"main"`), `multiAgent.defaultStoreScope` (`global` | `agent` | `auto`). With `auto`, the orchestrator stores globally and specialists store per-agent. Runtime agent ID is detected from context so the right scope is applied automatically.
- **Workflow integration:** Session start/end and compaction hooks use tiering and scope so recall and storage stay consistent with the new model.

#### Milestone B — Memory-first features (#221)

- **Retrieval directives:** Besides semantic auto-recall, you can trigger targeted recall by:
  - **Entity mentioned:** When the prompt mentions an entity from a list, run a targeted recall for that entity.
  - **Keywords:** Case-insensitive keyword triggers.
  - **Task types:** Map task types to keyword triggers.
  - **Session start:** Optional one-time recall when a new session starts.
  Config: `autoRecall.retrievalDirectives` with `enabled`, `entityMentioned`, `keywords`, `taskTypes`, `sessionStart`, `limit` (default 3), `maxPerPrompt` (default 4).
- **Agent-scoped memory:** Recall and injection respect scope filters so specialist agents see only facts relevant to their scope (and global facts).

#### Milestone C — Workflow crystallization and self-extension (#208, #209, #210)

- **Tool-sequence tracking:** The plugin records which tool sequences are used and how often they succeed. Patterns are grouped by similar sequences with success rates and usage counts.
- **`memory_workflows` tool:** The agent can query these patterns by a natural-language goal (keyword-matched). Options: `goal`, `minSuccessRate` (0–1), `limit`. Returns patterns grouped by similar tool sequences so the agent can reuse what works.
- **Crystallization (skill proposals):**  
  - **`memory_crystallize`** — Runs a cycle that analyses workflow patterns and generates pending AgentSkill SKILL.md proposals. No skills are written until a human approves.  
  - **`memory_crystallize_list`** — Lists pending, approved, and rejected proposals.  
  - **`memory_crystallize_approve`** / **`memory_crystallize_reject`** — Approve (writes skill to disk) or reject a proposal.  
  Requires configuration for crystallization store and workflow store.
- **Self-extension (tool proposals):**  
  - **`memory_propose_tool`** — Analyses workflow traces for recurring multi-step workarounds and generates tool proposals (specifications for a human or LLM to implement). Optional params: `minFrequency`, `minToolSavings`.  
  - **`memory_tool_proposals`** — Lists current tool proposals and status.  
  - **`memory_tool_approve`** / **`memory_tool_reject`** — Approve or reject a proposal.  
  Requires `selfExtension.enabled: true` in config; config supports `minFrequency`, `minToolSavings`.

#### Scope promote CLI (#134)

- **Command:** `openclaw hybrid-mem scope promote`
- **Purpose:** Promote high-importance session-scoped facts to global scope so they persist across sessions and are available to all agents.
- **Options:**
  - `--dry-run` — Show which facts would be promoted without changing anything.
  - `--threshold-days <n>` — Only consider session facts at least this many days old (default: 7).
  - `--min-importance <n>` — Minimum importance score 0–1 (default: 0.7).
- **Example:** `openclaw hybrid-mem scope promote --threshold-days 7 --min-importance 0.7`
- **Automation:** The weekly-deep-maintenance cron job (Saturday 04:00) runs `compact` then `scope promote`; you can rely on that or run promote manually.

#### CI/CD and NPM publishing

- **CI workflow** runs on every push to main and relevant branches and on every PR: Type check (Node 22 and 24), lint, test, and test coverage (with uploaded artifact).
- **Release workflow** runs when you push a tag `v*` (e.g. `v2026.3.70`) or when you trigger it manually with a version. It runs CI, creates a GitHub Release with generated notes, then publishes both packages to NPM:
  - **openclaw-hybrid-memory** (main plugin from `extensions/memory-hybrid`)
  - **openclaw-hybrid-memory-install** (standalone installer from `packages/openclaw-hybrid-memory-install`)
- **NPM Trusted Publishing:** No long-lived tokens. Publishing uses OIDC (OpenID Connect) with GitHub Actions. You keep MFA enabled on npm; configure Trusted Publisher on npmjs.com for each package with workflow filename **`release.yml`**. After that, every release tag automatically publishes both packages.

#### Security and quality

- **CodeQL** workflow for security and code-quality scanning.
- **Dependabot** config for dependency updates.
- **Branch protection** recommendations documented.
- **Labeler** workflow applies labels to PRs from `.github/labeler.yml`.

---

### Changed (details)

#### Search: queryExpansion replaces HyDE (#228, #160)

- **Deprecated:** `search.hydeEnabled` and `search.hydeModel`.
- **New config:** Top-level `queryExpansion.enabled` and `queryExpansion.model`.
- **Migration:** If you still have `search.hydeEnabled: true`, the plugin auto-enables `queryExpansion` and uses `search.hydeModel` (or the nano-tier model) for the expansion model. You’ll see a deprecation warning in the logs; updating your config to use `queryExpansion` removes it. If you explicitly set `queryExpansion.enabled: false`, that overrides the old HyDE flag.
- **Preset:** The *full* preset now sets `queryExpansion.enabled: true` directly instead of via HyDE.
- **Timeouts:** When migrating from HyDE the expansion timeout stays 25s; when using `queryExpansion` directly the default is 5s (configurable).

#### Error reporting: opt-out defaults

- If you don’t set `errorReporting` in config, it now defaults to **enabled** with **consent** true (community mode, hardcoded DSN for anonymous crash reporting).
- To **opt out**, set `errorReporting.enabled: false` or `errorReporting.consent: false` in your plugin config.

#### Dependencies and repo quality

- GitHub Actions: `actions/setup-node`, `actions/cache`, `actions/checkout` → v6; `actions/upload-artifact` → v7; `github/codeql-action` → v4. npm dependency group minor-and-patch bumped.
- ESLint and Prettier config added; repo aligned with Yarbo standards. TypeScript strict mode issues resolved across the codebase.

---

### Fixed (summary)

- **Promotion:** Corrected inconsistent `superseded_at` filter in the logic that selects session facts eligible for scope promote.
- **Verify:** `agents.defaults.pruning` is now correctly reported as invalid (unsupported) in `openclaw hybrid-mem verify`.
- **Config:** The safe-config-write allowlist now includes `"env"` so env-based config keys can be written via `config-set`.
- **CI:** Coverage provider and CodeQL setup fixed; required labels created; label and comment APIs paginated to avoid rate limits and duplicate bot comments; workflow security and code quality improved; size-label flapping fixed.
- **Query expansion:** HyDE timeout behaviour made consistent; queryExpansion migration edge cases and model fallback fixed; tests updated per review.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.3.70
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.3.70
```

Restart the gateway after upgrading.
