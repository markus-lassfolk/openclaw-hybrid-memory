/** Help text shown after hybrid-mem commands list */
export const HYBRID_MEM_HELP_GROUPED = `
Commands by category:

  Getting Started (new users start here!)
    setup                Interactive setup wizard for first-time configuration
    demo                 Try the system with sample data (shows semantic search, FTS, categories)
    examples [category]  Show common command examples (basics, setup, maintenance, advanced)
    providers            List available embedding providers and their status
    health               Quick health check with traffic-light indicators 🟢🟡🔴
    doctor               Run full diagnostics and detect common issues

  Setup & installation
    install              Apply recommended config and defaults (run after first setup)
    verify               Verify infrastructure and functionality (DBs, embedding API, jobs); use --fix to apply defaults
    config               Show current configuration and feature toggles (use config-set to change)

  Maintenance (run regularly or use run-all)
    run-all              Run all maintenance tasks in optimal order (see below)
    tier-compact         Tier compaction: move facts between hot/warm/cold/structural
    vectordb-optimize    Compact LanceDB fragments and prune old versions (reclaims disk space)
    prune                Remove expired (decayed) facts
    checkpoint           Checkpoint vector DB to disk
    re-index             Reset LanceDB and re-embed all facts (after changing embedding model)
    backfill-decay       Backfill decay fields (one-time migration)
    backfill             Seed memory from workspace Markdown/text files

  Stats & query
    stats                Show memory statistics (--efficiency adds token estimate in rich output)
    test                 Run memory diagnostics (structured/semantic/hybrid/auto-recall)
    context-audit        Report token usage per injected context source
    search <query>       Hybrid search (vector + SQL)
    lookup <id>          Get fact by ID
    list                 List recent facts (--limit, --category, --tier, etc.)
    show <id>            Show fact or proposal by ID
    dump                 Print rows from a SQLite table (--type, --limit, --order, --json)
    categories           List categories present in memory

  Proposals & corrections
    proposals list       List persona proposals (--status)
    proposals show <id>  Show full proposal (--json, --diff)
    proposals approve/reject <id>
    corrections list     List pending corrections from last report
    corrections approve-all   Apply all TOOLS/AGENTS rules from report
    review               Show proposals and corrections with actions

  Store & ingestion
    store <text>         Store a fact (options: --category, --entity, --key, --value)
    ingest-files         Ingest workspace files (--paths for specific files)
    distill              Extract facts from session logs (--days, --model)
    distill-window       Show date range available for distill
    record-distill       Record last distill run for cron
    extract-daily        Extract daily summaries from sessions
    extract-procedures   Extract procedures from sessions (--days)
    extract-directives   Extract directive rules from sessions
    extract-reinforcement  Extract reinforcement from praise
    generate-auto-skills   Generate skills from procedures
    skills telemetry [name]  Report generated skill activation telemetry
    skills demote <name>   Demote an over-triggering generated skill
    generate-proposals    Generate persona proposals from reflection (--dry-run, --verbose)

  Reflection & classification
    reflect              Analyze recent facts, extract patterns
    reflect-rules        Extract rules from patterns
    reflect-meta         Extract meta-patterns
    classify             Reclassify facts with LLM
    build-languages      Build language keywords for self-correction
    enrich-entities      Backfill typed entity extraction for facts missing NER rows
    entity-mentions audit|cleanup   Audit/cleanup mention quality and duplicates

  Dedup & consolidation
    find-duplicates      Find near-duplicate facts (--threshold)
    consolidate          Merge duplicates via LLM (--dry-run first)

  Self-correction
    self-correction-extract  Extract incidents from sessions
    self-correction-run      Analyze and remediate (TOOLS.md, memory)

  Export & config
    export               Export to MEMORY.md / memory/ (--output)
    config               View configuration and feature toggles
    config-mode <mode>   Set memory mode
    config-set <key> <value>

  Credentials & scope
    credentials migrate-to-vault
    scope list|stats|prune|promote

  Sensor sweep (requires sensorSweep.enabled: true)
    sensor-sweep         Run sensor data collection (Garmin, GitHub, memory patterns, sessions)
    sensor-events        Query events written to the Event Bus

  Plugin lifecycle
    upgrade [version]    Upgrade to version or latest
    uninstall            Remove plugin (--clean-all, --leave-config)
    backup               Create a point-in-time snapshot (SQLite + LanceDB)
    backup verify        Check SQLite integrity without creating a backup
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
