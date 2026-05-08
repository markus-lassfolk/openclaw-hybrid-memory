# Release Notes — OpenClaw Hybrid Memory 2026.4.260

**Date:** 2026-04-26  
**Previous release:** [2026.4.141](release-notes-2026.4.141.md) (2026-04-14)

---

## At a glance

This release is for operators who want **clearer visibility into what memory did**, **safer defaults on sensitive surfaces**, **smarter retrieval when you already know the boundary**, and a **supported OpenClaw baseline** on the **2026.4** line. If you are on **2026.4.141** or newer, upgrading is mostly **drop-in**; read the **Security** and **OpenClaw** sections below so your gateway and config stay aligned.

---

## What’s new (in plain language)

### Session observability — “What did memory do for this chat?”

Hybrid Memory can now assemble a **session-oriented report**: captures, recalls, what was **injected into the prompt**, and operations that were **skipped or suppressed**. Think of it as a **single timeline** for debugging and trust, instead of piecing together SQLite rows and logs by hand. *(Issue #1025, PR #1148.)*

### Constrained recall — filter first, then rank, then hydrate

When you want retrieval to respect **hard boundaries** (tags, tiers, time windows, sources, and similar filters), you can use the **constrained-recall** path: **narrow the candidate set**, **rank inside that set**, then **hydrate** rich results. This is exposed as **`retrievalMode: "constrained-recall"`** (and related tool/schema updates). *(Issue #1026, PR #1141.)*

### Productisation docs — what ships vs what’s next

There is a dedicated **productisation tracker** and clearer **README / docs** links so you can see **which Hybrid Memory capabilities are production-ready** and which lanes are still planned, without reading the full epic thread. *(Epic #1029, PRs #1134, #1147, presentation PR #1139.)*

---

## Security (please read)

### Public memory API is stricter about scope

HTTP routes that expose memory data now apply **scope filtering** so responses match the **caller’s session and policy**. If you built integrations that assumed a wider view, re-test them; behavior should be **more correct**, not broader. *(PR #1137.)*

### Edicts require an explicit opt-in

The **`memory_add_edict`** path is **disabled unless you explicitly enable** it in configuration. This prevents accidental or malicious edict writes in environments that never intended to use edicts. If you rely on edicts, turn the feature on deliberately after reviewing the docs. *(PR #1136.)*

### Recall isolation for timeline-style flows

**Session isolation** for **timeline-style recall** was tightened so one session should not see another session’s episode stream. *(PR #1135.)*

---

## Dependencies and OpenClaw

- The extension’s lockfile moves **OpenClaw** forward on the **2026.4** line (notably **2026.4.24** in the dependency tree; see PRs **#1145** / **#1149**). Upstream OpenClaw includes many platform changes (browser tooling, voice/meet plugins, model catalog work, etc.); your **gateway** should generally run a **current 2026.4.x** build when you run this plugin version.
- Other routine bumps include **protobufjs** and **basic-ftp** (Dependabot PRs **#1146**, **#1144**).

The plugin still documents a **minimum** OpenClaw version in code; after upgrading, watch startup logs for any **version warning** and align the gateway if needed.

---

## Reliability and maintenance (developer / operator notes)

- **Typed hooks:** Agent ID resolution imports were corrected so lifecycle stages consistently use **`resolve-agent-id`** (fixes TypeScript / runtime mismatch after refactors).
- **Active tasks:** When a **subagent spawn** triggers a **skipped** ACTIVE-tasks write, audit context now records the **actual task label** instead of a bad reference.
- **Observability service:** Injection summaries handle **missing optional fields** safely; unit tests match current **`AuditStore`** types.
- **CI:** **Biome** formatting for **`memory-tools.ts`** so **`format:check`** passes.

---

## Upgrade steps

1. **Back up** your workspace memory dir and SQLite/Lance paths if you do not already snapshot them.
2. **Upgrade the plugin** (pick one pattern you already use):

   ```bash
   npm install -g openclaw-hybrid-memory@2026.4.260
   ```

   Or follow your usual **`openclaw plugins install`** / **`hybrid-mem upgrade`** flow for a workspace extension checkout.

3. **Upgrade or restart the OpenClaw gateway** to a **2026.4.x** build compatible with this plugin, then restart the gateway process.
4. Run **`openclaw hybrid-mem verify`** (add **`--fix`** if you want non-destructive cron/job normalization, same as prior releases).
5. If you use **edicts**, confirm your config **explicitly opts in** after reading the security note above.
6. Re-run any **integration tests** against the **public memory HTTP API** if you have custom clients.

---

## Breaking changes

None are intentionally introduced as semver-major API breaks in this tag. **Behavioral tightening** (API scope filtering, edict opt-in, recall isolation) may surface misconfigurations that previously “worked” by being too permissive—treat that as a **fix**, and adjust clients or config.

---

## Links

- **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.4.260]`** for the authoritative bullet list.
- **Previous release notes:** [2026.4.141](release-notes-2026.4.141.md)
