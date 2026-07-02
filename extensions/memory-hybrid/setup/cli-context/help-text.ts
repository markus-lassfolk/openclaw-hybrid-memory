/** Help text shown after hybrid-mem commands list */
export const HYBRID_MEM_HELP_GROUPED = `
Commands by category:

  Getting Started (new users start here!)
    setup                Interactive setup wizard for first-time configuration
    demo                 Try the system with sample data (shows semantic search, FTS, categories)
    help                 Curated guide to common workflows (like git help)
    examples [category]  Show common command examples (basics, setup, maintenance, advanced)
    providers            List available embedding providers and their status
    health               Quick health check with traffic-light indicators
    doctor               Run full diagnostics and detect common issues

  Setup & installation
    install              Apply recommended config and defaults (run after first setup)
    verify               Verify infrastructure and functionality (DBs, embedding API, jobs); use --fix to apply defaults
    config               Show current configuration and feature toggles (use config-set to change)

  Grouped namespaces (preferred — use <group> --help for subcommands)
    distill              Session distillation and extraction (run, window, record, extract-*)
    reflect              Reflection pipeline (patterns, rules, meta, identity, dream)
    storage              Vector and SQLite storage (stats, compact, optimize, reembed, re-index, …)
    quality              Data quality (duplicates, consolidate, contradictions, classify, enrich, …)
    learn                Self-correction and feedback learning (self-correction, feedback, implicit, …)
    maintenance          Cron, backfill, run-all, coverage, analyze-logs, cron-health, …

  Daily use
    search <query>       Hybrid search (vector + SQL)
    lookup <id>          Get fact by ID
    show <id>            Show fact or proposal by ID
    store <text>         Store a fact (options: --category, --entity, --key, --value)
    status               Unified health dashboard

  Stats & query
    dashboard            Memory dashboard summary
    dump                 Print rows from a SQLite table (--type, --limit, --order, --json)
    categories           List categories present in memory

  Proposals & corrections
    proposals list       List persona proposals (--status)
    proposals show <id>  Show full proposal (--json, --diff)
    proposals approve/reject <id>
    corrections list     List pending corrections from last report
    corrections approve-all   Apply all TOOLS/AGENTS rules from report

  Store & ingestion
    ingest-files         Ingest workspace files (--paths for specific files)
    backfill             Seed memory from workspace Markdown/text files
    generate-auto-skills Generate skills from procedures
    generate-proposals   Generate persona proposals from reflection (--dry-run, --verbose)
    skills …             Generated skill management (see skills --help)

  Export & config
    export               Export to MEMORY.md / memory/ (--output)
    config-mode <mode>   Set memory mode
    config-set <key> <value>

  Credentials & scope
    credentials migrate-to-vault
    scope list|stats|prune|promote

  Contacts (structured profile enrichment, #2014)
    contacts list|suggest-merges
    contacts merge <fromId> <intoId>
    contacts import|sync --from <file>

  Plugin lifecycle
    --version            Show installed version (update notice when npm/GitHub are newer)
    version              Detailed version info (GitHub, npm, --json)
    upgrade [version]    Upgrade to version or latest
    uninstall            Remove plugin (--clean-all, --leave-config)
    backup               Create a point-in-time snapshot (SQLite + LanceDB)
    backup verify        Check SQLite integrity without creating a backup

  Deprecated flat aliases (still work; stderr warning only)
    run-all, stats, tier-compact, reflect, find-duplicates, extract-daily, backfill-*-*, …
    Prefer grouped names: maintenance run-all, storage stats, reflect patterns, quality duplicates, …
`;

export const HYBRID_MEM_HELP_ACTIVE_TASKS = `
  Goals & working memory
    goals config                   Show goal stewardship settings (goalStewardship.*); toggle: config-set goalStewardship
    goals list | status [label] | audit | …  Tracked goals (status alone = overview; status <label> = detail)
    active-tasks config            Show active-task settings (activeTask.*)
    active-tasks                   List tasks. When activeTask.enabled is false, only config works
    active-tasks complete <label>  Mark task as Done and flush to memory log
    active-tasks stale             Show tasks not updated within staleThreshold
    active-tasks reconcile         Complete in-progress rows whose session transcript is gone (#978)
    active-tasks add <label> <desc>  Add or update a task entry
    active-tasks render            Write ACTIVE-TASKS.md from facts (when activeTask.ledger: facts)
    task-queue-status            Print task-queue JSON + recognized flag; --with-active-tasks (#1037)
    task-queue-touch             Create idle current.json if missing; --repair for bad snapshots (#1037)
`;

/**
 * Root command descriptor for OpenClaw lazy CLI registration (parse-time contract).
 * Subcommands are registered when the full plugin `register()` runs or when the lazy CLI fires.
 */
export const HYBRID_MEM_CLI_ROOT_DESCRIPTOR = {
  name: "hybrid-mem",
  description: "Hybrid memory (SQLite + LanceDB): maintenance, verify, search, diagnostics, and ingestion",
  hasSubcommands: true,
};
